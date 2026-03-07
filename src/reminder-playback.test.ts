import assert from "node:assert/strict";
import test from "node:test";

import { ReminderPlaybackController } from "./reminder-playback.ts";

test("ReminderPlaybackController cancels only the matching reminder flow", () => {
	const controller = new ReminderPlaybackController();
	const firstCheckpoint = controller.captureCheckpoint("permission:tool-call:first");
	const secondCheckpoint = controller.captureCheckpoint("permission:tool-call:second");
	const firstHandle = controller.start(firstCheckpoint, "permission", 1);

	assert.equal(controller.isCurrent(firstCheckpoint, 1_000, 1_000), true);
	assert.equal(controller.isCurrent(secondCheckpoint, 1_000, 1_000), true);
	assert.equal(firstHandle.signal.aborted, false);

	const cancelled = controller.cancel("permission:tool-call:first");
	assert.deepEqual(cancelled, {
		cancelledActivePlayback: true,
		nextVersion: firstCheckpoint.version + 1,
	});
	assert.equal(firstHandle.signal.aborted, true);
	assert.equal(controller.isCurrent(firstCheckpoint, 1_000, 1_000), false);
	assert.equal(controller.isCurrent(secondCheckpoint, 1_000, 1_000), true);
});

test("ReminderPlaybackController aborts superseded playback handles without invalidating other reminders", () => {
	const controller = new ReminderPlaybackController();
	const firstCheckpoint = controller.captureCheckpoint("permission:tool-call:first");
	const secondCheckpoint = controller.captureCheckpoint("permission:tool-call:second");
	const firstHandle = controller.start(firstCheckpoint, "permission", 1);
	const secondHandle = controller.start(secondCheckpoint, "permission", 2);

	assert.equal(firstHandle.signal.aborted, true);
	assert.equal(secondHandle.signal.aborted, false);

	controller.finish(firstHandle);
	assert.equal(controller.isCurrent(secondCheckpoint, 2_000, 2_000), true);

	controller.finish(secondHandle);
	const cancelled = controller.cancel("permission:tool-call:first");
	assert.equal(cancelled.cancelledActivePlayback, false);
	assert.equal(controller.isCurrent(secondCheckpoint, 2_000, 2_000), true);
});

test("ReminderPlaybackController cancelAll invalidates every reminder scope", () => {
	const controller = new ReminderPlaybackController();
	const permissionCheckpoint = controller.captureCheckpoint("permission:tool-call:first");
	const questionCheckpoint = controller.captureCheckpoint("question:default");
	const activeHandle = controller.start(permissionCheckpoint, "permission", 1);

	const cancelled = controller.cancelAll();
	assert.deepEqual(cancelled, {
		cancelledActivePlayback: true,
		nextGeneration: permissionCheckpoint.generation + 1,
	});
	assert.equal(activeHandle.signal.aborted, true);
	assert.equal(controller.isCurrent(permissionCheckpoint, 1_000, 1_000), false);
	assert.equal(controller.isCurrent(questionCheckpoint, 1_000, 1_000), false);

	const freshCheckpoint = controller.captureCheckpoint("question:default");
	assert.equal(controller.isCurrent(freshCheckpoint, 1_000, 1_000), true);
});
