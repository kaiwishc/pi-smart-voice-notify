import assert from "node:assert/strict";
import test from "node:test";

import { runAbortableCommand } from "../src/abortable-command.ts";

test("runAbortableCommand rejects non-allowlisted commands before spawning", async () => {
	await assert.rejects(
		runAbortableCommand("curl;whoami", ["https://example.com"], { timeoutMs: 1_000 }),
		/command is not allowlisted/i,
	);
});

test("runAbortableCommand returns an aborted result when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();

	const result = await runAbortableCommand(process.execPath, ["-e", "process.exit(0)"], {
		signal: controller.signal,
		timeoutMs: 1_000,
	});

	assert.equal(result.aborted, true);
	assert.equal(result.code, 1);
	assert.match(result.errorMessage ?? "", /aborted before start/i);
});

test("runAbortableCommand stops an in-flight process when aborted", async () => {
	const controller = new AbortController();
	const startedAt = Date.now();
	const command = runAbortableCommand(
		process.execPath,
		[
			"-e",
			"process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.exit(0), 10000);",
		],
		{
			signal: controller.signal,
			timeoutMs: 5_000,
		},
	);

	setTimeout(() => {
		controller.abort();
	}, 100);

	const result = await command;
	const elapsedMs = Date.now() - startedAt;

	assert.equal(result.aborted, true);
	assert.equal(result.timedOut, false);
	assert.ok(elapsedMs < 4_000, `Expected aborted command to stop quickly, received ${elapsedMs}ms`);
});
