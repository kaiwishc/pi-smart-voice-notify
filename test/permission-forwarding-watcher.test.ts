import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	PermissionForwardingWatcher,
	type ForwardedPermissionRequestEvent,
	type ForwardedPermissionResolutionEvent,
} from "../src/permission-forwarding-watcher.ts";

const PERMISSION_FORWARDING_TIMEOUT_MS = 10 * 60 * 1000;

interface ForwardedPermissionRequestFixture {
	id: string;
	createdAt: number;
	requesterSessionId: string;
	targetSessionId: string;
	requesterAgentName: string;
	message: string;
}

function createTempForwardingRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-smart-voice-forwarding-"));
}

function sessionDirectory(rootDir: string, sessionId: string): string {
	return join(rootDir, "sessions", encodeURIComponent(sessionId));
}

function requestsDirectory(rootDir: string, sessionId: string): string {
	return join(sessionDirectory(rootDir, sessionId), "requests");
}

function responsesDirectory(rootDir: string, sessionId: string): string {
	return join(sessionDirectory(rootDir, sessionId), "responses");
}

function ensureSessionDirectories(rootDir: string, sessionId: string): void {
	mkdirSync(requestsDirectory(rootDir, sessionId), { recursive: true });
	mkdirSync(responsesDirectory(rootDir, sessionId), { recursive: true });
}

function createRequestFixture(
	id: string,
	targetSessionId: string,
	overrides: Partial<ForwardedPermissionRequestFixture> = {},
): ForwardedPermissionRequestFixture {
	return {
		id,
		createdAt: Date.now(),
		requesterSessionId: "child-session",
		targetSessionId,
		requesterAgentName: "Delegate Alpha",
		message: "Allow delegated write?",
		...overrides,
	};
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

function writeRequest(
	rootDir: string,
	sessionId: string,
	request: ForwardedPermissionRequestFixture,
): string {
	const filePath = join(requestsDirectory(rootDir, sessionId), `${request.id}.json`);
	writeJson(filePath, request);
	return filePath;
}

function createWatcherHarness(rootDir: string): {
	requests: ForwardedPermissionRequestEvent[];
	resolutions: ForwardedPermissionResolutionEvent[];
	watcher: PermissionForwardingWatcher;
} {
	const requests: ForwardedPermissionRequestEvent[] = [];
	const resolutions: ForwardedPermissionResolutionEvent[] = [];
	const watcher = new PermissionForwardingWatcher({
		permissionForwardingRootDir: rootDir,
		onRequest: (event) => {
			requests.push(event);
		},
		onResolve: (event) => {
			resolutions.push(event);
		},
		debugLog: () => {
		},
	});
	return { requests, resolutions, watcher };
}

test("permission forwarding watcher only emits valid current-session pending requests", () => {
	const rootDir = createTempForwardingRoot();
	const currentSessionId = "parent session/current";
	const foreignSessionId = "other-session";
	ensureSessionDirectories(rootDir, currentSessionId);
	ensureSessionDirectories(rootDir, foreignSessionId);
	mkdirSync(join(rootDir, "requests"), { recursive: true });

	writeRequest(rootDir, currentSessionId, createRequestFixture("valid-current", currentSessionId));
	writeRequest(rootDir, currentSessionId, createRequestFixture("foreign-target", foreignSessionId));
	writeRequest(
		rootDir,
		currentSessionId,
		createRequestFixture("stale-current", currentSessionId, {
			createdAt: Date.now() - PERMISSION_FORWARDING_TIMEOUT_MS - 1,
		}),
	);
	writeJson(join(requestsDirectory(rootDir, currentSessionId), "malformed.json"), {
		id: "malformed-current",
		targetSessionId: currentSessionId,
	});
	writeJson(
		join(requestsDirectory(rootDir, currentSessionId), "mismatched-file-name.json"),
		createRequestFixture("mismatched-contract-id", currentSessionId),
	);
	writeFileSync(join(requestsDirectory(rootDir, currentSessionId), "broken.json"), "{", "utf-8");
	writeRequest(rootDir, currentSessionId, createRequestFixture("resolved-current", currentSessionId));
	writeJson(join(responsesDirectory(rootDir, currentSessionId), "resolved-current.json"), {
		approved: true,
		state: "approved",
		responderSessionId: currentSessionId,
		respondedAt: Date.now(),
	});
	writeRequest(rootDir, foreignSessionId, createRequestFixture("foreign-directory", foreignSessionId));
	writeJson(join(rootDir, "requests", "legacy-current.json"), createRequestFixture("legacy-current", currentSessionId));

	const { requests, resolutions, watcher } = createWatcherHarness(rootDir);
	try {
		watcher.start({ enabled: true, watchLegacyPath: true, targetSessionId: currentSessionId });

		assert.deepEqual(requests.map((event) => event.requestId), ["valid-current"]);
		assert.equal(requests[0]?.source, "primary");
		assert.equal(requests[0]?.requesterAgentName, "Delegate Alpha");
		assert.equal(resolutions.length, 0);
	} finally {
		watcher.stop();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("permission forwarding watcher caps parse failure counts and evicts removed corrupted files", () => {
	const rootDir = createTempForwardingRoot();
	const currentSessionId = "parent-session";
	ensureSessionDirectories(rootDir, currentSessionId);
	const corruptPath = join(requestsDirectory(rootDir, currentSessionId), "broken.json");
	writeFileSync(corruptPath, "{", "utf-8");

	const debugEvents: Array<Record<string, unknown> | undefined> = [];
	const watcher = new PermissionForwardingWatcher({
		permissionForwardingRootDir: rootDir,
		onRequest: () => undefined,
		onResolve: () => undefined,
		debugLog: (_event, details) => {
			debugEvents.push(details);
		},
	});
	try {
		const config = { enabled: true, watchLegacyPath: false, targetSessionId: currentSessionId };
		for (let index = 0; index < 60; index += 1) {
			watcher.start(config);
		}

		const parseFailureCountByFile = (watcher as unknown as { parseFailureCountByFile: Map<string, number> }).parseFailureCountByFile;
		assert.equal(parseFailureCountByFile.get(corruptPath), 50);
		assert.equal(debugEvents.some((details) => details?.attemptCount === 50), true);

		unlinkSync(corruptPath);
		watcher.start(config);
		assert.equal(parseFailureCountByFile.has(corruptPath), false);
	} finally {
		watcher.stop();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("permission forwarding watcher keeps interval fallback disabled when required fs watchers are active", () => {
	const rootDir = createTempForwardingRoot();
	const currentSessionId = "parent-session";
	ensureSessionDirectories(rootDir, currentSessionId);

	const { watcher } = createWatcherHarness(rootDir);
	try {
		watcher.start({ enabled: true, watchLegacyPath: false, targetSessionId: currentSessionId });
		assert.equal((watcher as unknown as { fallbackScanTimer: NodeJS.Timeout | null }).fallbackScanTimer, null);
	} finally {
		watcher.stop();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("permission forwarding watcher enables interval fallback while request directories cannot be watched", () => {
	const rootDir = createTempForwardingRoot();
	const currentSessionId = "parent-session";

	const { watcher } = createWatcherHarness(rootDir);
	try {
		watcher.start({ enabled: true, watchLegacyPath: false, targetSessionId: currentSessionId });
		assert.notEqual((watcher as unknown as { fallbackScanTimer: NodeJS.Timeout | null }).fallbackScanTimer, null);
	} finally {
		watcher.stop();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("permission forwarding watcher resolves tracked requests when they are no longer pending", () => {
	const rootDir = createTempForwardingRoot();
	const currentSessionId = "parent-session";
	ensureSessionDirectories(rootDir, currentSessionId);

	const removedPath = writeRequest(rootDir, currentSessionId, createRequestFixture("removed-current", currentSessionId));
	const { requests, resolutions, watcher } = createWatcherHarness(rootDir);
	try {
		const config = { enabled: true, watchLegacyPath: false, targetSessionId: currentSessionId };
		watcher.start(config);
		assert.deepEqual(requests.map((event) => event.requestId), ["removed-current"]);

		unlinkSync(removedPath);
		watcher.start(config);
		assert.deepEqual(resolutions.map((event) => event.requestId), ["removed-current"]);
		assert.equal(resolutions[0]?.reason, "request_removed");

		writeRequest(rootDir, currentSessionId, createRequestFixture("responded-current", currentSessionId));
		watcher.start(config);
		assert.deepEqual(requests.map((event) => event.requestId), ["removed-current", "responded-current"]);

		writeJson(join(responsesDirectory(rootDir, currentSessionId), "responded-current.json"), {
			approved: false,
			state: "denied",
			responderSessionId: currentSessionId,
			respondedAt: Date.now(),
		});
		watcher.start(config);
		assert.deepEqual(resolutions.map((event) => event.requestId), ["removed-current", "responded-current"]);
		assert.equal(resolutions[1]?.reason, "request_removed");
	} finally {
		watcher.stop();
		rmSync(rootDir, { recursive: true, force: true });
	}
});
