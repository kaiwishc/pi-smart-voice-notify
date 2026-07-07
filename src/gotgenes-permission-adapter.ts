/**
 * Gotgenes permission event adapter for pi-smart-voice-notify.
 *
 * Adds additive support for @gotgenes/pi-permission-system's cross-extension
 * events (permissions:ready, permissions:ui_prompt, permissions:decision)
 * while leaving the existing MasuRii pi-permission-system:permission-request
 * handler and forwarded-permission watcher fully intact.
 *
 * Deduplication across old/new/watcher sources is handled via a
 * time-limited seen-request-IDs set.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ExtensionLogger } from "./logging.ts";
import type { VoiceNotifyConfig, NotificationType } from "./types.ts";
import { getErrorMessage } from "./logging.ts";

// ─── Event channel constants ───────────────────────────────────────

const GOTGENES_READY_CHANNEL = "permissions:ready";
const GOTGENES_UI_PROMPT_CHANNEL = "permissions:ui_prompt";
const GOTGENES_DECISION_CHANNEL = "permissions:decision";

// ─── Dedup TTL ─────────────────────────────────────────────────────

/** Seconds after which a seen requestId is eligible for re-notification. */
const DEDUP_TTL_SECONDS = 30;

// ─── Dependencies ──────────────────────────────────────────────────

export interface GotgenesPermissionAdapterDeps {
	queuePermissionNotification: (
		ctx: ExtensionContext,
		entry: { reminderKey: string; reason?: string; customMessage?: string },
	) => void;
	removePermissionFromBatch: (
		reminderKey: string,
		reason: string,
		details: Record<string, unknown>,
	) => void;
	cancelReminderActivityForKey: (
		reminderKey: string,
		reason: string,
		details: Record<string, unknown>,
	) => void;
	getActiveSessionContext: () => ExtensionContext | null;
	isNotificationEnabled: (config: VoiceNotifyConfig, type: NotificationType) => boolean;
	/** Getter that always returns the current config, even after reload. */
	getConfig: () => VoiceNotifyConfig;
	logger: ExtensionLogger;
}

// ─── Type guards for gotgenes permission events ────────────────────

interface GotgenesUiPromptEvent {
	requestId: string;
	message: string;
	toolCallId?: string;
	toolName?: string;
	agentName?: string;
	[key: string]: unknown;
}

interface GotgenesDecisionEvent {
	requestId: string;
	decision: "allow" | "deny";
	toolCallId?: string;
	toolName?: string;
	agentName?: string;
	[key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGotgenesUiPrompt(value: unknown): GotgenesUiPromptEvent | null {
	if (!isRecord(value)) return null;
	if (typeof value.requestId !== "string" || !value.requestId) return null;
	if (typeof value.message !== "string") return null;
	return value as unknown as GotgenesUiPromptEvent;
}

function parseGotgenesDecision(value: unknown): GotgenesDecisionEvent | null {
	if (!isRecord(value)) return null;
	if (typeof value.requestId !== "string" || !value.requestId) return null;
	if (value.decision !== "allow" && value.decision !== "deny") return null;
	return value as unknown as GotgenesDecisionEvent;
}

// ─── Dedup tracker with TTL ────────────────────────────────────────

class RequestDedupTracker {
	private readonly seen = new Map<string, number>();

	public hasSeen(requestId: string): boolean {
		this.evict();
		return this.seen.has(requestId);
	}

	public markSeen(requestId: string): void {
		this.evict();
		this.seen.set(requestId, Date.now() + DEDUP_TTL_SECONDS * 1000);
	}

	public remove(requestId: string): void {
		this.seen.delete(requestId);
	}

	private evict(): void {
		const now = Date.now();
		for (const [key, expiresAt] of this.seen) {
			if (expiresAt <= now) {
				this.seen.delete(key);
			}
		}
	}
}

// ─── Registration ──────────────────────────────────────────────────

/**
 * Register gotgenes permission event listeners.
 *
 * Must be called from inside a Pi extension factory after all existing
 * event listeners have been registered.  This function is purely additive:
 * it does not touch the old PERMISSION_SYSTEM_EVENT_CHANNEL handler or
 * the forwarded-permission watcher.
 */
export function registerGotgenesPermissionEvents(
	pi: ExtensionAPI,
	deps: GotgenesPermissionAdapterDeps,
): void {
	const dedup = new RequestDedupTracker();
	let gotgenesReady = false;

	// ── permissions:ready ───────────────────────────────────────
	pi.events.on(GOTGENES_READY_CHANNEL, (_payload: unknown) => {
		gotgenesReady = true;
		deps.logger.debug("gotgenes_permission.ready", {});
	});

	// ── permissions:ui_prompt ───────────────────────────────────
	pi.events.on(GOTGENES_UI_PROMPT_CHANNEL, (payload: unknown) => {
		const event = parseGotgenesUiPrompt(payload);
		if (!event) {
			deps.logger.debug("gotgenes_permission.ui_prompt.parse_failed", { payload });
			return;
		}

		const curCfg = deps.getConfig();
		if (!curCfg.enabled || !deps.isNotificationEnabled(curCfg, "permission")) {
			deps.logger.debug("gotgenes_permission.ui_prompt.skipped", {
				reason: "notifications_disabled",
				requestId: event.requestId,
			});
			return;
		}

		const ctx = deps.getActiveSessionContext();
		if (!ctx) {
			deps.logger.debug("gotgenes_permission.ui_prompt.skipped", {
				reason: "missing_session_context",
				requestId: event.requestId,
			});
			return;
		}

		// Dedup: if this requestId was already notified (by old event or watcher), skip
		if (dedup.hasSeen(event.requestId)) {
			deps.logger.debug("gotgenes_permission.ui_prompt.dedup_skipped", {
				requestId: event.requestId,
			});
			return;
		}
		dedup.markSeen(event.requestId);

		const reminderKey = `gotgenes:permission:${event.requestId}`;
		const customMessage = event.message || "A permission request is waiting for your approval.";
		const agentSuffix =
			typeof event.agentName === "string" && event.agentName
				? ` from agent "${event.agentName}"`
				: "";

		deps.logger.debug("gotgenes_permission.ui_prompt.notifying", {
			requestId: event.requestId,
			reminderKey,
			toolCallId: event.toolCallId ?? null,
			toolName: event.toolName ?? null,
			agentName: event.agentName ?? null,
		});

		deps.queuePermissionNotification(ctx, {
			reminderKey,
			reason: `gotgenes_ui_prompt:${event.requestId}`,
			customMessage: `${customMessage}${agentSuffix}`,
		});
	});

	// ── permissions:decision ────────────────────────────────────
	pi.events.on(GOTGENES_DECISION_CHANNEL, (payload: unknown) => {
		const event = parseGotgenesDecision(payload);
		if (!event) {
			deps.logger.debug("gotgenes_permission.decision.parse_failed", { payload });
			return;
		}

		const reminderKey = `gotgenes:permission:${event.requestId}`;

		deps.logger.debug("gotgenes_permission.decision.resolving", {
			requestId: event.requestId,
			decision: event.decision,
			reminderKey,
		});

		dedup.remove(event.requestId);

		deps.removePermissionFromBatch(reminderKey, "gotgenes_decision", {
			requestId: event.requestId,
			decision: event.decision,
			toolCallId: event.toolCallId ?? null,
			toolName: event.toolName ?? null,
			agentName: event.agentName ?? null,
		});

		deps.cancelReminderActivityForKey(reminderKey, "gotgenes_decision", {
			requestId: event.requestId,
			decision: event.decision,
			toolCallId: event.toolCallId ?? null,
			toolName: event.toolName ?? null,
			agentName: event.agentName ?? null,
		});
	});
}
