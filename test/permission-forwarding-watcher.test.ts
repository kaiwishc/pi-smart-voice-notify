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

interface WatcherHarness {
	rootDir: string;
	requests: ForwardedPermissionRequestEvent[];
	resolutions: ForwardedPermissionResolutionEvent[];
	watcher: PermissionForwardingWatcher;
	cleanup: () => void;
}

function createWatcherHarness(rootDir: string): WatcherHarness {
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
	const cleanup = (): void => {
		watcher.stop();
		rmSync(rootDir, { recursive: true, force: true });
	};
	return { rootDir, requests, resolutions, watcher, cleanup };
}

/**
 * Stop a watcher and remove its temp root dir. Used by tests that create a
 * custom watcher (with a debugLog handler) instead of createWatcherHarness.
 */
function cleanupForwardingRoot(watcher: { stop: () => void }, rootDir: string): void {
	watcher.stop();
	rmSync(rootDir, { recursive: true, force: true });
}

/**
 * Shared config object for watcher startWatching calls in fallback and
 * resolution tests.
 */
function watcherConfig(sessionId: string): {
	enabled: true;
	watchLegacyPath: false;
	targetSessionId: string;
} {
	return { enabled: true, watchLegacyPath: false, targetSessionId: sessionId };
}

/**
 * Create an isolated forwarding root with optional session directories and a
 * watcher harness. Returns the harness plus a cleanup function that stops the
 * watcher and removes the temp dir. When `ensureDirs` is false, session
 * directories are not created, which causes the watcher to enable interval
 * fallback.
 */
function createForwardingHarness(
	sessionId: string,
	options: { ensureDirs?: boolean } = {},
): WatcherHarness {
	const { ensureDirs = true } = options;
	const rootDir = createTempForwardingRoot();
	if (ensureDirs) {
		ensureSessionDirectories(rootDir, sessionId);
	}
	return createWatcherHarness(rootDir);
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

	const { requests, resolutions, watcher, cleanup } = createWatcherHarness(rootDir);
	try {
		watcher.startWatching({ enabled: true, watchLegacyPath: true, targetSessionId: currentSessionId });

		assert.deepEqual(requests.map((event) => event.requestId), ["valid-current"]);
		assert.equal(requests[0]?.source, "primary");
		assert.equal(requests[0]?.requesterAgentName, "Delegate Alpha");
		assert.equal(resolutions.length, 0);
	} finally {
		cleanup();
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
			watcher.startWatching(config);
		}

		const parseFailureCountByFile = (watcher as unknown as { parseFailureCountByFile: Map<string, number> }).parseFailureCountByFile;
		assert.equal(parseFailureCountByFile.get(corruptPath), 50);
		assert.equal(debugEvents.some((details) => details?.attemptCount === 50), true);

		unlinkSync(corruptPath);
		watcher.startWatching(config);
		assert.equal(parseFailureCountByFile.has(corruptPath), false);
	} finally {
		cleanupForwardingRoot(watcher, rootDir);
	}
});

/**
 * Run a test body against a forwarding watcher harness, ensuring cleanup runs
 * in a finally block. Used by the interval-fallback tests that share the same
 * try/finally/cleanup structure.
 */
function runWithCleanup(
	harness: WatcherHarness,
	body: (watcher: PermissionForwardingWatcher) => void,
): void {
	try {
		body(harness.watcher);
	} finally {
		harness.cleanup();
	}
}

/**
 * Run a fallback-timer test: start watching with the given harness and assert
 * whether the fallback scan timer is active.
 */
function assertFallbackTimer(harness: WatcherHarness, expectActive: boolean): void {
	runWithCleanup(harness, (watcher) => {
		watcher.startWatching(watcherConfig("parent-session"));
		const timer = (watcher as unknown as { fallbackScanTimer: NodeJS.Timeout | null }).fallbackScanTimer;
		if (expectActive) {
			assert.notEqual(timer, null);
		} else {
			assert.equal(timer, null);
		}
	});
}

test("permission forwarding watcher keeps interval fallback disabled when required fs watchers are active", () => {
	assertFallbackTimer(createForwardingHarness("parent-session"), false);
});

test("permission forwarding watcher enables interval fallback while request directories cannot be watched", () => {
	assertFallbackTimer(createForwardingHarness("parent-session", { ensureDirs: false }), true);
});

test("permission forwarding watcher resolves tracked requests when they are no longer pending", () => {
	const { rootDir, requests, resolutions, watcher, cleanup } = createForwardingHarness("parent-session");
	try {
		const removedPath = writeRequest(rootDir, "parent-session", createRequestFixture("removed-current", "parent-session"));
		const config = watcherConfig("parent-session");
		watcher.startWatching(config);
		assert.deepEqual(requests.map((event) => event.requestId), ["removed-current"]);

		unlinkSync(removedPath);
		watcher.startWatching(config);
		assert.deepEqual(resolutions.map((event) => event.requestId), ["removed-current"]);
		assert.equal(resolutions[0]?.reason, "request_removed");

		writeRequest(rootDir, "parent-session", createRequestFixture("responded-current", "parent-session"));
		watcher.startWatching(config);
		assert.deepEqual(requests.map((event) => event.requestId), ["removed-current", "responded-current"]);

		writeJson(join(responsesDirectory(rootDir, "parent-session"), "responded-current.json"), {
			approved: false,
			state: "denied",
			responderSessionId: "parent-session",
			respondedAt: Date.now(),
		});
		watcher.startWatching(config);
		assert.deepEqual(resolutions.map((event) => event.requestId), ["removed-current", "responded-current"]);
		assert.equal(resolutions[1]?.reason, "request_removed");
	} finally {
		cleanup();
	}
});
