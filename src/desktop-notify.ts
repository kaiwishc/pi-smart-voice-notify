import type { NotificationType } from "./types.ts";
import { getErrorMessage } from "./logging.ts";

type LinuxUrgency = "low" | "normal" | "critical";

interface DesktopNotificationSupport {
	supported: boolean;
	reason?: string;
}

interface DesktopNotificationRequest {
	type: NotificationType;
	message: string;
	timeoutSeconds: number;
	debugLog?: boolean;
}

export interface DesktopNotificationResult {
	success: boolean;
	platform: NodeJS.Platform;
	unsupported?: boolean;
	error?: string;
}

interface NotifierLike {
	notify(
		options: Record<string, unknown>,
		callback?: (error: Error | null, response?: unknown, metadata?: unknown) => void,
	): void;
}

const TITLES: Record<NotificationType, string> = {
	idle: "✅ Pi - Task Complete",
	permission: "⚠️ Pi - Permission Required",
	question: "❓ Pi - Input Needed",
	error: "❌ Pi - Error",
};

const LINUX_URGENCY: Record<NotificationType, LinuxUrgency> = {
	idle: "normal",
	permission: "critical",
	question: "normal",
	error: "critical",
};

let notifierPromise: Promise<NotifierLike | null> | null = null;

function clampTimeoutSeconds(value: number): number {
	if (!Number.isFinite(value)) {
		return 5;
	}
	return Math.min(60, Math.max(1, Math.trunc(value)));
}

export function checkDesktopNotificationSupport(platform = process.platform): DesktopNotificationSupport {
	switch (platform) {
		case "win32":
		case "darwin":
		case "linux":
			return { supported: true };
		default:
			return {
				supported: false,
				reason: `Desktop notifications are unsupported on platform '${platform}'.`,
			};
	}
}

function buildNotifierOptions(request: DesktopNotificationRequest): Record<string, unknown> {
	const timeoutSeconds = clampTimeoutSeconds(request.timeoutSeconds);
	const baseOptions: Record<string, unknown> = {
		title: TITLES[request.type],
		message: request.message,
		wait: false,
		timeout: timeoutSeconds,
	};

	if (process.platform === "linux") {
		baseOptions.urgency = LINUX_URGENCY[request.type];
		baseOptions["app-name"] = "Pi Smart Voice Notify";
	}

	if (process.platform === "win32") {
		baseOptions.appID = "PiSmartVoiceNotify";
	}

	if (process.platform === "darwin") {
		baseOptions.subtitle = "Smart Voice Notify";
	}

	return baseOptions;
}

async function getNotifier(): Promise<NotifierLike | null> {
	if (!notifierPromise) {
		notifierPromise = import("node-notifier")
			.then((module) => {
				const candidate = (module.default ?? module) as { notify?: NotifierLike["notify"] };
				if (typeof candidate.notify !== "function") {
					return null;
				}
				return { notify: candidate.notify };
			})
			.catch(() => null);
	}
	return notifierPromise;
}

export async function sendDesktopNotification(request: DesktopNotificationRequest): Promise<DesktopNotificationResult> {
	const support = checkDesktopNotificationSupport();
	if (!support.supported) {
		return {
			success: false,
			platform: process.platform,
			unsupported: true,
			error: support.reason,
		};
	}

	const notifier = await getNotifier();
	if (!notifier) {
		return {
			success: false,
			platform: process.platform,
			error: "node-notifier is not available. Install it in this extension directory.",
		};
	}

	const notifyOptions = buildNotifierOptions(request);
	const timeoutSeconds = clampTimeoutSeconds(request.timeoutSeconds);
	const callbackTimeoutMs = Math.min(1200, Math.max(250, timeoutSeconds * 1000 + 250));

	return new Promise<DesktopNotificationResult>((resolve) => {
		let settled = false;
		const settle = (result: DesktopNotificationResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(safetyTimeout);
			resolve(result);
		};

		const safetyTimeout = setTimeout(() => {
			if (request.debugLog) {
				// Callback can be dropped by some notifier backends; treat as queued/success.
			}
			settle({ success: true, platform: process.platform });
		}, callbackTimeoutMs);

		try {
			notifier.notify(notifyOptions, (error) => {
				if (error) {
					settle({
						success: false,
						platform: process.platform,
						error: getErrorMessage(error),
					});
					return;
				}
				settle({ success: true, platform: process.platform });
			});
		} catch (error) {
			settle({
				success: false,
				platform: process.platform,
				error: getErrorMessage(error),
			});
		}
	});
}
