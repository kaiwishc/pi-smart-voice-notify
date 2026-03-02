export type NotificationType = "idle" | "permission" | "question" | "error";
export type NotificationMode = "sound-first" | "tts-first" | "both" | "sound-only";
export type NotifyLevel = "info" | "warning" | "error";

export interface VoiceNotifyConfig {
	version: 1;
	enabled: boolean;
	windowsOptimized: boolean;
	notificationMode: NotificationMode;
	enableSound: boolean;
	enableTts: boolean;
	enableDesktopNotification: boolean;
	desktopNotificationTimeout: number;
	wakeMonitor: boolean;
	idleThresholdSeconds: number;
	enableIdleNotification: boolean;
	enablePermissionNotification: boolean;
	enableQuestionNotification: boolean;
	enableErrorNotification: boolean;
	reminderEnabled: boolean;
	reminderDelaySeconds: number;
	followUpEnabled: boolean;
	maxFollowUps: number;
	followUpBackoffMultiplier: number;
	minNotificationIntervalMs: number;
	suppressIdleAfterError: boolean;
	ttsVoice: string;
	ttsRate: number;
	idleSoundFile: string;
	permissionSoundFile: string;
	questionSoundFile: string;
	errorSoundFile: string;
	debugLog: boolean;
}

export interface ReminderState {
	timeoutId: NodeJS.Timeout;
	scheduledAt: number;
	followUpCount: number;
	delaySeconds: number;
}

export interface MessageSet {
	initial: string[];
	reminder: string[];
}

export type SoundFileField =
	| "idleSoundFile"
	| "permissionSoundFile"
	| "questionSoundFile"
	| "errorSoundFile";
