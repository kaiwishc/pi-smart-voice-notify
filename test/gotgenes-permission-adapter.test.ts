/**
 * Tests for the gotgenes permission event adapter.
 *
 * These tests directly exercise registerGotgenesPermissionEvents with
 * mocked dependencies, without going through the full smartVoiceNotifyExtension
 * bootstrap.  This keeps the test focused on the adapter's own logic.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGotgenesPermissionEvents, type GotgenesPermissionAdapterDeps } from "../src/gotgenes-permission-adapter.ts";
import type { ExtensionLogger } from "../src/logging.ts";
import type { VoiceNotifyConfig, NotificationType } from "../src/types.ts";

// ─── Helpers ───────────────────────────────────────────────────────

function noopLogger(): ExtensionLogger {
	return {
		debug: mock.fn(),
		error: mock.fn(),
		flush: mock.fn<() => Promise<void>>(() => Promise.resolve()),
	};
}

function defaultConfig(overrides: Partial<VoiceNotifyConfig> = {}): VoiceNotifyConfig {
	return {
		version: 1,
		enabled: true,
		windowsOptimized: false,
		notificationMode: "sound-first",
		enableSound: true,
		enableTts: false,
		ttsEngine: "auto",
		enableDesktopNotification: false,
		desktopNotificationTimeout: 8,
		wakeMonitor: false,
		idleThresholdSeconds: 30,
		enableIdleNotification: false,
		enablePermissionNotification: true,
		enableForwardedPermissionWatcher: false,
		includeForwardedPermissionAgentName: false,
		watchLegacyForwardedPermissionPath: false,
		enableQuestionNotification: false,
		enableErrorNotification: false,
		reminderEnabled: false,
		reminderDelaySeconds: 30,
		followUpEnabled: false,
		maxFollowUps: 3,
		followUpBackoffMultiplier: 1.5,
		minNotificationIntervalMs: 0,
		suppressIdleAfterError: true,
		enableAIMessages: false,
		aiEndpoint: "",
		aiModel: "",
		aiApiKey: "",
		aiTimeoutMs: 15000,
		aiTemperature: 0.7,
		aiMaxTokens: 120,
		aiFallbackToTemplates: true,
		personality: "",
		tone: "",
		enableMessageCache: true,
		messageCacheTtlMs: 60000,
		maxCacheEntries: 200,
		...overrides,
	} as VoiceNotifyConfig;
}

function fakeContext(): ExtensionContext {
	return { hasUI: false } as unknown as ExtensionContext;
}

type EventHandler = (payload: unknown) => void;

class FakeEventBus {
	private readonly handlers = new Map<string, EventHandler[]>();

	public on(channel: string, handler: EventHandler): void {
		const existing = this.handlers.get(channel) ?? [];
		existing.push(handler);
		this.handlers.set(channel, existing);
	}

	public emit(channel: string, payload: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) {
			handler(payload);
		}
	}
}

class FakePi {
	public readonly events = new FakeEventBus();
}

function createDeps(overrides: Partial<GotgenesPermissionAdapterDeps> = {}): GotgenesPermissionAdapterDeps {
	const queuePermissionNotification = mock.fn<(ctx: ExtensionContext, entry: { reminderKey: string; reason?: string; customMessage?: string }) => void>();
	const removePermissionFromBatch = mock.fn<(reminderKey: string, reason: string, details: Record<string, unknown>) => void>();
	const cancelReminderActivityForKey = mock.fn<(reminderKey: string, reason: string, details: Record<string, unknown>) => void>();
	const getActiveSessionContext = mock.fn<() => ExtensionContext | null>(() => fakeContext());
	const isNotificationEnabled = mock.fn<(config: VoiceNotifyConfig, type: NotificationType) => boolean>((_c, t) => {
		if (t === "permission") return true;
		return false;
	});
	const config = defaultConfig();
	const logger = noopLogger();

	return {
		queuePermissionNotification,
		removePermissionFromBatch,
		cancelReminderActivityForKey,
		getActiveSessionContext,
		isNotificationEnabled,
		getConfig: () => config,
		logger,
		...overrides,
	};
}

function createHarness(deps: GotgenesPermissionAdapterDeps = createDeps()): {
	pi: FakePi;
	deps: GotgenesPermissionAdapterDeps;
	resetDepsCounters: () => void;
} {
	const pi = new FakePi();
	registerGotgenesPermissionEvents(pi as unknown as ExtensionAPI, deps);

	const resetDepsCounters = (): void => {
		if (mock.tracking(deps.queuePermissionNotification)) {
			deps.queuePermissionNotification.mock.resetCalls();
		}
		if (mock.tracking(deps.removePermissionFromBatch)) {
			deps.removePermissionFromBatch.mock.resetCalls();
		}
		if (mock.tracking(deps.cancelReminderActivityForKey)) {
			deps.cancelReminderActivityForKey.mock.resetCalls();
		}
		if (mock.tracking(deps.getActiveSessionContext)) {
			deps.getActiveSessionContext.mock.resetCalls();
		}
		if (mock.tracking(deps.isNotificationEnabled)) {
			deps.isNotificationEnabled.mock.resetCalls();
		}
	};

	return { pi, deps, resetDepsCounters };
}

function assertCalledOnce(fn: ReturnType<typeof mock.fn>, message?: string): void {
	assert.equal(fn.mock.callCount(), 1, message ?? `expected exactly 1 call, got ${fn.mock.callCount()}`);
}

function assertNotCalled(fn: ReturnType<typeof mock.fn>, message?: string): void {
	assert.equal(fn.mock.callCount(), 0, message ?? `expected 0 calls, got ${fn.mock.callCount()}`);
}

// ─── Tests ─────────────────────────────────────────────────────────

test("permissions:ui_prompt triggers queuePermissionNotification with correct reminder key", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	pi.events.emit("permissions:ui_prompt", {
		requestId: "req-001",
		message: "Allow tool 'write'?",
	});

	assertCalledOnce(deps.queuePermissionNotification, "queuePermissionNotification should be called once");
	const call = deps.queuePermissionNotification.mock.calls[0];
	assert.ok(call.arguments[0] !== null, "context should be non-null");
	assert.equal((call.arguments[0] as { hasUI?: boolean }).hasUI, false, "should pass the real context object");
	assert.equal(call.arguments[1].reminderKey, "gotgenes:permission:req-001", "should use correct reminder key prefix");
	assert.equal(call.arguments[1].reason, "gotgenes_ui_prompt:req-001", "should include reason");
	assert.ok(call.arguments[1].customMessage?.includes("Allow tool 'write'?"), "should include original message");
});

test("permissions:ui_prompt with agentName appends agent suffix to message", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	pi.events.emit("permissions:ui_prompt", {
		requestId: "req-002",
		message: "Allow tool?",
		agentName: "worker",
	});

	assertCalledOnce(deps.queuePermissionNotification, "should notify");
	const call = deps.queuePermissionNotification.mock.calls[0];
	assert.ok(call.arguments[1].customMessage?.includes('from agent "worker"'), "should include agent name");
});

test("permissions:decision triggers removePermissionFromBatch and cancelReminderActivityForKey", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	// First send a prompt
	pi.events.emit("permissions:ui_prompt", {
		requestId: "req-003",
		message: "Allow?",
	});
	deps.queuePermissionNotification.mock.resetCalls();

	// Then send a decision
	pi.events.emit("permissions:decision", {
		requestId: "req-003",
		decision: "allow",
	});

	assertCalledOnce(deps.removePermissionFromBatch, "should remove from batch");
	assertCalledOnce(deps.cancelReminderActivityForKey, "should cancel reminder");

	const batchCall = deps.removePermissionFromBatch.mock.calls[0];
	assert.equal(batchCall.arguments[0], "gotgenes:permission:req-003");
	assert.equal(batchCall.arguments[1], "gotgenes_decision");
	assert.equal(batchCall.arguments[2].decision, "allow");

	const cancelCall = deps.cancelReminderActivityForKey.mock.calls[0];
	assert.equal(cancelCall.arguments[0], "gotgenes:permission:req-003", "reminder key should match");
});

test("permissions:decision triggers cleanup even without prior prompt", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	// Decision arrives without preceding prompt (e.g. already resolved by other extension)
	pi.events.emit("permissions:decision", {
		requestId: "req-orphan",
		decision: "deny",
	});

	assertCalledOnce(deps.removePermissionFromBatch, "should remove from batch");
	assertCalledOnce(deps.cancelReminderActivityForKey, "should cancel reminder");
});

test("duplicate ui_prompt with same requestId is deduplicated", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	pi.events.emit("permissions:ui_prompt", {
		requestId: "req-004",
		message: "First prompt",
	});
	assert.equal(deps.queuePermissionNotification.mock.callCount(), 1, "first prompt should notify");

	// Second emission with same requestId
	pi.events.emit("permissions:ui_prompt", {
		requestId: "req-004",
		message: "Second prompt",
	});
	assert.equal(deps.queuePermissionNotification.mock.callCount(), 1, "second prompt should be deduped and not notify");
});

test("decision clears dedup state so a subsequent prompt with same requestId notifies again", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	// First prompt
	pi.events.emit("permissions:ui_prompt", { requestId: "req-005", message: "First" });
	assert.equal(deps.queuePermissionNotification.mock.callCount(), 1);
	deps.queuePermissionNotification.mock.resetCalls();

	// Decision arrives
	pi.events.emit("permissions:decision", { requestId: "req-005", decision: "allow" });

	// Another prompt with same requestId — should notify because dedup was cleared
	pi.events.emit("permissions:ui_prompt", { requestId: "req-005", message: "Again" });
	assert.equal(deps.queuePermissionNotification.mock.callCount(), 1, "should notify again after decision clears dedup");
});

test("notifications are skipped when enablePermissionNotification is false", () => {
	const deps = createDeps({
		isNotificationEnabled: mock.fn((_c, t) => {
			if (t === "permission") return false;
			return true;
		}),
	});
	const { pi } = createHarness(deps);

	pi.events.emit("permissions:ui_prompt", {
		requestId: "req-disabled",
		message: "Allow?",
	});

	assertNotCalled(deps.queuePermissionNotification, "should skip when permission notifications disabled");
});

test("notifications are skipped when getActiveSessionContext returns null", () => {
	const deps = createDeps({
		getActiveSessionContext: mock.fn(() => null),
	});
	const { pi } = createHarness(deps);

	pi.events.emit("permissions:ui_prompt", {
		requestId: "req-noctx",
		message: "Allow?",
	});

	assertNotCalled(deps.queuePermissionNotification, "should skip when no active session context");
});

test("malformed ui_prompt payload is silently ignored", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	// Missing message
	pi.events.emit("permissions:ui_prompt", { requestId: "req-bad" } as unknown);
	assertNotCalled(deps.queuePermissionNotification, "missing message should not notify");

	// Non-object payload
	pi.events.emit("permissions:ui_prompt", "string payload" as unknown);
	assert.equal(deps.queuePermissionNotification.mock.callCount(), 0, "string payload should not notify");

	// Null payload
	pi.events.emit("permissions:ui_prompt", null as unknown);
	assert.equal(deps.queuePermissionNotification.mock.callCount(), 0, "null should not notify");

	// Array payload
	pi.events.emit("permissions:ui_prompt", [] as unknown);
	assert.equal(deps.queuePermissionNotification.mock.callCount(), 0, "array should not notify");
});

test("malformed decision payload is silently ignored", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	// Missing decision field
	pi.events.emit("permissions:decision", { requestId: "req-bad" } as unknown);
	assertNotCalled(deps.removePermissionFromBatch, "missing decision should not trigger cleanup");

	// Invalid decision value
	pi.events.emit("permissions:decision", { requestId: "req-bad2", decision: "maybe" } as unknown);
	assertNotCalled(deps.removePermissionFromBatch, "invalid decision value should not trigger cleanup");

	// Non-object
	pi.events.emit("permissions:decision", 42 as unknown);
	assertNotCalled(deps.removePermissionFromBatch, "number payload should not trigger cleanup");
});

test("permissions:ready sets internal ready flag (no notification)", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	// Emit ready — no notification or batch operations should fire
	pi.events.emit("permissions:ready", { hello: true });

	assertNotCalled(deps.queuePermissionNotification, "ready event should not trigger notification");
	assertNotCalled(deps.removePermissionFromBatch, "ready event should not trigger batch cleanup");
	assertNotCalled(deps.cancelReminderActivityForKey, "ready event should not trigger reminder cancel");
});

test("different requestIds are not deduped", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	pi.events.emit("permissions:ui_prompt", { requestId: "req-alpha", message: "Alpha" });
	pi.events.emit("permissions:ui_prompt", { requestId: "req-beta", message: "Beta" });

	assert.equal(deps.queuePermissionNotification.mock.callCount(), 2, "different requestIds should each notify");
});

test("toolCallId and toolName are forwarded to batch removal details on decision", () => {
	const deps = createDeps();
	const { pi } = createHarness(deps);

	pi.events.emit("permissions:decision", {
		requestId: "req-detail",
		decision: "deny",
		toolCallId: "tc-123",
		toolName: "bash",
	});

	assertCalledOnce(deps.removePermissionFromBatch);
	const details = deps.removePermissionFromBatch.mock.calls[0].arguments[2];
	assert.equal(details.toolCallId, "tc-123");
	assert.equal(details.toolName, "bash");
	assert.equal(details.decision, "deny");
});
