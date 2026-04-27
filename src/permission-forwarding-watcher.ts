import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";

import { toRecord } from "./config-store.ts";
import { getErrorMessage } from "./logging.ts";

export type PermissionForwardingSource = "primary" | "legacy";
export type ForwardedPermissionResolutionReason = "request_removed" | "watch_disabled" | "watcher_stopped";

const AGENT_DIR = getAgentDir();
const PERMISSION_FORWARDING_ROOT_DIR = join(AGENT_DIR, "sessions", "permission-forwarding");
const SESSION_FORWARDING_ROOT_DIRECTORY_NAME = "sessions";
const SESSION_FORWARDING_REQUESTS_DIRECTORY_NAME = "requests";
const SESSION_FORWARDING_RESPONSES_DIRECTORY_NAME = "responses";
const PERMISSION_FORWARDING_TIMEOUT_MS = 10 * 60 * 1000;
const SCAN_INTERVAL_MS = 1_500;

type WatchDirectoryKind = "requests" | "responses";

interface WatchDirectoryEntry {
	source: PermissionForwardingSource;
	kind: WatchDirectoryKind;
	path: string;
}

interface PermissionForwardingLocation {
	source: "primary";
	sessionId: string;
	sessionRootDir: string;
	requestsDir: string;
	responsesDir: string;
}

interface ForwardedPermissionRequestFile {
	id: string;
	createdAt: number;
	requesterSessionId: string;
	targetSessionId: string;
	requesterAgentName: string;
	message: string;
}

export interface ForwardedPermissionRequestEvent {
	source: PermissionForwardingSource;
	requestId: string;
	requesterAgentName: string | null;
	filePath: string;
}

export interface ForwardedPermissionResolutionEvent extends ForwardedPermissionRequestEvent {
	reason: ForwardedPermissionResolutionReason;
}

export interface PermissionForwardingWatcherConfig {
	enabled: boolean;
	watchLegacyPath: boolean;
	targetSessionId?: string | null;
}

interface PermissionForwardingWatcherOptions {
	onRequest: (event: ForwardedPermissionRequestEvent) => void;
	onResolve: (event: ForwardedPermissionResolutionEvent) => void;
	debugLog: (event: string, details?: Record<string, unknown>) => void;
	permissionForwardingRootDir?: string;
}

interface TrackedForwardedPermissionRequest extends ForwardedPermissionRequestEvent {
	requestKey: string;
	lastSeenAt: number;
}

function normalizePermissionForwardingSessionId(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "unknown") {
		return null;
	}

	return trimmed;
}

function encodeSessionIdForPath(sessionId: string): string {
	return encodeURIComponent(sessionId);
}

function createPermissionForwardingLocation(
	forwardingRootDir: string,
	sessionId: string,
): PermissionForwardingLocation {
	const normalizedSessionId = normalizePermissionForwardingSessionId(sessionId);
	if (!normalizedSessionId) {
		throw new Error("Permission forwarding session id must be a non-empty string.");
	}

	const sessionRootDir = join(
		forwardingRootDir,
		SESSION_FORWARDING_ROOT_DIRECTORY_NAME,
		encodeSessionIdForPath(normalizedSessionId),
	);

	return {
		source: "primary",
		sessionId: normalizedSessionId,
		sessionRootDir,
		requestsDir: join(sessionRootDir, SESSION_FORWARDING_REQUESTS_DIRECTORY_NAME),
		responsesDir: join(sessionRootDir, SESSION_FORWARDING_RESPONSES_DIRECTORY_NAME),
	};
}

function isForwardedPermissionRequestForSession(
	request: Pick<ForwardedPermissionRequestFile, "targetSessionId">,
	sessionId: string | null | undefined,
): boolean {
	const normalizedRequestSessionId = normalizePermissionForwardingSessionId(request.targetSessionId);
	const normalizedSessionId = normalizePermissionForwardingSessionId(sessionId);
	return normalizedRequestSessionId !== null && normalizedRequestSessionId === normalizedSessionId;
}

function normalizeAgentName(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function readJsonFromFile(filePath: string): Record<string, unknown> | null {
	const raw = readFileSync(filePath, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	return toRecord(parsed);
}

function readForwardedPermissionRequestFile(filePath: string): ForwardedPermissionRequestFile | null {
	const record = readJsonFromFile(filePath);
	if (!record) {
		return null;
	}

	if (
		typeof record.id !== "string"
		|| typeof record.createdAt !== "number"
		|| !Number.isFinite(record.createdAt)
		|| typeof record.requesterSessionId !== "string"
		|| typeof record.targetSessionId !== "string"
		|| typeof record.requesterAgentName !== "string"
		|| typeof record.message !== "string"
	) {
		return null;
	}

	const id = record.id.trim();
	if (id.length === 0) {
		return null;
	}

	return {
		id,
		createdAt: record.createdAt,
		requesterSessionId: record.requesterSessionId,
		targetSessionId: record.targetSessionId,
		requesterAgentName: record.requesterAgentName,
		message: record.message,
	};
}

function isRequestStale(request: Pick<ForwardedPermissionRequestFile, "createdAt">, now: number): boolean {
	return now - request.createdAt >= PERMISSION_FORWARDING_TIMEOUT_MS;
}

function isRequestFileNameValid(filePath: string, requestId: string): boolean {
	return basename(filePath) === `${requestId}.json`;
}

function getWatcherKey(directory: WatchDirectoryEntry): string {
	return `${directory.source}:${directory.kind}`;
}

export class PermissionForwardingWatcher {
	private readonly onRequest: PermissionForwardingWatcherOptions["onRequest"];
	private readonly onResolve: PermissionForwardingWatcherOptions["onResolve"];
	private readonly debugLog: PermissionForwardingWatcherOptions["debugLog"];
	private readonly permissionForwardingRootDir: string;
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly activeRequests = new Map<string, TrackedForwardedPermissionRequest>();
	private readonly parseFailureCountByFile = new Map<string, number>();
	private readonly missingDirectoryLogged = new Set<string>();
	private legacyPathWarningLogged = false;
	private scanTimer: NodeJS.Timeout | null = null;
	private scanQueued = false;
	private config: PermissionForwardingWatcherConfig = {
		enabled: true,
		watchLegacyPath: true,
		targetSessionId: null,
	};

	public constructor(options: PermissionForwardingWatcherOptions) {
		this.onRequest = options.onRequest;
		this.onResolve = options.onResolve;
		this.debugLog = options.debugLog;
		this.permissionForwardingRootDir = options.permissionForwardingRootDir ?? PERMISSION_FORWARDING_ROOT_DIR;
	}

	public start(config: PermissionForwardingWatcherConfig): void {
		const previousSessionId = normalizePermissionForwardingSessionId(this.config.targetSessionId);
		this.config = config;
		const currentSessionId = normalizePermissionForwardingSessionId(config.targetSessionId);
		if (!config.enabled || !currentSessionId) {
			this.deactivate("watch_disabled");
			return;
		}
		if (previousSessionId && previousSessionId !== currentSessionId) {
			this.closeAllWatchers();
			this.resolveTrackedRequests("watch_disabled");
		}

		this.logLegacyPathIgnoredIfNeeded();
		this.ensureWatchers();
		this.scan("startup");
		if (!this.scanTimer) {
			this.scanTimer = setInterval(() => {
				this.ensureWatchers();
				this.queueScan("interval");
			}, SCAN_INTERVAL_MS);
			this.scanTimer.unref?.();
		}
	}

	public updateConfig(config: PermissionForwardingWatcherConfig): void {
		this.start(config);
	}

	public stop(): void {
		this.closeAllWatchers();
		this.clearScanTimer();
		this.resolveTrackedRequests("watcher_stopped");
	}

	private deactivate(reason: ForwardedPermissionResolutionReason): void {
		this.closeAllWatchers();
		this.clearScanTimer();
		this.resolveTrackedRequests(reason);
	}

	private clearScanTimer(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = null;
		}
	}

	private queueScan(reason: string): void {
		if (this.scanQueued || !this.config.enabled || !normalizePermissionForwardingSessionId(this.config.targetSessionId)) {
			return;
		}
		this.scanQueued = true;
		setTimeout(() => {
			this.scanQueued = false;
			this.scan(reason);
		}, 40);
	}

	private getLocation(): PermissionForwardingLocation | null {
		const sessionId = normalizePermissionForwardingSessionId(this.config.targetSessionId);
		if (!sessionId) {
			return null;
		}

		try {
			return createPermissionForwardingLocation(this.permissionForwardingRootDir, sessionId);
		} catch (error) {
			this.debugLog("permission_forwarding.watcher.invalid_session", {
				error: getErrorMessage(error),
			});
			return null;
		}
	}

	private getDirectories(): WatchDirectoryEntry[] {
		const location = this.getLocation();
		if (!location) {
			return [];
		}

		return [
			{
				source: location.source,
				kind: "requests",
				path: location.requestsDir,
			},
			{
				source: location.source,
				kind: "responses",
				path: location.responsesDir,
			},
		];
	}

	private logLegacyPathIgnoredIfNeeded(): void {
		if (!this.config.watchLegacyPath || this.legacyPathWarningLogged) {
			return;
		}
		this.legacyPathWarningLogged = true;
		this.debugLog("permission_forwarding.watcher.legacy_path_ignored", {
			reason: "legacy forwarding paths are not session-scoped and cannot prove a current pending permission request",
		});
	}

	private ensureWatchers(): void {
		const directories = this.getDirectories();
		const expectedWatcherKeys = new Set(directories.map(getWatcherKey));
		for (const watcherKey of this.watchers.keys()) {
			if (!expectedWatcherKeys.has(watcherKey)) {
				this.closeWatcher(watcherKey);
			}
		}

		for (const directory of directories) {
			const watcherKey = getWatcherKey(directory);
			if (!existsSync(directory.path)) {
				if (!this.missingDirectoryLogged.has(directory.path)) {
					this.missingDirectoryLogged.add(directory.path);
					this.debugLog("permission_forwarding.watcher.directory_missing", {
						source: directory.source,
						kind: directory.kind,
						path: directory.path,
					});
				}
				this.closeWatcher(watcherKey);
				continue;
			}

			this.missingDirectoryLogged.delete(directory.path);
			if (this.watchers.has(watcherKey)) {
				continue;
			}

			try {
				const watcher = watch(directory.path, { persistent: false }, () => {
					this.queueScan(`watch:${directory.source}:${directory.kind}`);
				});
				watcher.on("error", (error) => {
					this.debugLog("permission_forwarding.watcher.error", {
						source: directory.source,
						kind: directory.kind,
						path: directory.path,
						error: getErrorMessage(error),
					});
					this.closeWatcher(watcherKey);
				});
				this.watchers.set(watcherKey, watcher);
				this.debugLog("permission_forwarding.watcher.started", {
					source: directory.source,
					kind: directory.kind,
					path: directory.path,
				});
			} catch (error) {
				this.debugLog("permission_forwarding.watcher.start_failed", {
					source: directory.source,
					kind: directory.kind,
					path: directory.path,
					error: getErrorMessage(error),
				});
			}
		}
	}

	private closeWatcher(watcherKey: string): void {
		const watcher = this.watchers.get(watcherKey);
		if (!watcher) {
			return;
		}
		try {
			watcher.close();
		} catch (error) {
			this.debugLog("permission_forwarding.watcher.close_failed", {
				watcherKey,
				error: getErrorMessage(error),
			});
		}
		this.watchers.delete(watcherKey);
	}

	private closeAllWatchers(): void {
		for (const watcherKey of [...this.watchers.keys()]) {
			this.closeWatcher(watcherKey);
		}
	}

	private scan(reason: string): void {
		if (!this.config.enabled) {
			return;
		}

		const location = this.getLocation();
		if (!location) {
			return;
		}

		const seenRequestKeys = new Set<string>();
		let hasAuthoritativeRequestState = false;
		if (!existsSync(location.requestsDir)) {
			hasAuthoritativeRequestState = true;
			this.resolveMissingRequests(seenRequestKeys, new Set([location.source]));
			return;
		}

		let fileNames: string[] = [];
		try {
			fileNames = readdirSync(location.requestsDir);
			hasAuthoritativeRequestState = true;
		} catch (error) {
			this.debugLog("permission_forwarding.scan.read_dir_failed", {
				reason,
				source: location.source,
				path: location.requestsDir,
				error: getErrorMessage(error),
			});
		}

		for (const fileName of fileNames) {
			if (!fileName.endsWith(".json")) {
				continue;
			}
			const filePath = join(location.requestsDir, fileName);
			this.processRequestFile(filePath, location, seenRequestKeys);
		}

		if (hasAuthoritativeRequestState) {
			this.resolveMissingRequests(seenRequestKeys, new Set([location.source]));
		}
	}

	private processRequestFile(
		filePath: string,
		location: PermissionForwardingLocation,
		seenRequestKeys: Set<string>,
	): void {
		let request: ForwardedPermissionRequestFile | null;
		try {
			request = readForwardedPermissionRequestFile(filePath);
		} catch (error) {
			const attemptCount = (this.parseFailureCountByFile.get(filePath) ?? 0) + 1;
			this.parseFailureCountByFile.set(filePath, attemptCount);
			if (attemptCount === 1 || attemptCount % 10 === 0) {
				this.debugLog("permission_forwarding.scan.read_or_parse_failed", {
					source: location.source,
					filePath,
					attemptCount,
					error: getErrorMessage(error),
				});
			}
			return;
		}

		this.parseFailureCountByFile.delete(filePath);
		if (!request) {
			this.debugLog("permission_forwarding.scan.invalid_request_ignored", {
				source: location.source,
				filePath,
			});
			return;
		}

		const requestKey = `${location.source}:${request.id}`;
		if (!isRequestFileNameValid(filePath, request.id)) {
			this.debugLog("permission_forwarding.scan.invalid_request_file_name_ignored", {
				source: location.source,
				requestId: request.id,
				filePath,
			});
			return;
		}

		if (!isForwardedPermissionRequestForSession(request, location.sessionId)) {
			this.debugLog("permission_forwarding.scan.foreign_request_ignored", {
				source: location.source,
				requestId: request.id,
				targetSessionId: request.targetSessionId,
				currentSessionId: location.sessionId,
				filePath,
			});
			return;
		}

		const now = Date.now();
		if (isRequestStale(request, now)) {
			this.debugLog("permission_forwarding.scan.stale_request_ignored", {
				source: location.source,
				requestId: request.id,
				createdAt: request.createdAt,
				ageMs: now - request.createdAt,
				filePath,
			});
			return;
		}

		const responsePath = join(location.responsesDir, `${request.id}.json`);
		if (existsSync(responsePath)) {
			this.debugLog("permission_forwarding.scan.resolved_request_ignored", {
				source: location.source,
				requestId: request.id,
				filePath,
				responsePath,
			});
			return;
		}

		seenRequestKeys.add(requestKey);
		const requesterAgentName = normalizeAgentName(request.requesterAgentName);
		const tracked = this.activeRequests.get(requestKey);
		if (tracked) {
			tracked.filePath = filePath;
			tracked.requesterAgentName = requesterAgentName;
			tracked.lastSeenAt = now;
			return;
		}

		const next: TrackedForwardedPermissionRequest = {
			requestKey,
			source: location.source,
			requestId: request.id,
			requesterAgentName,
			filePath,
			lastSeenAt: now,
		};
		this.activeRequests.set(requestKey, next);
		this.onRequest({
			source: location.source,
			requestId: request.id,
			requesterAgentName,
			filePath,
		});
	}

	private resolveMissingRequests(
		seenRequestKeys: ReadonlySet<string>,
		watchedSources: ReadonlySet<PermissionForwardingSource>,
	): void {
		for (const [requestKey, request] of this.activeRequests.entries()) {
			if (!watchedSources.has(request.source) || seenRequestKeys.has(requestKey)) {
				continue;
			}
			this.activeRequests.delete(requestKey);
			this.emitResolution(request, "request_removed");
		}
	}

	private resolveTrackedRequests(reason: ForwardedPermissionResolutionReason): void {
		for (const request of this.activeRequests.values()) {
			this.emitResolution(request, reason);
		}
		this.activeRequests.clear();
	}

	private emitResolution(
		request: ForwardedPermissionRequestEvent,
		reason: ForwardedPermissionResolutionReason,
	): void {
		this.debugLog("permission_forwarding.request_resolved", {
			source: request.source,
			requestId: request.requestId,
			filePath: request.filePath,
			reason,
		});
		this.onResolve({
			source: request.source,
			requestId: request.requestId,
			requesterAgentName: request.requesterAgentName,
			filePath: request.filePath,
			reason,
		});
	}
}
