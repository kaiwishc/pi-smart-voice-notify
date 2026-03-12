import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { SettingItem } from "@mariozechner/pi-tui";
import { basename } from "node:path";

import { initializeAIMessageService } from "./ai-messages.ts";
import {
	BOOLEAN_VALUES,
	clampInt,
	CONFIG_PATH,
	DEBUG_LOG_PATH,
	DEFAULT_CONFIG,
	EXTENSION_ID,
	INLINE_NOTIFY_TEXT,
	isNotificationEnabled,
	isWindows,
	MESSAGE_LIBRARY,
	normalizeConfig,
	PERMISSION_HINTS,
	QUESTION_HINTS,
	readConfigFromDisk,
	SOUND_LOOPS,
	STATUS_KEY,
	summarizeConfig,
	toRecord,
	TTS_ENGINE_VALUES,
	writeConfigToDisk,
	boolValue,
	ensureDebugDirectory,
} from "./config-store.ts";
import { sendDesktopNotification } from "./desktop-notify.ts";
import { clearFocusDetectCache, isTerminalFocused } from "./focus-detect.ts";
import { detectLinuxSession, getIdleTime, wakeMonitor as wakeLinuxMonitor } from "./linux.ts";
import { createExtensionLogger, getErrorMessage } from "./logging.ts";
import { AudioNotificationService } from "./notify-audio.ts";
import { PermissionForwardingWatcher } from "./permission-forwarding-watcher.ts";
import { clearProjectSoundCache } from "./per-project-sound.ts";
import { ReminderPlaybackController } from "./reminder-playback.ts";
import { SoundThemeService, type SoundThemeConfig } from "./sound-theme.ts";
import { initializeTTSService } from "./tts.ts";
import type {
	NotificationType,
	NotifyLevel,
	ReminderState,
	VoiceNotifyConfig,
} from "./types.ts";
import type { TTSService } from "./types/tts.ts";
import { createWebhookService } from "./webhook.ts";
import { ZellijModal, ZellijSettingsModal } from "./zellij-modal.ts";

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

function envString(...keys: string[]): string {
	for (const key of keys) {
		const value = process.env[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return "";
}

function envBoolean(defaultValue: boolean, ...keys: string[]): boolean {
	const raw = envString(...keys).toLowerCase();
	if (!raw) {
		return defaultValue;
	}
	if (["1", "true", "yes", "on"].includes(raw)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(raw)) {
		return false;
	}
	return defaultValue;
}

function envInteger(defaultValue: number, ...keys: string[]): number {
	const raw = envString(...keys);
	if (!raw) {
		return defaultValue;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

function sanitizeAgentName(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.replace(/[^a-zA-Z0-9._ -]/g, "").trim().replace(/\s+/g, " ");
	if (normalized.length === 0) {
		return null;
	}
	return normalized.slice(0, 48);
}

function forwardedPermissionNotificationText(agentName: string | null, includeAgentName: boolean): string {
	const baseMessage = "A subagent permission request is waiting for your approval.";
	if (!includeAgentName) {
		return baseMessage;
	}

	const sanitized = sanitizeAgentName(agentName);
	if (!sanitized) {
		return baseMessage;
	}
	return `${baseMessage} Agent: ${sanitized}.`;
}

const REMINDER_EVENT_TYPE: Record<NotificationType, string> = {
	idle: "idleReminder",
	permission: "permissionReminder",
	question: "questionReminder",
	error: "errorReminder",
};

type ReminderKey = string;
type PermissionForwardingWatcherController = Pick<PermissionForwardingWatcher, "start" | "updateConfig" | "stop">;

export interface SmartVoiceNotifyDependencies {
	readConfigFromDisk?: typeof readConfigFromDisk;
	initializeTTSService?: (options?: Parameters<typeof initializeTTSService>[0]) => TTSService;
	createPermissionForwardingWatcher?: (
		options: ConstructorParameters<typeof PermissionForwardingWatcher>[0],
	) => PermissionForwardingWatcherController;
}

function defaultReminderKey(type: NotificationType): ReminderKey {
	return `${type}:default`;
}

function permissionReminderKey(toolCallId: string): ReminderKey {
	const normalizedToolCallId = toolCallId.trim();
	return normalizedToolCallId.length > 0
		? `permission:tool-call:${normalizedToolCallId}`
		: defaultReminderKey("permission");
}

function forwardedPermissionReminderKey(requestId: string): ReminderKey {
	const normalizedRequestId = requestId.trim();
	return normalizedRequestId.length > 0
		? `permission:forwarded:${normalizedRequestId}`
		: defaultReminderKey("permission");
}

const PERMISSION_SYSTEM_EVENT_CHANNEL = "pi-permission-system:permission-request";
type PermissionSystemEventState = "waiting" | "approved" | "denied";
type PermissionSystemEventSource = "tool_call" | "skill_input" | "skill_read";

interface PermissionSystemEvent {
	requestId: string;
	state: PermissionSystemEventState;
	source: PermissionSystemEventSource;
	message: string;
	toolCallId?: string;
	toolName?: string;
	skillName?: string;
	path?: string;
	agentName?: string | null;
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readPermissionSystemEvent(value: unknown): PermissionSystemEvent | null {
	const record = toRecord(value);
	const requestId = normalizeOptionalString(record.requestId);
	const state = normalizeOptionalString(record.state);
	const source = normalizeOptionalString(record.source);
	const message = normalizeOptionalString(record.message);
	if (!requestId || !message) {
		return null;
	}
	if (state !== "waiting" && state !== "approved" && state !== "denied") {
		return null;
	}
	if (source !== "tool_call" && source !== "skill_input" && source !== "skill_read") {
		return null;
	}

	return {
		requestId,
		state,
		source,
		message,
		toolCallId: normalizeOptionalString(record.toolCallId),
		toolName: normalizeOptionalString(record.toolName),
		skillName: normalizeOptionalString(record.skillName),
		path: normalizeOptionalString(record.path),
		agentName: typeof record.agentName === "string" ? record.agentName : null,
	};
}

function permissionSystemReminderKey(event: PermissionSystemEvent): ReminderKey {
	if (event.toolCallId) {
		return permissionReminderKey(event.toolCallId);
	}

	return `permission:request:${event.requestId}`;
}

export default function smartVoiceNotifyExtension(
	pi: ExtensionAPI,
	dependencies: SmartVoiceNotifyDependencies = {},
): void {
	const readConfig = dependencies.readConfigFromDisk ?? readConfigFromDisk;
	const createTTSService = dependencies.initializeTTSService ?? initializeTTSService;
	const createPermissionForwardingWatcher =
		dependencies.createPermissionForwardingWatcher ??
		((options: ConstructorParameters<typeof PermissionForwardingWatcher>[0]): PermissionForwardingWatcherController => {
			return new PermissionForwardingWatcher(options);
		});
	let config = readConfig();
	let lastUserActivityAt = Date.now();
	let hadErrorInTurn = false;
	let warnedNonWindows = false;
	let warnedDesktopUnsupported = false;
	let audioQueue: Promise<void> = Promise.resolve();
	let questionToolAvailable = false;
	let activeSessionContext: ExtensionContext | null = null;

	const pendingReminders = new Map<ReminderKey, ReminderState>();
	const reminderPlayback = new ReminderPlaybackController();
	const pendingPermissionToolCallIds = new Set<string>();
	const blockedPermissionToolCallIds = new Set<string>();
	const processedToolResultToolCallIds = new Set<string>();
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
	const projectName = basename(process.cwd()) || "project";
	const focusDetectionEnabled = envBoolean(process.platform === "linux", "PI_SMART_NOTIFY_FOCUS_DETECTION");
	const notifyWhenFocused = envBoolean(false, "PI_SMART_NOTIFY_NOTIFY_WHEN_FOCUSED");
	const focusCacheTtlMs = Math.max(100, envInteger(400, "PI_SMART_NOTIFY_FOCUS_CACHE_TTL_MS"));
	const focusTimeoutMs = Math.max(500, envInteger(1_500, "PI_SMART_NOTIFY_FOCUS_TIMEOUT_MS"));
	const enablePerProjectSounds = envBoolean(true, "PI_SMART_NOTIFY_ENABLE_PER_PROJECT_SOUNDS");
	const soundThemeName = envString("PI_SMART_NOTIFY_SOUND_THEME", "PI_SMART_NOTIFY_THEME_NAME");
	const soundThemeDirectory = envString("PI_SMART_NOTIFY_SOUND_THEME_DIR", "PI_SMART_NOTIFY_THEME_DIR");
	const themesRootDirectory = envString("PI_SMART_NOTIFY_THEMES_ROOT");
	const themeConfigPath = envString("PI_SMART_NOTIFY_THEME_CONFIG_PATH");
	const customSoundDirectories = envString("PI_SMART_NOTIFY_CUSTOM_SOUND_DIRS")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	const soundThemeService = new SoundThemeService({
		debugLog: (message) => {
			logger.debug("sound_theme.debug", { message });
		},
	});
	let ttsService = createTTSService({
		execRunner: pi,
		config: {
			ttsEngine: config.ttsEngine,
			enableTts: true,
			sapiVoice: config.ttsVoice,
			sapiRate: config.ttsRate,
		},
		debug: logger.debug,
	});
	const aiMessageService = initializeAIMessageService({
		config: {
			enableAIMessages: envBoolean(false, "PI_SMART_NOTIFY_AI_ENABLED"),
			aiEndpoint: envString("PI_SMART_NOTIFY_AI_ENDPOINT", "OPENAI_BASE_URL") || "http://localhost:11434/v1",
			aiModel: envString("PI_SMART_NOTIFY_AI_MODEL") || "llama3",
			aiApiKey: envString("PI_SMART_NOTIFY_AI_API_KEY", "OPENAI_API_KEY"),
		},
		debugLog: (message, details = {}) => {
			logger.debug(`ai_messages.${message}`, details);
		},
	});
	const webhookService = createWebhookService({
		enabled: envBoolean(false, "PI_SMART_NOTIFY_WEBHOOK_ENABLED", "WEBHOOK_ENABLED"),
		eventTriggers: {
			idle: config.enableIdleNotification,
			permission: config.enablePermissionNotification,
			question: config.enableQuestionNotification,
			error: config.enableErrorNotification,
		},
		logger: (message, details = {}) => {
			logger.debug(`webhook.${message}`, details);
		},
	});
	const linuxSession = detectLinuxSession();
	logger.debug("linux.session.detected", {
		sessionType: linuxSession.sessionType,
		display: linuxSession.display,
		waylandDisplay: linuxSession.waylandDisplay,
	});

	const permissionForwardingWatcher = createPermissionForwardingWatcher({
		onRequest: (event) => {
			if (!config.enabled || !config.enablePermissionNotification || !config.enableForwardedPermissionWatcher) {
				return;
			}
			if (!activeSessionContext) {
				logger.debug("permission_forwarding.notification_skipped", {
					reason: "missing_session_context",
					requestId: event.requestId,
					source: event.source,
				});
				return;
			}

			const customMessage = forwardedPermissionNotificationText(
				event.requesterAgentName,
				config.includeForwardedPermissionAgentName,
			);
			logger.debug("permission_forwarding.request_detected", {
				requestId: event.requestId,
				source: event.source,
				requesterAgentName: sanitizeAgentName(event.requesterAgentName),
				filePath: event.filePath,
			});
			triggerNotification("permission", activeSessionContext, {
				reason: `forwarded_permission:${event.requestId}`,
				customMessage,
				reminderKey: forwardedPermissionReminderKey(event.requestId),
			});
		},
		onResolve: (event) => {
			logger.debug("permission_forwarding.request_resolved", {
				requestId: event.requestId,
				source: event.source,
				requesterAgentName: sanitizeAgentName(event.requesterAgentName),
				filePath: event.filePath,
				reason: event.reason,
			});
			cancelReminderActivityForKey(
				forwardedPermissionReminderKey(event.requestId),
				"forwarded_permission_resolved",
				{
					requestId: event.requestId,
					source: event.source,
					resolutionReason: event.reason,
				},
			);
		},
		debugLog: (event, details = {}) => {
			logger.debug(event, details);
		},
	});

	const syncPermissionForwardingWatcher = (): void => {
		if (!activeSessionContext) {
			permissionForwardingWatcher.stop();
			return;
		}
		permissionForwardingWatcher.start({
			enabled: config.enabled && config.enablePermissionNotification && config.enableForwardedPermissionWatcher,
			watchLegacyPath: config.watchLegacyForwardedPermissionPath,
		});
	};

	const buildSoundThemeConfig = (): SoundThemeConfig => {
		return {
			themeName: soundThemeName || undefined,
			themeDirectory: soundThemeDirectory || undefined,
			themesRootDirectory: themesRootDirectory || undefined,
			themeConfigPath: themeConfigPath || undefined,
			projectCwd: process.cwd(),
			enablePerProjectSounds,
			customSoundDirectories: customSoundDirectories.length > 0 ? customSoundDirectories : undefined,
		};
	};

	const refreshIntegratedServiceConfig = (): void => {
		ttsService = createTTSService({
			execRunner: pi,
			config: {
				ttsEngine: config.ttsEngine,
				enableTts: true,
				sapiVoice: config.ttsVoice,
				sapiRate: config.ttsRate,
			},
			debug: logger.debug,
		});
		webhookService.updateConfig({
			eventTriggers: {
				idle: config.enableIdleNotification,
				permission: config.enablePermissionNotification,
				question: config.enableQuestionNotification,
				error: config.enableErrorNotification,
			},
		});
	};

	const rememberScopedToolCallId = (toolCallId: string, seenToolCallIds: Set<string>): boolean => {
		if (seenToolCallIds.has(toolCallId)) {
			return false;
		}
		seenToolCallIds.add(toolCallId);
		if (seenToolCallIds.size > 500) {
			seenToolCallIds.clear();
			seenToolCallIds.add(toolCallId);
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

	const cancelReminder = (reminderKey: ReminderKey): boolean => {
		const reminder = pendingReminders.get(reminderKey);
		if (!reminder) {
			return false;
		}
		clearTimeout(reminder.timeoutId);
		pendingReminders.delete(reminderKey);
		logger.debug("reminder.cancelled", {
			reminderKey,
			type: reminder.type,
			followUpCount: reminder.followUpCount,
		});
		return true;
	};

	const cancelAllReminders = (): number => {
		const count = pendingReminders.size;
		for (const reminder of pendingReminders.values()) {
			clearTimeout(reminder.timeoutId);
		}
		pendingReminders.clear();
		if (count > 0) {
			logger.debug("reminder.cancelled_all", { count });
		}
		return count;
	};

	const cancelReminderActivity = (reason: string, details: Record<string, unknown> = {}): void => {
		const cancelledTimers = cancelAllReminders();
		const { cancelledActivePlayback, nextGeneration } = reminderPlayback.cancelAll();
		if (cancelledTimers > 0 || cancelledActivePlayback) {
			logger.debug("reminder.activity_cancelled", {
				reason,
				cancelledTimers,
				cancelledActivePlayback,
				playbackGeneration: nextGeneration,
				...details,
			});
		}
	};

	const cancelReminderActivityForKey = (
		reminderKey: ReminderKey,
		reason: string,
		details: Record<string, unknown> = {},
	): void => {
		const cancelledTimer = cancelReminder(reminderKey);
		const { cancelledActivePlayback, nextVersion } = reminderPlayback.cancel(reminderKey);
		if (cancelledTimer || cancelledActivePlayback) {
			logger.debug("reminder.activity_cancelled", {
				reason,
				reminderKey,
				cancelledTimers: cancelledTimer ? 1 : 0,
				cancelledActivePlayback,
				playbackVersion: nextVersion,
				...details,
			});
		}
	};

	const resolvePermissionInteraction = (
		toolCallId: string,
		stage: "tool_execution_start" | "tool_result",
		details: Record<string, unknown> = {},
	): void => {
		if (!pendingPermissionToolCallIds.delete(toolCallId)) {
			return;
		}
		cancelReminderActivityForKey(permissionReminderKey(toolCallId), "permission_interaction_resolved", {
			toolCallId,
			stage,
			...details,
		});
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

	const shouldSkipFocusedNotification = async (type: NotificationType): Promise<boolean> => {
		if (!focusDetectionEnabled || notifyWhenFocused || process.platform !== "linux") {
			return false;
		}

		try {
			const focused = await isTerminalFocused({
				debug: config.debugLog,
				cacheTtlMs: focusCacheTtlMs,
				timeoutMs: focusTimeoutMs,
				logger: (message, details = {}) => {
					logger.debug("focus.detect", {
						message,
						...details,
					});
				},
			});
			if (focused) {
				logger.debug("notification.skipped.focused", { type });
				return true;
			}
		} catch (error) {
			logger.debug("focus.detect.error", {
				type,
				error: getErrorMessage(error),
			});
		}

		return false;
	};

	const buildNotificationMessage = async (
		type: NotificationType,
		options: {
			customMessage?: string;
			isReminder?: boolean;
			followUpCount?: number;
			reason?: string;
		} = {},
	): Promise<string> => {
		if (options.customMessage?.trim()) {
			return options.customMessage.trim();
		}

		const eventType = options.isReminder ? REMINDER_EVENT_TYPE[type] : type;
		try {
			const generated = await aiMessageService.generateMessage(eventType, {
				projectName,
				time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
				count: options.followUpCount,
				reason: options.reason,
			});
			if (generated.trim().length > 0) {
				return generated;
			}
		} catch (error) {
			logger.debug("message.generate.error", {
				type,
				eventType,
				error: getErrorMessage(error),
			});
		}

		return pickRandom(MESSAGE_LIBRARY[type][options.isReminder ? "reminder" : "initial"]);
	};

	const wakeForNotification = async (): Promise<void> => {
		if (!config.wakeMonitor) {
			return;
		}

		if (process.platform === "linux") {
			const idleSeconds = await getIdleTime({
				debugLog: (message) => {
					logger.debug("linux.idle", { message });
				},
			});
			if (idleSeconds >= 0 && idleSeconds < config.idleThresholdSeconds) {
				logger.debug("wake.monitor.skipped", {
					reason: "below_threshold",
					idleSeconds,
					threshold: config.idleThresholdSeconds,
				});
				return;
			}
			await wakeLinuxMonitor({
				debugLog: (message) => {
					logger.debug("linux.wake", { message });
				},
			});
			return;
		}

		await audioService.wakeMonitor();
	};

	const playNotificationSound = async (type: NotificationType): Promise<boolean> => {
		if (!config.enableSound) {
			return false;
		}

		if (process.platform === "linux") {
			try {
				const played = await soundThemeService.playEventSound(type, buildSoundThemeConfig(), SOUND_LOOPS[type]);
				if (played) {
					return true;
				}
			} catch (error) {
				logger.debug("sound.play.theme_failed", {
					type,
					error: getErrorMessage(error),
				});
			}
		}

		try {
			await audioService.playWindowsSound(type);
			return isWindows();
		} catch (error) {
			logger.debug("sound.play.legacy_failed", {
				type,
				error: getErrorMessage(error),
			});
			return false;
		}
	};

	const speakNotification = async (message: string, signal?: AbortSignal): Promise<boolean> => {
		if (!config.enableTts || !message.trim() || signal?.aborted) {
			return false;
		}

		const spoken = await ttsService.speak(message, config.ttsEngine, {
			signal,
			sapiVoice: config.ttsVoice,
			sapiRate: config.ttsRate,
		});
		if (spoken || signal?.aborted) {
			return spoken;
		}

		if (isWindows()) {
			try {
				await audioService.speakWithSapi(message, signal);
				return !signal?.aborted;
			} catch (error) {
				logger.debug("tts.sapi_fallback_failed", {
					error: getErrorMessage(error),
				});
			}
		}

		return false;
	};

	const dispatchDesktop = async (type: NotificationType, message: string, ctx: ExtensionContext): Promise<void> => {
		if (!config.enableDesktopNotification) {
			return;
		}

		try {
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
		} catch (error) {
			logger.debug("desktop.notify.error", {
				type,
				error: getErrorMessage(error),
			});
		}
	};

	const dispatchWebhook = (type: NotificationType, message: string): void => {
		try {
			const dispatchResult = webhookService.dispatch({
				type,
				title: `Pi Notification - ${type}`,
				message,
				projectName,
			});
			logger.debug("webhook.dispatch", {
				type,
				queued: dispatchResult.queued,
				skipped: dispatchResult.skipped,
			});
		} catch (error) {
			logger.debug("webhook.dispatch.error", {
				type,
				error: getErrorMessage(error),
			});
		}
	};

	const scheduleReminder = (
		reminderKey: ReminderKey,
		type: NotificationType,
		delaySeconds: number,
		followUpCount: number,
	): void => {
		if (!config.enabled || !config.reminderEnabled || !config.enableTts || config.notificationMode === "sound-only") {
			return;
		}

		cancelReminder(reminderKey);
		const scheduledAt = Date.now();
		const reminderCheckpoint = reminderPlayback.captureCheckpoint(reminderKey);
		const delayMs = Math.max(1, delaySeconds) * 1000;

		const timeoutId = setTimeout(() => {
			queueTask(
				(async () => {
					const current = pendingReminders.get(reminderKey);
					if (!current || current.scheduledAt !== scheduledAt) {
						return;
					}

					if (!reminderPlayback.isCurrent(reminderCheckpoint, scheduledAt, lastUserActivityAt)) {
						pendingReminders.delete(reminderKey);
						logger.debug("reminder.skipped_user_active", {
							reminderKey,
							type,
							followUpCount,
							reminderVersion: reminderCheckpoint.version,
						});
						return;
					}

					const reminderMessage = await buildNotificationMessage(type, {
						isReminder: true,
						followUpCount: followUpCount + 1,
					});
					if (!reminderPlayback.isCurrent(reminderCheckpoint, scheduledAt, lastUserActivityAt)) {
						pendingReminders.delete(reminderKey);
						logger.debug("reminder.skipped_stale", {
							reminderKey,
							type,
							followUpCount,
							reminderVersion: reminderCheckpoint.version,
						});
						return;
					}

					logger.debug("reminder.fired", {
						reminderKey,
						type,
						followUpCount,
						delaySeconds,
						reminderVersion: reminderCheckpoint.version,
					});
					enqueueAudio(async () => {
						if (!reminderPlayback.isCurrent(reminderCheckpoint, scheduledAt, lastUserActivityAt)) {
							logger.debug("reminder.playback_skipped", {
								reminderKey,
								type,
								followUpCount,
								reason: "stale_before_start",
							});
							return;
						}

						const playbackHandle = reminderPlayback.start(reminderCheckpoint, type, followUpCount + 1);
						try {
							if (!reminderPlayback.isCurrent(playbackHandle, scheduledAt, lastUserActivityAt)) {
								logger.debug("reminder.playback_skipped", {
									reminderKey,
									type,
									followUpCount,
									reason: "stale_after_start",
								});
								return;
							}
							await wakeForNotification();
							if (!reminderPlayback.isCurrent(playbackHandle, scheduledAt, lastUserActivityAt)) {
								logger.debug("reminder.playback_cancelled", {
									reminderKey,
									type,
									followUpCount,
									reason: "stale_before_speak",
								});
								return;
							}
							await speakNotification(reminderMessage, playbackHandle.signal);
						} finally {
							reminderPlayback.finish(playbackHandle);
						}
					});

					pendingReminders.delete(reminderKey);
					const shouldScheduleFollowUp =
						config.followUpEnabled &&
						followUpCount + 1 < config.maxFollowUps &&
						reminderPlayback.isCurrent(reminderCheckpoint, scheduledAt, lastUserActivityAt);
					if (!shouldScheduleFollowUp) {
						return;
					}

					const nextDelay = Math.round(Math.max(5, delaySeconds * config.followUpBackoffMultiplier));
					logger.debug("reminder.follow_up_scheduled", {
						reminderKey,
						type,
						followUpCount: followUpCount + 1,
						delaySeconds: nextDelay,
					});
					scheduleReminder(reminderKey, type, nextDelay, followUpCount + 1);
				})(),
				logError,
			);
		}, delayMs);

		pendingReminders.set(reminderKey, {
			reminderKey,
			type,
			timeoutId,
			scheduledAt,
			followUpCount,
			delaySeconds,
		});
		logger.debug("reminder.scheduled", {
			reminderKey,
			type,
			followUpCount,
			delaySeconds,
			reminderVersion: reminderCheckpoint.version,
		});
	};

	const triggerNotification = (
		type: NotificationType,
		ctx: ExtensionContext,
		options: { bypassThrottle?: boolean; customMessage?: string; reason?: string; reminderKey?: ReminderKey } = {},
	): void => {
		queueTask(
			(async () => {
				if (!config.enabled || !isNotificationEnabled(config, type)) {
					return;
				}
				if (!options.bypassThrottle && shouldThrottle(type)) {
					return;
				}

				if (process.platform !== "linux" && !isWindows() && config.windowsOptimized && !warnedNonWindows) {
					warnedNonWindows = true;
					notifyUser(
						ctx,
						"smart-voice-notify has limited native channels on this platform. Using available fallback channels. Set windowsOptimized to false to hide this notice.",
						"warning",
					);
				}

				if (await shouldSkipFocusedNotification(type)) {
					return;
				}

				const spokenMessage = await buildNotificationMessage(type, {
					customMessage: options.customMessage,
					reason: options.reason,
				});
				const displayMessage = options.customMessage ?? INLINE_NOTIFY_TEXT[type];
				logger.debug("notification.triggered", {
					type,
					bypassThrottle: Boolean(options.bypassThrottle),
					notificationMode: config.notificationMode,
					text: displayMessage,
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

				enqueueAudio(async () => {
					const mode = config.notificationMode;
					const shouldPlaySoundNow =
						config.enableSound && (mode === "sound-first" || mode === "both" || mode === "sound-only");
					const shouldSpeakNow = config.enableTts && (mode === "tts-first" || mode === "both");

					try {
						if (shouldPlaySoundNow || shouldSpeakNow) {
							await wakeForNotification();
						}
					} catch (error) {
						logger.debug("wake.monitor.error", { error: getErrorMessage(error) });
					}

					let soundPlayed = false;
					if (shouldPlaySoundNow) {
						soundPlayed = await playNotificationSound(type);
						if (!soundPlayed && mode === "sound-first" && config.enableTts) {
							await speakNotification(spokenMessage);
						}
					}

					await dispatchDesktop(type, displayMessage, ctx);

					if (shouldSpeakNow) {
						const spoken = await speakNotification(spokenMessage);
						if (!spoken && !shouldPlaySoundNow && config.enableSound) {
							await playNotificationSound(type);
						}
					}

					dispatchWebhook(type, spokenMessage);
				});
				scheduleReminder(options.reminderKey ?? defaultReminderKey(type), type, config.reminderDelaySeconds, 0);
			})(),
			logError,
		);
	};

	pi.events.on(PERMISSION_SYSTEM_EVENT_CHANNEL, (payload: unknown) => {
		const event = readPermissionSystemEvent(payload);
		if (!event) {
			return;
		}
		if (!config.enabled || !config.enablePermissionNotification) {
			return;
		}
		if (!activeSessionContext) {
			logger.debug("permission_system.notification_skipped", {
				reason: "missing_session_context",
				requestId: event.requestId,
				state: event.state,
				source: event.source,
			});
			return;
		}

		const reminderKey = permissionSystemReminderKey(event);
		if (event.state === "waiting") {
			if (event.toolCallId) {
				pendingPermissionToolCallIds.add(event.toolCallId);
				rememberScopedToolCallId(event.toolCallId, blockedPermissionToolCallIds);
			}
			logger.debug("permission_system.wait_detected", {
				requestId: event.requestId,
				toolCallId: event.toolCallId ?? null,
				toolName: event.toolName ?? null,
				skillName: event.skillName ?? null,
				source: event.source,
			});
			triggerNotification("permission", activeSessionContext, {
				reason: event.message,
				reminderKey,
			});
			return;
		}

		if (event.toolCallId) {
			pendingPermissionToolCallIds.delete(event.toolCallId);
		}
		cancelReminderActivityForKey(reminderKey, "permission_system_wait_resolved", {
			requestId: event.requestId,
			toolCallId: event.toolCallId ?? null,
			toolName: event.toolName ?? null,
			skillName: event.skillName ?? null,
			state: event.state,
			source: event.source,
		});
	});

	const applySetting = (draft: VoiceNotifyConfig, id: string, value: string): void => {
		switch (id) {
			case "enabled":
				draft.enabled = boolValue(value);
				return;
			case "enableTts":
				draft.enableTts = boolValue(value);
				return;
			case "ttsEngine":
				if (TTS_ENGINE_VALUES.includes(value as VoiceNotifyConfig["ttsEngine"])) {
					draft.ttsEngine = value as VoiceNotifyConfig["ttsEngine"];
				}
				return;
			case "enableDesktopNotification":
				draft.enableDesktopNotification = boolValue(value);
				return;
			case "skipWhenFocused":
				draft.skipWhenFocused = boolValue(value);
				return;
			case "volume":
				draft.volume = clampInt(Number(value), draft.volume, 0, 100);
				return;
			default:
				return;
		}
	};

	const buildSettings = (draft: VoiceNotifyConfig): SettingItem[] => {
		const volumeValues = Array.from(new Set(["0", "25", "50", "75", "85", "100", String(draft.volume)])).sort(
			(a, b) => Number(a) - Number(b),
		);

		return [
			{ id: "enabled", label: "Extension Enabled", currentValue: draft.enabled ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{ id: "enableTts", label: "Speak TTS", currentValue: draft.enableTts ? "on" : "off", values: [...BOOLEAN_VALUES] },
			{ id: "ttsEngine", label: "TTS Engine", currentValue: draft.ttsEngine, values: [...TTS_ENGINE_VALUES] },
			{
				id: "enableDesktopNotification",
				label: "Desktop Notifications",
				currentValue: draft.enableDesktopNotification ? "on" : "off",
				values: [...BOOLEAN_VALUES],
			},
			{
				id: "skipWhenFocused",
				label: "Skip Notifications When Focused",
				currentValue: draft.skipWhenFocused ? "on" : "off",
				values: [...BOOLEAN_VALUES],
			},
			{ id: "volume", label: "Volume (%)", currentValue: String(draft.volume), values: volumeValues },
		];
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

		const draft: VoiceNotifyConfig = { ...config };
		const items = buildSettings(draft);
		const overlayOptions = { anchor: "center" as const, width: 92, maxHeight: "85%" as const, margin: 1 };
		const advancedConfigPath = "~/.pi/agent/extensions/pi-smart-voice-notify/config/config.json";
		const description = `Recommended settings only.\nFor advanced settings, manually edit: ${advancedConfigPath}`;

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
							refreshIntegratedServiceConfig();
							syncPermissionForwardingWatcher();
							if (config.debugLog && !previousConfig.debugLog) {
								logger.debug("debug.enabled", { debugLogPath: DEBUG_LOG_PATH });
							}
							logger.debug("config.setting_updated", { id, newValue });
							if (!config.enabled || !config.reminderEnabled) {
								cancelReminderActivity("config_disabled", { id, newValue });
							}
							persistConfig(ctx);
							updateStatus(ctx);
						},
						onClose: () => done(),
						helpText: `Active config: ${CONFIG_PATH} • Debug: ${DEBUG_LOG_PATH}`,
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
			config = readConfig();
			refreshIntegratedServiceConfig();
			syncPermissionForwardingWatcher();
			refreshQuestionToolAvailability();
			cancelReminderActivity("command_reload");
			updateStatus(ctx);
			notifyUser(ctx, "Reloaded smart voice notify config from disk.", "info");
			return;
		}

		if (subcommand === "on" || subcommand === "off") {
			config.enabled = subcommand === "on";
			refreshIntegratedServiceConfig();
			syncPermissionForwardingWatcher();
			persistConfig(ctx);
			if (!config.enabled) {
				cancelReminderActivity("command_disabled");
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
		activeSessionContext = ctx;
		config = readConfig();
		refreshIntegratedServiceConfig();
		syncPermissionForwardingWatcher();
		refreshQuestionToolAvailability();
		clearFocusDetectCache();
		clearProjectSoundCache();
		lastUserActivityAt = Date.now();
		hadErrorInTurn = false;
		warnedNonWindows = false;
		warnedDesktopUnsupported = false;
		pendingPermissionToolCallIds.clear();
		blockedPermissionToolCallIds.clear();
		processedToolResultToolCallIds.clear();
		lastNotificationAt.clear();
		cancelReminderActivity("session_start");
		updateStatus(ctx);
		logger.debug("session.start", {
			configPath: CONFIG_PATH,
			debugLogPath: DEBUG_LOG_PATH,
			notificationMode: config.notificationMode,
		});
	});

	pi.on("session_switch", async (_event, ctx) => {
		activeSessionContext = ctx;
		syncPermissionForwardingWatcher();
		refreshQuestionToolAvailability();
		clearFocusDetectCache();
		clearProjectSoundCache();
		lastUserActivityAt = Date.now();
		hadErrorInTurn = false;
		warnedDesktopUnsupported = false;
		pendingPermissionToolCallIds.clear();
		blockedPermissionToolCallIds.clear();
		processedToolResultToolCallIds.clear();
		lastNotificationAt.clear();
		cancelReminderActivity("session_switch");
		updateStatus(ctx);
		logger.debug("session.switch", {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		logger.debug("session.shutdown", {});
		activeSessionContext = null;
		permissionForwardingWatcher.stop();
		pendingPermissionToolCallIds.clear();
		blockedPermissionToolCallIds.clear();
		processedToolResultToolCallIds.clear();
		cancelReminderActivity("session_shutdown");
		clearFocusDetectCache();
		clearProjectSoundCache();
		await webhookService.flush();
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			lastUserActivityAt = Date.now();
			cancelReminderActivity("user_input", { source: event.source });
		}
	});

	pi.on("agent_start", async () => {
		hadErrorInTurn = false;
		pendingPermissionToolCallIds.clear();
		blockedPermissionToolCallIds.clear();
		processedToolResultToolCallIds.clear();
		logger.debug("agent.start", {});
	});

	pi.on("tool_call", async (event, ctx) => {
		activeSessionContext = ctx;
		if (!config.enabled || !config.enablePermissionNotification) {
			return {};
		}

		const reason = extractToolCallBlockReason(event);
		if (!reason || !isPermissionReason(reason)) {
			return {};
		}

		if (!rememberScopedToolCallId(event.toolCallId, blockedPermissionToolCallIds)) {
			return {};
		}

		pendingPermissionToolCallIds.add(event.toolCallId);
		logger.debug("tool_call.permission_blocked", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			reason,
		});
		triggerNotification("permission", ctx, {
			reason,
			reminderKey: permissionReminderKey(event.toolCallId),
		});
		return {};
	});

	pi.on("tool_execution_start", async (event) => {
		resolvePermissionInteraction(event.toolCallId, "tool_execution_start", {
			toolName: event.toolName,
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		activeSessionContext = ctx;
		resolvePermissionInteraction(event.toolCallId, "tool_result", {
			toolName: event.toolName,
			isError: event.isError,
		});
		if (!config.enabled) {
			return;
		}

		if (!rememberScopedToolCallId(event.toolCallId, processedToolResultToolCallIds)) {
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
		triggerNotification(type, ctx, {
			reason: event.isError ? text.slice(0, 120) : undefined,
		});
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeSessionContext = ctx;
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
