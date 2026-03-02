import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
	MessageSet,
	NotificationMode,
	NotificationType,
	SoundFileField,
	VoiceNotifyConfig,
} from "./types.js";

export const EXTENSION_ID = "pi-smart-voice-notify";
export const STATUS_KEY = "smart-voice-notify";
export const CONFIG_DIR = join(homedir(), ".pi", "agent", "extensions", EXTENSION_ID);
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DEBUG_DIR = join(CONFIG_DIR, "debug");
export const DEBUG_LOG_PATH = join(DEBUG_DIR, `${EXTENSION_ID}.log`);

export const NOTIFICATION_MODES = ["sound-first", "tts-first", "both", "sound-only"] as const;
export const BOOLEAN_VALUES = ["on", "off"] as const;
export const REMINDER_DELAY_VALUES = ["10", "20", "30", "45", "60", "90"] as const;
export const DESKTOP_NOTIFICATION_TIMEOUT_VALUES = ["3", "5", "8", "10", "15", "20", "30"] as const;
export const IDLE_THRESHOLD_VALUES = ["15", "30", "45", "60", "90", "120"] as const;
export const MAX_FOLLOW_UP_VALUES = ["1", "2", "3", "4", "5"] as const;
export const RATE_VALUES = ["-5", "-3", "-1", "0", "1", "3", "5"] as const;

export const INLINE_NOTIFY_TEXT: Record<NotificationType, string> = {
	idle: "✅ Agent finished its current task.",
	permission: "⚠️ Action blocked by permission policy.",
	question: "❓ Agent needs your input.",
	error: "❌ Agent encountered an error.",
};

export const SOUND_FILE_FIELD: Record<NotificationType, SoundFileField> = {
	idle: "idleSoundFile",
	permission: "permissionSoundFile",
	question: "questionSoundFile",
	error: "errorSoundFile",
};

export const SOUND_LOOPS: Record<NotificationType, number> = {
	idle: 1,
	permission: 2,
	question: 1,
	error: 2,
};

export const MESSAGE_LIBRARY: Record<NotificationType, MessageSet> = {
	idle: {
		initial: [
			"All done. Your latest task has completed.",
			"Task finished. Ready whenever you are.",
			"Done. Please review the latest result.",
		],
		reminder: [
			"Reminder: the task is complete and waiting for you.",
			"Heads up, your finished result is still waiting.",
		],
	},
	permission: {
		initial: [
			"Permission required. Please check your terminal.",
			"I need approval before I can continue.",
		],
		reminder: [
			"Reminder: permission is still pending.",
			"I am still waiting for your approval.",
		],
	},
	question: {
		initial: [
			"I have a question for you in the terminal.",
			"Input required. Please answer the pending question.",
		],
		reminder: [
			"Reminder: I still need your answer.",
			"Question pending. Please respond when ready.",
		],
	},
	error: {
		initial: [
			"The agent hit an error. Please inspect the latest output.",
			"An error occurred and needs your attention.",
		],
		reminder: [
			"Reminder: there is still an unresolved error.",
			"The error is still pending your attention.",
		],
	},
};

export const PERMISSION_HINTS = [
	"permission",
	"not permitted",
	"requires approval",
	"approval",
	"user denied",
	"blocked by",
];

export const QUESTION_HINTS = ["question", "need your input", "please answer", "requires your input"];

export const DEFAULT_CONFIG: VoiceNotifyConfig = {
	version: 1,
	enabled: true,
	windowsOptimized: true,
	notificationMode: "sound-first",
	enableSound: true,
	enableTts: true,
	enableDesktopNotification: true,
	desktopNotificationTimeout: 8,
	wakeMonitor: true,
	idleThresholdSeconds: 30,
	enableIdleNotification: true,
	enablePermissionNotification: true,
	enableQuestionNotification: true,
	enableErrorNotification: true,
	reminderEnabled: true,
	reminderDelaySeconds: 30,
	followUpEnabled: true,
	maxFollowUps: 3,
	followUpBackoffMultiplier: 1.5,
	minNotificationIntervalMs: 1500,
	suppressIdleAfterError: true,
	ttsVoice: "Microsoft Zira Desktop",
	ttsRate: -1,
	idleSoundFile: "assets/Soft-high-tech-notification-sound-effect.mp3",
	permissionSoundFile: "assets/Machine-alert-beep-sound-effect.mp3",
	questionSoundFile: "assets/Machine-alert-beep-sound-effect.mp3",
	errorSoundFile: "assets/Machine-alert-beep-sound-effect.mp3",
	debugLog: false,
};

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, value));
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function stringOrDefault(value: unknown, fallback: string): string {
	if (typeof value === "string") {
		const normalized = value.trim();
		return normalized.length > 0 ? normalized : fallback;
	}
	return fallback;
}

export function normalizeMode(value: unknown): NotificationMode {
	if (typeof value === "string" && NOTIFICATION_MODES.includes(value as NotificationMode)) {
		return value as NotificationMode;
	}
	return DEFAULT_CONFIG.notificationMode;
}

export function normalizeConfig(raw: unknown): VoiceNotifyConfig {
	const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		version: 1,
		enabled: boolOrDefault(record.enabled, DEFAULT_CONFIG.enabled),
		windowsOptimized: boolOrDefault(record.windowsOptimized, DEFAULT_CONFIG.windowsOptimized),
		notificationMode: normalizeMode(record.notificationMode),
		enableSound: boolOrDefault(record.enableSound, DEFAULT_CONFIG.enableSound),
		enableTts: boolOrDefault(record.enableTts, DEFAULT_CONFIG.enableTts),
		enableDesktopNotification: boolOrDefault(
			record.enableDesktopNotification,
			DEFAULT_CONFIG.enableDesktopNotification,
		),
		desktopNotificationTimeout: clampInt(
			record.desktopNotificationTimeout,
			DEFAULT_CONFIG.desktopNotificationTimeout,
			1,
			60,
		),
		wakeMonitor: boolOrDefault(record.wakeMonitor, DEFAULT_CONFIG.wakeMonitor),
		idleThresholdSeconds: clampInt(record.idleThresholdSeconds, DEFAULT_CONFIG.idleThresholdSeconds, 5, 600),
		enableIdleNotification: boolOrDefault(record.enableIdleNotification, DEFAULT_CONFIG.enableIdleNotification),
		enablePermissionNotification: boolOrDefault(
			record.enablePermissionNotification,
			DEFAULT_CONFIG.enablePermissionNotification,
		),
		enableQuestionNotification: boolOrDefault(record.enableQuestionNotification, DEFAULT_CONFIG.enableQuestionNotification),
		enableErrorNotification: boolOrDefault(record.enableErrorNotification, DEFAULT_CONFIG.enableErrorNotification),
		reminderEnabled: boolOrDefault(record.reminderEnabled, DEFAULT_CONFIG.reminderEnabled),
		reminderDelaySeconds: clampInt(record.reminderDelaySeconds, DEFAULT_CONFIG.reminderDelaySeconds, 5, 300),
		followUpEnabled: boolOrDefault(record.followUpEnabled, DEFAULT_CONFIG.followUpEnabled),
		maxFollowUps: clampInt(record.maxFollowUps, DEFAULT_CONFIG.maxFollowUps, 1, 10),
		followUpBackoffMultiplier: clampNumber(
			record.followUpBackoffMultiplier,
			DEFAULT_CONFIG.followUpBackoffMultiplier,
			1,
			5,
		),
		minNotificationIntervalMs: clampInt(
			record.minNotificationIntervalMs,
			DEFAULT_CONFIG.minNotificationIntervalMs,
			0,
			60_000,
		),
		suppressIdleAfterError: boolOrDefault(record.suppressIdleAfterError, DEFAULT_CONFIG.suppressIdleAfterError),
		ttsVoice: stringOrDefault(record.ttsVoice, DEFAULT_CONFIG.ttsVoice),
		ttsRate: clampInt(record.ttsRate, DEFAULT_CONFIG.ttsRate, -10, 10),
		idleSoundFile: stringOrDefault(record.idleSoundFile, DEFAULT_CONFIG.idleSoundFile),
		permissionSoundFile: stringOrDefault(record.permissionSoundFile, DEFAULT_CONFIG.permissionSoundFile),
		questionSoundFile: stringOrDefault(record.questionSoundFile, DEFAULT_CONFIG.questionSoundFile),
		errorSoundFile: stringOrDefault(record.errorSoundFile, DEFAULT_CONFIG.errorSoundFile),
		debugLog: boolOrDefault(record.debugLog, DEFAULT_CONFIG.debugLog),
	};
}

export function ensureConfigDirectory(): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
	}
}

export function ensureDebugDirectory(): void {
	if (!existsSync(DEBUG_DIR)) {
		mkdirSync(DEBUG_DIR, { recursive: true });
	}
}

export function readConfigFromDisk(): VoiceNotifyConfig {
	ensureConfigDirectory();
	if (!existsSync(CONFIG_PATH)) {
		writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
		return { ...DEFAULT_CONFIG };
	}

	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		const normalized = normalizeConfig(parsed);
		writeFileSync(CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
		return normalized;
	} catch {
		writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
		return { ...DEFAULT_CONFIG };
	}
}

export function writeConfigToDisk(config: VoiceNotifyConfig): void {
	ensureConfigDirectory();
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function boolValue(value: string): boolean {
	return value === "on";
}

export function isWindows(): boolean {
	return process.platform === "win32";
}

export function resolveSoundFile(config: VoiceNotifyConfig, type: NotificationType): string | null {
	const field = SOUND_FILE_FIELD[type];
	const value = config[field];
	if (!value.trim()) {
		return null;
	}
	if (isAbsolute(value)) {
		return value;
	}
	return join(CONFIG_DIR, value);
}

export function summarizeConfig(config: VoiceNotifyConfig): string {
	return [
		`enabled=${config.enabled}`,
		`mode=${config.notificationMode}`,
		`sound=${config.enableSound}`,
		`tts=${config.enableTts}`,
		`desktopNotify=${config.enableDesktopNotification}`,
		`desktopNotifyTimeout=${config.desktopNotificationTimeout}s`,
		`wakeMonitor=${config.wakeMonitor}`,
		`idleThreshold=${config.idleThresholdSeconds}s`,
		`reminder=${config.reminderEnabled}`,
		`reminderDelay=${config.reminderDelaySeconds}s`,
		`followUps=${config.followUpEnabled ? config.maxFollowUps : 0}`,
		`sapiVoice=${config.ttsVoice}`,
		`sapiRate=${config.ttsRate}`,
		`debugLog=${config.debugLog}`,
		`debugLogPath=${DEBUG_LOG_PATH}`,
		`config=${CONFIG_PATH}`,
	].join("\n");
}

export function isNotificationEnabled(config: VoiceNotifyConfig, type: NotificationType): boolean {
	if (type === "idle") return config.enableIdleNotification;
	if (type === "permission") return config.enablePermissionNotification;
	if (type === "question") return config.enableQuestionNotification;
	return config.enableErrorNotification;
}
