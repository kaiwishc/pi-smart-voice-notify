import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { DEFAULT_CONFIG } from "./config-store.ts";
import smartVoiceNotifyExtension, { type SmartVoiceNotifyDependencies } from "./index.ts";
import type { TTSAvailability, TTSConfig, TTSEngine, TTSService, SpeakOptions } from "./types/tts.ts";
import type { VoiceNotifyConfig } from "./types.ts";

interface FakeContext {
	hasUI: boolean;
}

interface SpeakCall {
	text: string;
	signal?: AbortSignal;
	aborted: boolean;
	complete: (result?: boolean) => void;
}

type EventHandler = (event: unknown, ctx: FakeContext) => Promise<unknown> | unknown;
type PermissionForwardingWatcherFactory = NonNullable<SmartVoiceNotifyDependencies["createPermissionForwardingWatcher"]>;
type PermissionForwardingWatcherOptions = Parameters<PermissionForwardingWatcherFactory>[0];
type PermissionForwardingWatcherController = ReturnType<PermissionForwardingWatcherFactory>;
type ForwardedPermissionRequestEvent = Parameters<PermissionForwardingWatcherOptions["onRequest"]>[0];
type ForwardedPermissionResolutionEvent = Parameters<PermissionForwardingWatcherOptions["onResolve"]>[0];
type PermissionForwardingWatcherConfig = Parameters<PermissionForwardingWatcherController["start"]>[0];
type EventBusHandler = (payload: unknown) => void;

const PERMISSION_SYSTEM_EVENT_CHANNEL = "pi-permission-system:permission-request";

const EMPTY_AVAILABILITY: TTSAvailability = {
	"espeak-ng": false,
	edge: false,
	elevenlabs: false,
	openai: false,
	sapi: false,
};

class FakeEventBus {
	private readonly handlers = new Map<string, EventBusHandler[]>();

	public on(channel: string, handler: EventBusHandler): () => void {
		const existing = this.handlers.get(channel) ?? [];
		existing.push(handler);
		this.handlers.set(channel, existing);
		return () => {
			const current = this.handlers.get(channel) ?? [];
			this.handlers.set(channel, current.filter((entry) => entry !== handler));
		};
	}

	public emit(channel: string, payload: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) {
			handler(payload);
		}
	}
}

class FakePi {
	private readonly handlers = new Map<string, EventHandler[]>();

	public readonly events = new FakeEventBus();

	public on(eventName: string, handler: EventHandler): void {
		const existing = this.handlers.get(eventName) ?? [];
		existing.push(handler);
		this.handlers.set(eventName, existing);
	}

	public registerCommand(): void {
	}

	public getAllTools(): Array<{ name: string }> {
		return [];
	}

	public sendMessage(): void {
	}

	public async exec(): Promise<never> {
		throw new Error("Unexpected exec invocation in pi-smart-voice-notify index test");
	}

	public async emit(eventName: string, event: unknown, ctx: FakeContext): Promise<void> {
		for (const handler of this.handlers.get(eventName) ?? []) {
			await handler(event, ctx);
		}
	}
}

class FakePermissionForwardingWatcher implements PermissionForwardingWatcherController {
	private readonly onRequest: PermissionForwardingWatcherOptions["onRequest"];
	private readonly onResolve: PermissionForwardingWatcherOptions["onResolve"];

	public currentConfig: PermissionForwardingWatcherConfig | null = null;

	public constructor(options: PermissionForwardingWatcherOptions) {
		this.onRequest = options.onRequest;
		this.onResolve = options.onResolve;
	}

	public start(config: PermissionForwardingWatcherConfig): void {
		this.currentConfig = config;
	}

	public updateConfig(config: PermissionForwardingWatcherConfig): void {
		this.currentConfig = config;
	}

	public stop(): void {
		this.currentConfig = null;
	}

	public emitRequest(event: ForwardedPermissionRequestEvent): void {
		this.onRequest(event);
	}

	public emitResolve(event: ForwardedPermissionResolutionEvent): void {
		this.onResolve(event);
	}
}

function createTestConfig(overrides: Partial<VoiceNotifyConfig> = {}): VoiceNotifyConfig {
	const baseConfig = structuredClone(DEFAULT_CONFIG);
	return {
		...baseConfig,
		enabled: true,
		enableIdleNotification: false,
		enablePermissionNotification: true,
		enableForwardedPermissionWatcher: false,
		enableQuestionNotification: false,
		enableErrorNotification: false,
		enableSound: false,
		enableDesktopNotification: false,
		notificationMode: "tts-first",
		wakeMonitor: false,
		reminderEnabled: true,
		reminderDelaySeconds: 1,
		followUpEnabled: false,
		minNotificationIntervalMs: 0,
		...overrides,
	};
}

function createControlledTTSService(): { calls: SpeakCall[]; service: TTSService } {
	const calls: SpeakCall[] = [];
	const service: TTSService = {
		async speak(text: string, _engine: TTSEngine = "auto", options: SpeakOptions = {}): Promise<boolean> {
			if (!options.signal) {
				calls.push({
					text,
					aborted: false,
					complete: () => {
					},
				});
				return true;
			}

			const call: SpeakCall = {
				text,
				signal: options.signal,
				aborted: options.signal.aborted,
				complete: () => {
				},
			};
			calls.push(call);

			if (options.signal.aborted) {
				return false;
			}

			return await new Promise<boolean>((resolve) => {
				let settled = false;
				const finish = (result: boolean): void => {
					if (settled) {
						return;
					}
					settled = true;
					resolve(result);
				};

				call.complete = (result = true) => {
					finish(result);
				};
				options.signal?.addEventListener(
					"abort",
					() => {
						call.aborted = true;
						finish(false);
					},
					{ once: true },
				);
			});
		},
		async detectAvailableEngines(): Promise<TTSAvailability> {
			return EMPTY_AVAILABILITY;
		},
		getAvailableEngines(): Readonly<TTSAvailability> {
			return EMPTY_AVAILABILITY;
		},
		getConfig(): Readonly<TTSConfig> {
			return {} as TTSConfig;
		},
	};

	return { calls, service };
}

function createHarness(configOverrides: Partial<VoiceNotifyConfig> = {}): {
	ctx: FakeContext;
	forwardingWatcher: FakePermissionForwardingWatcher;
	pi: FakePi;
	ttsCalls: SpeakCall[];
} {
	const pi = new FakePi();
	const { calls, service } = createControlledTTSService();
	let forwardingWatcher: FakePermissionForwardingWatcher | null = null;

	smartVoiceNotifyExtension(pi as unknown as ExtensionAPI, {
		readConfigFromDisk: () => createTestConfig(configOverrides),
		initializeTTSService: () => service,
		createPermissionForwardingWatcher: (options) => {
			forwardingWatcher = new FakePermissionForwardingWatcher(options);
			return forwardingWatcher;
		},
	});

	if (!forwardingWatcher) {
		throw new Error("Expected permission forwarding watcher to be created");
	}

	return {
		ctx: { hasUI: false },
		forwardingWatcher,
		pi,
		ttsCalls: calls,
	};
}

function permissionEvent(toolCallId: string): { block: boolean; reason: string; toolCallId: string; toolName: string } {
	return {
		block: true,
		reason: "Requires approval from the user before continuing.",
		toolCallId,
		toolName: "write_file",
	};
}

function permissionSystemEvent(
	state: "waiting" | "approved" | "denied",
	requestId: string,
	overrides: Partial<{
		source: "tool_call" | "skill_input" | "skill_read";
		message: string;
		toolCallId: string;
		toolName: string;
		skillName: string;
		path: string;
		agentName: string | null;
	}> = {},
): Record<string, unknown> {
	return {
		requestId,
		state,
		source: overrides.source ?? "tool_call",
		message: overrides.message ?? "Current agent requested tool 'write'. Allow this call?",
		toolCallId: overrides.toolCallId,
		toolName: overrides.toolName,
		skillName: overrides.skillName,
		path: overrides.path,
		agentName: overrides.agentName ?? null,
	};
}

function forwardedPermissionRequest(
	requestId: string,
	requesterAgentName = "Delegate Alpha",
): ForwardedPermissionRequestEvent {
	return {
		source: "primary",
		requestId,
		requesterAgentName,
		filePath: `/tmp/${requestId}.json`,
	};
}

function forwardedPermissionResolution(
	requestId: string,
	reason: ForwardedPermissionResolutionEvent["reason"] = "request_removed",
): ForwardedPermissionResolutionEvent {
	return {
		...forwardedPermissionRequest(requestId),
		reason,
	};
}

function countReminderCalls(calls: SpeakCall[]): number {
	return calls.filter((call) => call.signal).length;
}

function immediateNotificationCalls(calls: SpeakCall[]): SpeakCall[] {
	return calls.filter((call) => !call.signal);
}

function reminderCalls(calls: SpeakCall[]): SpeakCall[] {
	return calls.filter((call) => call.signal);
}

function disableFocusDetection(t: TestContext): void {
	const previousFocusDetection = process.env.PI_SMART_NOTIFY_FOCUS_DETECTION;
	process.env.PI_SMART_NOTIFY_FOCUS_DETECTION = "0";
	t.after(() => {
		if (previousFocusDetection === undefined) {
			delete process.env.PI_SMART_NOTIFY_FOCUS_DETECTION;
			return;
		}
		process.env.PI_SMART_NOTIFY_FOCUS_DETECTION = previousFocusDetection;
	});
}

function useMockClock(t: TestContext): void {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	mock.timers.setTime(1_000);
	t.after(() => mock.timers.reset());
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

async function tickAndFlush(milliseconds: number): Promise<void> {
	mock.timers.tick(milliseconds);
	await flushAsyncWork();
	await flushAsyncWork();
}

test("permission-system waiting events trigger a permission notification and cancel on resolution", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-wait", {
			toolCallId: "call-wait",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();

	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);

	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("approved", "permission-wait", {
			toolCallId: "call-wait",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	await tickAndFlush(1_000);

	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("permission-system waiting events do not duplicate a later blocked tool_call notification", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	pi.events.emit(
		PERMISSION_SYSTEM_EVENT_CHANNEL,
		permissionSystemEvent("waiting", "permission-dedupe", {
			toolCallId: "call-dedupe",
			toolName: "write_file",
		}),
	);
	await flushAsyncWork();
	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);

	await pi.emit("tool_call", permissionEvent("call-dedupe"), ctx);
	await flushAsyncWork();

	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);
});

test("tool_execution_start only cancels the resolved permission reminder flow", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit("tool_call", permissionEvent("call-a"), ctx);
	await flushAsyncWork();
	await pi.emit("tool_call", permissionEvent("call-b"), ctx);
	await flushAsyncWork();

	assert.equal(countReminderCalls(ttsCalls), 0);

	await tickAndFlush(1_000);
	const activeReminderCalls = reminderCalls(ttsCalls);
	assert.equal(activeReminderCalls.length, 1);
	assert.equal(activeReminderCalls[0]?.aborted, false);

	await pi.emit("tool_execution_start", { toolCallId: "call-a", toolName: "write_file" }, ctx);
	await flushAsyncWork();
	assert.equal(activeReminderCalls[0]?.aborted, true);

	await flushAsyncWork();
	const remainingReminderCalls = reminderCalls(ttsCalls);
	assert.equal(remainingReminderCalls.length, 2);
	assert.equal(remainingReminderCalls[1]?.aborted, false);

	await pi.emit("tool_execution_start", { toolCallId: "call-b", toolName: "write_file" }, ctx);
	await flushAsyncWork();
	assert.equal(remainingReminderCalls[1]?.aborted, true);
});

test("tool_result resolution keeps another permission reminder active while dropping the resolved queued flow", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness();

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit("tool_call", permissionEvent("call-a"), ctx);
	await flushAsyncWork();
	await pi.emit("tool_call", permissionEvent("call-b"), ctx);
	await flushAsyncWork();
	await tickAndFlush(1_000);

	const pendingReminderCalls = reminderCalls(ttsCalls);
	assert.equal(pendingReminderCalls.length, 1);
	assert.equal(pendingReminderCalls[0]?.aborted, false);

	await pi.emit("tool_result", { toolCallId: "call-b", toolName: "write_file", isError: false, content: [] }, ctx);
	await flushAsyncWork();
	assert.equal(pendingReminderCalls[0]?.aborted, false);

	pendingReminderCalls[0]?.complete(true);
	await flushAsyncWork();
	await flushAsyncWork();

	assert.equal(countReminderCalls(ttsCalls), 1);
});

test("tool_result with the same toolCallId still classifies after a permission-blocked tool_call", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, pi, ttsCalls } = createHarness({
		enableErrorNotification: true,
	});

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	await pi.emit("tool_call", permissionEvent("call-shared"), ctx);
	await flushAsyncWork();
	assert.equal(immediateNotificationCalls(ttsCalls).length, 1);

	await pi.emit(
		"tool_result",
		{
			toolCallId: "call-shared",
			toolName: "write_file",
			isError: true,
			content: [{ type: "text", text: "Write failed because the destination disk is full." }],
		},
		ctx,
	);
	await flushAsyncWork();

	assert.equal(immediateNotificationCalls(ttsCalls).length, 2);
});

test("forwarded permission resolution cancels a queued reminder before it fires", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, forwardingWatcher, pi, ttsCalls } = createHarness({
		enableForwardedPermissionWatcher: true,
		includeForwardedPermissionAgentName: true,
	});

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	forwardingWatcher.emitRequest(forwardedPermissionRequest("forwarded-queued", "Builder Beta"));
	await flushAsyncWork();

	const initialCalls = immediateNotificationCalls(ttsCalls);
	assert.equal(initialCalls.length, 1);
	assert.match(initialCalls[0]?.text ?? "", /builder beta/i);

	forwardingWatcher.emitResolve(forwardedPermissionResolution("forwarded-queued"));
	await flushAsyncWork();
	await tickAndFlush(1_000);

	assert.equal(countReminderCalls(ttsCalls), 0);
});

test("forwarded permission resolution aborts active reminder playback for that request", async (t) => {
	disableFocusDetection(t);
	useMockClock(t);

	const { ctx, forwardingWatcher, pi, ttsCalls } = createHarness({
		enableForwardedPermissionWatcher: true,
	});

	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
	forwardingWatcher.emitRequest(forwardedPermissionRequest("forwarded-active"));
	await flushAsyncWork();
	await tickAndFlush(1_000);

	const activeReminderCalls = reminderCalls(ttsCalls);
	assert.equal(activeReminderCalls.length, 1);
	assert.equal(activeReminderCalls[0]?.aborted, false);

	forwardingWatcher.emitResolve(forwardedPermissionResolution("forwarded-active"));
	await flushAsyncWork();

	assert.equal(activeReminderCalls[0]?.aborted, true);
});
