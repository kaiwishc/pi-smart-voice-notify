import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { SettingItem } from "@mariozechner/pi-tui";

import {
	BOOLEAN_VALUES,
	clampInt,
	CONFIG_PATH,
	DEBUG_LOG_PATH,
	DEFAULT_CONFIG,
	DESKTOP_NOTIFICATION_TIMEOUT_VALUES,
	EXTENSION_ID,
	IDLE_THRESHOLD_VALUES,
	INLINE_NOTIFY_TEXT,
	isNotificationEnabled,
	isWindows,
	MAX_FOLLOW_UP_VALUES,
	MESSAGE_LIBRARY,
	normalizeConfig,
	normalizeMode,
	NOTIFICATION_MODES,
	PERMISSION_HINTS,
	QUESTION_HINTS,
	RATE_VALUES,
	readConfigFromDisk,
	REMINDER_DELAY_VALUES,
	STATUS_KEY,
	summarizeConfig,
	writeConfigToDisk,
	boolValue,
	ensureDebugDirectory,
} from "./config-store.js";
import { sendDesktopNotification } from "./desktop-notify.js";
import { createExtensionLogger, getErrorMessage } from "./logging.js";
import { AudioNotificationService } from "./notify-audio.js";
import type {
	NotificationType,
	NotifyLevel,
	ReminderState,
	VoiceNotifyConfig,
} from "./types.js";
import { ZellijModal, ZellijSettingsModal } from "./zellij-modal.js";

function pickRandom<T>(items: readonly T[]): T {
	const index = Math.floor(Math.random() * items.length);
	return items[index] ?? items[0];
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const record = item as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			parts.push(record.text);
		}
	}
	return parts.join("\n");
}

function classifyToolResult(
	toolName: string,
	isError: boolean,
	textContent: string,
): NotificationType | null {
	const normalizedTool = toolName.toLowerCase();
	const normalizedText = textContent.toLowerCase().slice(0, 800);

	if (!isError) {
		if (normalizedTool.includes("question")) {
			return "question";
		}
		if (QUESTION_HINTS.some((hint) => normalizedText.includes(hint))) {
			return "question";
		}
		return null;
	}

	if (normalizedTool.includes("question")) {
		return "question";
	}

	if (normalizedTool.includes("permission") || PERMISSION_HINTS.some((hint) => normalizedText.includes(hint))) {
		return "permission";
	}

	return "error";
}

function toRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function readBlockedReason(value: unknown): string | null {
	const record = toRecord(value);
	const blockValue = record.block;
	const isBlocked = blockValue === true || blockValue === "true";
	if (!isBlocked) {
		return null;
	}

	const reason = record.reason;
	if (typeof reason !== "string") {
		return null;
	}

	const normalizedReason = reason.trim();
	return normalizedReason.length > 0 ? normalizedReason : null;
}

function extractToolCallBlockReason(event: unknown): string | null {
	const directReason = readBlockedReason(event);
	if (directReason) {
		return directReason;
	}

	const record = toRecord(event);
	return readBlockedReason(record.result);
}

function isPermissionReason(reason: string): boolean {
	const normalizedReason = reason.toLowerCase();
	return PERMISSION_HINTS.some((hint) => normalizedReason.includes(hint));
}

function statusLine(config: VoiceNotifyConfig): string | undefined {
	if (!config.enabled) {
		return "voice:off";
	}

	const bits = [
		`voice:${config.notificationMode}`,
		config.enableSound ? "snd" : "no-snd",
		config.enableTts ? "tts" : "no-tts",
		config.enableDesktopNotification ? "toast" : "no-toast",
	];
	return bits.join(" ");
}

function queueTask(task: Promise<void>, onError: (error: unknown) => void): void {
	void task.catch(onError);
}

export default function smartVoiceNotifyExtension(pi: ExtensionAPI): void {
	let config = readConfigFromDisk();
	let lastUserActivityAt = Date.now();
	let hadErrorInTurn = false;
	let warnedNonWindows = false;
	let warnedDesktopUnsupported = false;
	let audioQueue: Promise<void> = Promise.resolve();
	let questionToolAvailable = false;

	const pendingReminders = new Map<NotificationType, ReminderState>();
	const processedToolCallIds = new Set<string>();
	const lastNotificationAt = new Map<NotificationType, number>();

	const logger = createExtensionLogger({
		extensionId: EXTENSION_ID,
		debugLogPath: DEBUG_LOG_PATH,
		isDebugEnabled: () => config.debugLog,
		ensureDebugDirectory,
	});

	const audioService = new AudioNotificationService({
		execRunner: pi,
		getConfig: () => config,
		debug: logger.debug,
	});

	const rememberProcessedToolCallId = (toolCallId: string): boolean => {
		if (processedToolCallIds.has(toolCallId)) {
			return false;
		}
		processedToolCallIds.add(toolCallId);
		if (processedToolCallIds.size > 500) {
			processedToolCallIds.clear();
			processedToolCallIds.add(toolCallId);
		}
		return true;
	};

	const logError = (error: unknown): void => {
		logger.error(error);
	};

	const refreshQuestionToolAvailability = (): void => {
		try {
			questionToolAvailable = pi.getAllTools().some((tool) => tool.name.toLowerCase() === "question");
		} catch {
			questionToolAvailable = false;
		}
	};

	const notifyUser = (ctx: ExtensionContext, message: string, level: NotifyLevel): void => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.notify(message, level);
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, statusLine(config));
	};

	const persistConfig = (ctx?: ExtensionContext): void => {
		try {
			writeConfigToDisk(config);
			logger.debug("config.persisted", {
				configPath: CONFIG_PATH,
				debugLogPath: DEBUG_LOG_PATH,
				enabled: config.enabled,
				notificationMode: config.notificationMode,
			});
		} catch (error) {
			if (ctx) {
				notifyUser(ctx, `Failed to save ${EXTENSION_ID} config: ${getErrorMessage(error)}`, "warning");
			}
			logError(error);
		}
	};

	const enqueueAudio = (job: () => Promise<void>): void => {
		audioQueue = audioQueue.then(job).catch(logError);
	};

	const cancelReminder = (type: NotificationType): void => {
		const reminder = pendingReminders.get(type);
		if (!reminder) {
			return;
		}
		clearTimeout(reminder.timeoutId);
		pendingReminders.delete(type);
		logger.debug("reminder.cancelled", { type, followUpCount: reminder.followUpCount });
	};

	const cancelAllReminders = (): void => {
		const count = pendingReminders.size;
		for (const reminder of pendingReminders.values()) {
			clearTimeout(reminder.timeoutId);
		}
		pendingReminders.clear();
		if (count > 0) {
			logger.debug("reminder.cancelled_all", { count });
		}
	};

	const scheduleReminder = (
		type: NotificationType,
		delaySeconds: number,
		followUpCount: number,
	): void => {
		if (!config.enabled || !config.reminderEnabled || !config.enableTts || config.notificationMode === "sound-only") {
			return;
		}

		cancelReminder(type);
		const scheduledAt = Date.now();
		const delayMs = Math.max(1, delaySeconds) * 1000;

		const timeoutId = setTimeout(() => {
			queueTask(
				(async () => {
					const current = pendingReminders.get(type);
					if (!current || current.scheduledAt !== scheduledAt) {
						return;
					}

					if (lastUserActivityAt > scheduledAt) {
						pendingReminders.delete(type);
						logger.debug("reminder.skipped_user_active", { type, followUpCount });
						return;
					}

					const reminderMessage = pickRandom(MESSAGE_LIBRARY[type].reminder);
					logger.debug("reminder.fired", { type, followUpCount, delaySeconds });
					enqueueAudio(async () => {
						await audioService.wakeMonitor();
						await audioService.speakWithSapi(reminderMessage);
					});

					pendingReminders.delete(type);
					const shouldScheduleFollowUp =
						config.followUpEnabled && followUpCount + 1 < config.maxFollowUps && lastUserActivityAt <= Date.now();
					if (!shouldScheduleFollowUp) {
						return;
					}

					const nextDelay = Math.round(Math.max(5, delaySeconds * config.followUpBackoffMultiplier));
					logger.debug("reminder.follow_up_scheduled", {
						type,
						followUpCount: followUpCount + 1,
						delaySeconds: nextDelay,
					});
					scheduleReminder(type, nextDelay, followUpCount + 1);
				})(),
				logError,
			);
		}, delayMs);

		pendingReminders.set(type, { timeoutId, scheduledAt, followUpCount, delaySeconds });
		logger.debug("reminder.scheduled", { type, followUpCount, delaySeconds });
	};

	const shouldThrottle = (type: NotificationType): boolean => {
		const now = Date.now();
		const last = lastNotificationAt.get(type) ?? 0;
		if (now - last < config.minNotificationIntervalMs) {
			return true;
		}
		lastNotificationAt.set(type, now);
		return false;
	};

	const dispatchAudio = (type: NotificationType, text: string): void => {
		const mode = config.notificationMode;
		const shouldPlaySoundNow = config.enableSound && (mode === "sound-first" || mode === "both" || mode === "sound-only");
		const shouldSpeakNow = config.enableTts && (mode === "tts-first" || mode === "both");
		const shouldDispatchAudio = shouldPlaySoundNow || shouldSpeakNow;

		if (shouldDispatchAudio) {
			enqueueAudio(async () => {
				await audioService.wakeMonitor();
			});
		}

		if (shouldPlaySoundNow) {
			logger.debug("audio.sound.dispatch", { type, mode });
			enqueueAudio(async () => {
				try {
					await audioService.playWindowsSound(type);
				} catch (error) {
					if (mode === "sound-first" && config.enableTts) {
						logger.debug("audio.sound.failed_tts_fallback", { type, mode, error });
						await audioService.speakWithSapi(text);
						return;
					}
					throw error;
				}
			});
		}

		if (shouldSpeakNow) {
			logger.debug("audio.tts.dispatch", { type, mode });
			enqueueAudio(async () => {
				try {
					await audioService.speakWithSapi(text);
				} catch (error) {
					if (!shouldPlaySoundNow && config.enableSound) {
						logger.debug("audio.tts.failed_sound_fallback", { type, mode, error });
						await audioService.playWindowsSound(type);
					}
					throw error;
				}
			});
		}
	};

	const dispatchDesktop = (type: NotificationType, message: string, ctx: ExtensionContext): void => {
		if (!config.enableDesktopNotification) {
			return;
		}

		queueTask(
			(async () => {
				const result = await sendDesktopNotification({
					type,
					message,
					timeoutSeconds: config.desktopNotificationTimeout,
					debugLog: config.debugLog,
				});
				if (result.success) {
					logger.debug("desktop.notify.sent", {
						type,
						platform: result.platform,
						timeoutSeconds: config.desktopNotificationTimeout,
					});
					return;
				}

				logger.debug("desktop.notify.failed", {
					type,
					platform: result.platform,
					unsupported: Boolean(result.unsupported),
					error: result.error,
				});
				if (result.unsupported && !warnedDesktopUnsupported) {
					warnedDesktopUnsupported = true;
					notifyUser(ctx, result.error ?? "Desktop notifications are not supported on this platform.", "warning");
				}
			})(),
			logError,
		);
	};

	const triggerNotification = (
		type: NotificationType,
		ctx: ExtensionContext,
		options: { bypassThrottle?: boolean; customMessage?: string } = {},
	): void => {
		if (!config.enabled || !isNotificationEnabled(config, type)) {
			return;
		}
		if (!options.bypassThrottle && shouldThrottle(type)) {
			return;
		}

		if (!isWindows() && config.windowsOptimized && !warnedNonWindows) {
			warnedNonWindows = true;
			notifyUser(ctx, "smart-voice-notify is tuned for Windows. Using best-effort fallback on this platform.", "warning");
		}

		const spokenMessage = options.customMessage ?? pickRandom(MESSAGE_LIBRARY[type].initial);
		logger.debug("notification.triggered", {
			type,
			bypassThrottle: Boolean(options.bypassThrottle),
			notificationMode: config.notificationMode,
			text: INLINE_NOTIFY_TEXT[type],
		});
		logger.debug("notification.channels", {
			type,
			hasUI: ctx.hasUI,
			wakeMonitor: config.wakeMonitor,
			idleThresholdSeconds: config.idleThresholdSeconds,
			enableSound: config.enableSound,
			enableTts: config.enableTts,
			enableDesktopNotification: config.enableDesktopNotification,
			desktopNotificationTimeout: config.desktopNotificationTimeout,
		});
		dispatchAudio(type, spokenMessage);
		dispatchDesktop(type, options.customMessage ?? INLINE_NOTIFY_TEXT[type], ctx);
		scheduleReminder(type, config.reminderDelaySeconds, 0);
	};

	const applySetting = (draft: VoiceNotifyConfig, id: string, value: string): void => {
		switch (id) {
			case "enabled":
				draft.enabled = boolValue(value);
				return;
			case "debug":
				draft.debugLog = boolValue(value);
				return;
			case "mode":
				draft.notificationMode = normalizeMode(value);
				return;
			case "sound":
				draft.enableSound = boolValue(value);
				return;
			case "tts":
				draft.enableTts = boolValue(value);
				return;
			case "desktopNotify":
				draft.enableDesktopNotification = boolValue(value);
				return;
			case "desktopNotifyTimeout":
				draft.desktopNotificationTimeout = clampInt(Number(value), draft.desktopNotificationTimeout, 1, 60);
				return;
			case "wakeMonitor":
				draft.wakeMonitor = boolValue(value);
				return;
			case "idleThresholdSeconds":
				draft.idleThresholdSeconds = clampInt(Number(value), draft.idleThresholdSeconds, 5, 600);
				return;
			case "reminder":
				draft.reminderEnabled = boolValue(value);
				return;
			case "delay":
				draft.reminderDelaySeconds = clampInt(Number(value), draft.reminderDelaySeconds, 5, 300);
				return;
			case "followUp":
				draft.followUpEnabled = boolValue(value);
				return;
			case "maxFollowUps":
				draft.maxFollowUps = clampInt(Number(value), draft.maxFollowUps, 1, 10);
				return;
			case "idle":
				draft.enableIdleNotification = boolValue(value);
				return;
			case "permission":
				draft.enablePermissionNotification = boolValue(value);
				return;
			case "question":
				draft.enableQuestionNotification = boolValue(value);
				return;
			case "error":
				draft.enableErrorNotification = boolValue(value);
				return;
			case "suppressIdleAfterError":
				draft.suppressIdleAfterError = boolValue(value);
				return;
			case "ttsVoice":
				draft.ttsVoice = value;
				return;
			case "ttsRate":
				draft.ttsRate = clampInt(Number(value), draft.ttsRate, -10, 10);
				return;
			default:
				return;
		}
	};

	const buildSettings = (draft: VoiceNotifyConfig, voices: string[]): SettingItem[] => {
		const voiceValues = Array.from(new Set([...voices, draft.ttsVoice]));
		const items: SettingItem[] = [
			{ id: "enabled", label: "Extension Enabled", currentValue: draft.enabled ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{ id: "debug", label: "Debug Log to File", currentValue: draft.debugLog ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{
				id: "mode",
				label: "Notification Mode",
				currentValue: draft.notificationMode,
				values: [...NOTIFICATION_MODES],
			},
			{ id: "sound", label: "Play Sound", currentValue: draft.enableSound ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{ id: "tts", label: "Speak TTS", currentValue: draft.enableTts ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{
				id: "desktopNotify",
				label: "Desktop Toast Notification",
				currentValue: draft.enableDesktopNotification ? "on" : "off",
				values: [...BOOLEAN_VALUES],
			},
			{
				id: "desktopNotifyTimeout",
				label: "Desktop Toast Timeout (seconds)",
				currentValue: String(draft.desktopNotificationTimeout),
				values: [...DESKTOP_NOTIFICATION_TIMEOUT_VALUES],
			},
			{ id: "wakeMonitor", label: "Wake Monitor", currentValue: draft.wakeMonitor ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{
				id: "idleThresholdSeconds",
				label: "Wake Idle Threshold (seconds)",
				currentValue: String(draft.idleThresholdSeconds),
				values: [...IDLE_THRESHOLD_VALUES],
			},
			{ id: "reminder", label: "Reminder Enabled", currentValue: draft.reminderEnabled ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{ id: "delay", label: "Reminder Delay (seconds)", currentValue: String(draft.reminderDelaySeconds), values: [...REMINDER_DELAY_VALUES] },
			{ id: "followUp", label: "Follow-up Reminders", currentValue: draft.followUpEnabled ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{ id: "maxFollowUps", label: "Max Follow-ups", currentValue: String(draft.maxFollowUps), values: [...MAX_FOLLOW_UP_VALUES] },
			{ id: "idle", label: "Notify On Idle", currentValue: draft.enableIdleNotification ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{
				id: "permission",
				label: "Notify On Permission Block",
				currentValue: draft.enablePermissionNotification ? "on" : "off",
				values: [...BOOLEAN_VALUES],
			},
			{ id: "error", label: "Notify On Errors", currentValue: draft.enableErrorNotification ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{
				id: "suppressIdleAfterError",
				label: "Skip Idle Notify After Errors",
				currentValue: draft.suppressIdleAfterError ? "on" : "off",
				values: [...BOOLEAN_VALUES],
			},
			{ id: "ttsVoice", label: "SAPI Voice", currentValue: draft.ttsVoice, values: voiceValues },
			{ id: "ttsRate", label: "SAPI Rate", currentValue: String(draft.ttsRate), values: [...RATE_VALUES] },
		];

		if (questionToolAvailable) {
			const errorIndex = items.findIndex((item) => item.id === "error");
			const insertAt = errorIndex >= 0 ? errorIndex : items.length;
			items.splice(insertAt, 0, {
				id: "question",
				label: "Notify On Questions",
				currentValue: draft.enableQuestionNotification ? "on" : "off",
				values: [...BOOLEAN_VALUES],
			});
		}

		return items;
	};

	const openConfigModal = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) {
			pi.sendMessage({
				customType: EXTENSION_ID,
				content: `Configuration UI requires interactive mode.\n\n${summarizeConfig(config)}`,
				display: true,
			});
			return;
		}

		let voices: string[] = [config.ttsVoice];
		try {
			voices = await audioService.getInstalledVoices();
		} catch (error) {
			notifyUser(ctx, `Could not load Windows voices: ${getErrorMessage(error)}`, "warning");
		}

		const draft: VoiceNotifyConfig = { ...config };
		const items = buildSettings(draft, voices);
		const overlayOptions = { anchor: "center" as const, width: 92, maxHeight: "85%" as const, margin: 1 };
		const description = !questionToolAvailable
			? "Question notifications are hidden (no custom 'question' tool loaded)."
			: "Configure Windows voice and reminder notification behavior.";

		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const settingsModal = new ZellijSettingsModal(
					{
						title: "Voice Notify Settings",
						description,
						settings: items,
						onChange: (id, newValue) => {
							const previousConfig = config;
							applySetting(draft, id, newValue);
							config = normalizeConfig(draft);
							if (config.debugLog && !previousConfig.debugLog) {
								logger.debug("debug.enabled", { debugLogPath: DEBUG_LOG_PATH });
							}
							logger.debug("config.setting_updated", { id, newValue });
							if (!config.enabled || !config.reminderEnabled) {
								cancelAllReminders();
							}
							persistConfig(ctx);
							updateStatus(ctx);
						},
						onClose: () => done(),
						helpText: `Config: ${CONFIG_PATH} • Debug: ${DEBUG_LOG_PATH}`,
						enableSearch: true,
					},
					theme,
				);

				const modal = new ZellijModal(
					settingsModal,
					{
						borderStyle: "rounded",
						titleBar: {
							left: "Voice Notify Settings",
							right: EXTENSION_ID,
						},
						helpUndertitle: {
							text: "Esc: close | ↑↓: navigate | Space: toggle",
							color: "dim",
						},
						overlay: overlayOptions,
					},
					theme,
				);

				return {
					render(width: number): string[] {
						return modal.renderModal(width).lines;
					},
					invalidate(): void {
						modal.invalidate();
					},
					handleInput(data: string): void {
						modal.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions },
		);
	};

	const runCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const trimmed = args.trim();
		logger.debug("command.invoked", { args: trimmed || "(open-config-modal)" });
		if (!trimmed) {
			await openConfigModal(ctx);
			return;
		}

		const [subcommandRaw, typeRaw] = trimmed.split(/\s+/, 2);
		const subcommand = subcommandRaw.toLowerCase();

		if (subcommand === "status") {
			const summary = `${summarizeConfig(config)}\nquestionToolAvailable=${questionToolAvailable}`;
			if (ctx.hasUI) {
				notifyUser(ctx, summary, "info");
			} else {
				pi.sendMessage({ customType: EXTENSION_ID, content: summary, display: true });
			}
			return;
		}

		if (subcommand === "reload") {
			config = readConfigFromDisk();
			refreshQuestionToolAvailability();
			cancelAllReminders();
			updateStatus(ctx);
			notifyUser(ctx, "Reloaded smart voice notify config from disk.", "info");
			return;
		}

		if (subcommand === "on" || subcommand === "off") {
			config.enabled = subcommand === "on";
			persistConfig(ctx);
			if (!config.enabled) {
				cancelAllReminders();
			}
			updateStatus(ctx);
			notifyUser(ctx, `smart-voice-notify ${config.enabled ? "enabled" : "disabled"}.`, "info");
			return;
		}

		if (subcommand === "test") {
			const type = (typeRaw || "idle").toLowerCase() as NotificationType;
			if (type !== "idle" && type !== "permission" && type !== "question" && type !== "error") {
				notifyUser(ctx, "Usage: /voice-notify test [idle|permission|question|error]", "warning");
				return;
			}
			if (type === "question" && !questionToolAvailable) {
				notifyUser(ctx, "Question notifications are unavailable because no custom 'question' tool is loaded.", "warning");
				return;
			}
			triggerNotification(type, ctx, {
				bypassThrottle: true,
				customMessage: `Test ${type} notification from /voice-notify test.`,
			});
			return;
		}

		notifyUser(ctx, "Usage: /voice-notify [status|reload|on|off|test <type>]", "warning");
	};

	pi.registerCommand("voice-notify", {
		description: "Configure Windows smart voice notifications",
		handler: async (args, ctx) => {
			await runCommand(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = readConfigFromDisk();
		refreshQuestionToolAvailability();
		lastUserActivityAt = Date.now();
		hadErrorInTurn = false;
		warnedNonWindows = false;
		warnedDesktopUnsupported = false;
		processedToolCallIds.clear();
		lastNotificationAt.clear();
		cancelAllReminders();
		updateStatus(ctx);
		logger.debug("session.start", {
			configPath: CONFIG_PATH,
			debugLogPath: DEBUG_LOG_PATH,
			notificationMode: config.notificationMode,
		});
	});

	pi.on("session_switch", async (_event, ctx) => {
		refreshQuestionToolAvailability();
		lastUserActivityAt = Date.now();
		hadErrorInTurn = false;
		warnedDesktopUnsupported = false;
		processedToolCallIds.clear();
		lastNotificationAt.clear();
		cancelAllReminders();
		updateStatus(ctx);
		logger.debug("session.switch", {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		logger.debug("session.shutdown", {});
		cancelAllReminders();
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			lastUserActivityAt = Date.now();
			cancelAllReminders();
		}
	});

	pi.on("agent_start", async () => {
		hadErrorInTurn = false;
		processedToolCallIds.clear();
		logger.debug("agent.start", {});
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!config.enabled || !config.enablePermissionNotification) {
			return {};
		}

		const reason = extractToolCallBlockReason(event);
		if (!reason || !isPermissionReason(reason)) {
			return {};
		}

		if (!rememberProcessedToolCallId(event.toolCallId)) {
			return {};
		}

		logger.debug("tool_call.permission_blocked", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			reason,
		});
		triggerNotification("permission", ctx);
		return {};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!config.enabled) {
			return;
		}

		if (!rememberProcessedToolCallId(event.toolCallId)) {
			return;
		}

		const toolName = typeof event.toolName === "string" ? event.toolName : "";
		const text = extractTextContent(event.content);
		const type = classifyToolResult(toolName, event.isError, text);
		if (!type) {
			return;
		}
		if (type === "question" && !questionToolAvailable) {
			return;
		}

		if (event.isError) {
			hadErrorInTurn = true;
		}

		logger.debug("tool_result.classified", {
			toolCallId: event.toolCallId,
			toolName,
			isError: event.isError,
			notificationType: type,
		});
		triggerNotification(type, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!config.enabled || !config.enableIdleNotification) {
			logger.debug("agent.end.idle_skipped", {
				reason: "idle_notification_disabled",
				enabled: config.enabled,
				enableIdleNotification: config.enableIdleNotification,
			});
			return;
		}
		if (config.suppressIdleAfterError && hadErrorInTurn) {
			logger.debug("agent.end.idle_skipped", { reason: "suppressed_after_error" });
			return;
		}
		logger.debug("agent.end.idle_trigger", {});
		triggerNotification("idle", ctx);
	});
}
