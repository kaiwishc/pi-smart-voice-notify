/**
 * Shared test helpers for pi-smart-voice-notify tests.
 *
 * Consolidates the recurring permission-event emission, harness setup,
 * and assertion patterns that were duplicated across index.test.ts.
 */
import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";

export const PERMISSION_SYSTEM_EVENT_CHANNEL = "pi-permission-system:permission-request";
export const PERMISSION_BATCH_WINDOW_MS = 800;

export function setFocusDetection(t: TestContext, value: "0" | "1"): void {
	const previousFocusDetection = process.env.PI_SMART_NOTIFY_FOCUS_DETECTION;
	process.env.PI_SMART_NOTIFY_FOCUS_DETECTION = value;
	t.after(() => {
		if (previousFocusDetection === undefined) {
			delete process.env.PI_SMART_NOTIFY_FOCUS_DETECTION;
			return;
		}
		process.env.PI_SMART_NOTIFY_FOCUS_DETECTION = previousFocusDetection;
	});
}

export function disableFocusDetection(t: TestContext): void {
	setFocusDetection(t, "0");
}

export function enableFocusDetection(t: TestContext): void {
	setFocusDetection(t, "1");
}

export function useMockClock(t: TestContext): void {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	mock.timers.setTime(1_000);
	t.after(() => mock.timers.reset());
}

export async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

export async function tickAndFlush(milliseconds: number): Promise<void> {
	mock.timers.tick(milliseconds);
	await flushAsyncWork();
	await flushAsyncWork();
}

export function permissionEvent(toolCallId: string): {
	block: boolean;
	reason: string;
	toolCallId: string;
	toolName: string;
} {
	return {
		block: true,
		reason: "Requires approval from the user before continuing.",
		toolCallId,
		toolName: "write_file",
	};
}

export function permissionSystemEvent(
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

export function countReminderCalls<T extends { signal?: unknown }>(calls: T[]): number {
	return calls.filter((call) => call.signal).length;
}

export function immediateNotificationCalls<T extends { signal?: unknown }>(calls: T[]): T[] {
	return calls.filter((call) => !call.signal);
}

export function reminderCalls<T extends { signal?: unknown }>(calls: T[]): T[] {
	return calls.filter((call) => call.signal);
}

export async function emitSessionStart(pi: { emit: (event: string, payload: unknown, ctx: unknown) => Promise<void> }, ctx: unknown): Promise<void> {
	await pi.emit("session_start", {}, ctx);
	await flushAsyncWork();
}

export async function emitPermissionEvent(
	pi: { events: { emit: (channel: string, payload: unknown) => void } },
	state: "waiting" | "approved" | "denied",
	requestId: string,
	overrides: Parameters<typeof permissionSystemEvent>[2] = {},
): Promise<void> {
	pi.events.emit(PERMISSION_SYSTEM_EVENT_CHANNEL, permissionSystemEvent(state, requestId, overrides));
	await flushAsyncWork();
}

export async function emitPermissionWait(
	pi: { events: { emit: (channel: string, payload: unknown) => void } },
	requestId: string,
	overrides: Parameters<typeof permissionSystemEvent>[2] = {},
): Promise<void> {
	await emitPermissionEvent(pi, "waiting", requestId, overrides);
}

export async function emitPermissionResolve(
	pi: { events: { emit: (channel: string, payload: unknown) => void } },
	requestId: string,
	state: "approved" | "denied" = "approved",
	overrides: Parameters<typeof permissionSystemEvent>[2] = {},
): Promise<void> {
	await emitPermissionEvent(pi, state, requestId, overrides);
}

export function assertSingleImmediateNotification<T extends { signal?: unknown }>(calls: T[]): void {
	assert.equal(immediateNotificationCalls(calls).length, 1);
}

/**
 * Assert that no notifications fired: zero immediate calls and zero reminder calls.
 */
export function assertNoNotifications<T extends { signal?: unknown }>(calls: T[]): void {
	assert.equal(immediateNotificationCalls(calls).length, 0);
	assert.equal(countReminderCalls(calls), 0);
}

/**
 * Assert exactly one immediate notification and zero reminder calls.
 */
export function assertSingleNotificationNoReminder<T extends { signal?: unknown }>(calls: T[]): void {
	assertSingleImmediateNotification(calls);
	assert.equal(countReminderCalls(calls), 0);
}

/**
 * Emit a tool_result event with a text content block. Common shape used by
 * permission, question, and error notification tests.
 */
export async function emitToolResult(
	pi: { emit: (event: string, payload: unknown, ctx: unknown) => Promise<void> },
	ctx: unknown,
	options: {
		toolCallId: string;
		toolName: string;
		isError?: boolean;
		text: string;
	},
): Promise<void> {
	await pi.emit(
		"tool_result",
		{
			toolCallId: options.toolCallId,
			toolName: options.toolName,
			isError: options.isError ?? false,
			content: [{ type: "text", text: options.text }],
		},
		ctx,
	);
	await flushAsyncWork();
}

/**
 * Emit an agent_end event with a single assistant error message.
 */
export async function emitAgentEndError(
	pi: { emit: (event: string, payload: unknown, ctx: unknown) => Promise<void> },
	ctx: unknown,
	errorMessage: string,
): Promise<void> {
	await pi.emit(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage,
				},
			],
		},
		ctx,
	);
	await flushAsyncWork();
}

export { assert, test, mock };
