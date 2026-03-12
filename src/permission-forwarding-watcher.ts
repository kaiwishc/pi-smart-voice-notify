import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getErrorMessage } from "./logging.ts";
import { toRecord } from "./config-store.ts";

export type PermissionForwardingSource = "primary" | "legacy";
export type ForwardedPermissionResolutionReason = "request_removed" | "watch_disabled" | "watcher_stopped";

const PRIMARY_REQUESTS_DIR = join(homedir(), ".pi", "agent", "sessions", "permission-forwarding", "requests");
const LEGACY_REQUESTS_DIR = join(homedir(), ".pi", "agent", "permission-forwarding", "requests");
const SCAN_INTERVAL_MS = 1_500;

interface WatchDirectoryEntry {
	source: PermissionForwardingSource;
	path: string;
}

const PRIMARY_DIRECTORY: WatchDirectoryEntry = {
	source: "primary",
	path: PRIMARY_REQUESTS_DIR,
};

const LEGACY_DIRECTORY: WatchDirectoryEntry = {
	source: "legacy",
	path: LEGACY_REQUESTS_DIR,
};

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
}

interface PermissionForwardingWatcherOptions {
	onRequest: (event: ForwardedPermissionRequestEvent) => void;
	onResolve: (event: ForwardedPermissionResolutionEvent) => void;
	debugLog: (event: string, details?: Record<string, unknown>) => void;
}

interface TrackedForwardedPermissionRequest extends ForwardedPermissionRequestEvent {
	requestKey: string;
	lastSeenAt: number;
}

function normalizeRequestId(value: unknown, filePath: string): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return `file:${filePath}`;
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

export class PermissionForwardingWatcher {
	private readonly onRequest: PermissionForwardingWatcherOptions["onRequest"];
	private readonly onResolve: PermissionForwardingWatcherOptions["onResolve"];
	private readonly debugLog: PermissionForwardingWatcherOptions["debugLog"];
	private readonly watchers = new Map<PermissionForwardingSource, FSWatcher>();
	private readonly activeRequests = new Map<string, TrackedForwardedPermissionRequest>();
	private readonly parseFailureCountByFile = new Map<string, number>();
	private readonly missingDirectoryLogged = new Set<string>();
	private scanTimer: NodeJS.Timeout | null = null;
	private scanQueued = false;
	private config: PermissionForwardingWatcherConfig = {
		enabled: true,
		watchLegacyPath: true,
	};

	public constructor(options: PermissionForwardingWatcherOptions) {
		this.onRequest = options.onRequest;
		this.onResolve = options.onResolve;
		this.debugLog = options.debugLog;
	}

	public start(config: PermissionForwardingWatcherConfig): void {
		this.config = config;
		if (!config.enabled) {
			this.stop();
			return;
		}

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
		const previousWatchLegacyPath = this.config.watchLegacyPath;
		this.config = config;
		if (!config.enabled) {
			this.stop();
			return;
		}

		if (previousWatchLegacyPath && !config.watchLegacyPath) {
			this.resolveRequestsForSource("legacy", "watch_disabled");
		}
		this.ensureWatchers();
		this.queueScan("config_update");
	}

	public stop(): void {
		for (const [source, watcher] of this.watchers.entries()) {
			try {
				watcher.close();
			} catch (error) {
				this.debugLog("permission_forwarding.watcher.close_failed", {
					source,
					error: getErrorMessage(error),
				});
			}
		}
		this.watchers.clear();
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = null;
		}
		this.resolveTrackedRequests("watcher_stopped");
	}

	private queueScan(reason: string): void {
		if (this.scanQueued || !this.config.enabled) {
			return;
		}
		this.scanQueued = true;
		setTimeout(() => {
			this.scanQueued = false;
			this.scan(reason);
		}, 40);
	}

	private getDirectories(): WatchDirectoryEntry[] {
		const directories = [PRIMARY_DIRECTORY];
		if (this.config.watchLegacyPath) {
			directories.push(LEGACY_DIRECTORY);
		}
		return directories;
	}

	private ensureWatchers(): void {
		for (const directory of this.getDirectories()) {
			if (!existsSync(directory.path)) {
				if (!this.missingDirectoryLogged.has(directory.path)) {
					this.missingDirectoryLogged.add(directory.path);
					this.debugLog("permission_forwarding.watcher.directory_missing", {
						source: directory.source,
						path: directory.path,
					});
				}
				this.closeWatcher(directory.source);
				continue;
			}

			this.missingDirectoryLogged.delete(directory.path);
			if (this.watchers.has(directory.source)) {
				continue;
			}

			try {
				const watcher = watch(directory.path, { persistent: false }, () => {
					this.queueScan(`watch:${directory.source}`);
				});
				watcher.on("error", (error) => {
					this.debugLog("permission_forwarding.watcher.error", {
						source: directory.source,
						path: directory.path,
						error: getErrorMessage(error),
					});
					this.closeWatcher(directory.source);
				});
				this.watchers.set(directory.source, watcher);
				this.debugLog("permission_forwarding.watcher.started", {
					source: directory.source,
					path: directory.path,
				});
			} catch (error) {
				this.debugLog("permission_forwarding.watcher.start_failed", {
					source: directory.source,
					path: directory.path,
					error: getErrorMessage(error),
				});
			}
		}

		if (!this.config.watchLegacyPath) {
			this.closeWatcher("legacy");
		}
	}

	private closeWatcher(source: PermissionForwardingSource): void {
		const watcher = this.watchers.get(source);
		if (!watcher) {
			return;
		}
		try {
			watcher.close();
		} catch (error) {
			this.debugLog("permission_forwarding.watcher.close_failed", {
				source,
				error: getErrorMessage(error),
			});
		}
		this.watchers.delete(source);
	}

	private scan(reason: string): void {
		if (!this.config.enabled) {
			return;
		}

		const seenRequestKeys = new Set<string>();
		const watchedSources = new Set(this.getDirectories().map((directory) => directory.source));
		for (const directory of this.getDirectories()) {
			if (!existsSync(directory.path)) {
				continue;
			}

			let fileNames: string[] = [];
			try {
				fileNames = readdirSync(directory.path);
			} catch (error) {
				this.debugLog("permission_forwarding.scan.read_dir_failed", {
					reason,
					source: directory.source,
					path: directory.path,
					error: getErrorMessage(error),
				});
				continue;
			}

			for (const fileName of fileNames) {
				if (!fileName.endsWith(".json")) {
					continue;
				}
				const filePath = join(directory.path, fileName);
				this.processRequestFile(filePath, directory.source, seenRequestKeys);
			}
		}

		this.resolveMissingRequests(seenRequestKeys, watchedSources);
	}

	private processRequestFile(
		filePath: string,
		source: PermissionForwardingSource,
		seenRequestKeys: Set<string>,
	): void {
		let record: Record<string, unknown>;
		try {
			record = readJsonFromFile(filePath) ?? {};
		} catch (error) {
			const attemptCount = (this.parseFailureCountByFile.get(filePath) ?? 0) + 1;
			this.parseFailureCountByFile.set(filePath, attemptCount);
			if (attemptCount === 1 || attemptCount % 10 === 0) {
				this.debugLog("permission_forwarding.scan.read_or_parse_failed", {
					source,
					filePath,
					attemptCount,
					error: getErrorMessage(error),
				});
			}
			return;
		}

		this.parseFailureCountByFile.delete(filePath);
		const requestId = normalizeRequestId(record.id, filePath);
		const requestKey = `${source}:${requestId}`;
		seenRequestKeys.add(requestKey);

		const requesterAgentName = normalizeAgentName(record.requesterAgentName);
		const tracked = this.activeRequests.get(requestKey);
		if (tracked) {
			tracked.filePath = filePath;
			tracked.requesterAgentName = requesterAgentName;
			tracked.lastSeenAt = Date.now();
			return;
		}

		const next: TrackedForwardedPermissionRequest = {
			requestKey,
			source,
			requestId,
			requesterAgentName,
			filePath,
			lastSeenAt: Date.now(),
		};
		this.activeRequests.set(requestKey, next);
		this.onRequest({
			source,
			requestId,
			requesterAgentName,
			filePath,
		});
	}

	private resolveMissingRequests(
		seenRequestKeys: ReadonlySet<string>,
		watchedSources: ReadonlySet<PermissionForwardingSource>,
	): void {
		for (const [requestKey, request] of this.activeRequests.entries()) {
			if (!watchedSources.has(request.source) || seenRequestKeys.has(requestKey) || existsSync(request.filePath)) {
				continue;
			}
			this.activeRequests.delete(requestKey);
			this.emitResolution(request, "request_removed");
		}
	}

	private resolveRequestsForSource(source: PermissionForwardingSource, reason: ForwardedPermissionResolutionReason): void {
		for (const [requestKey, request] of this.activeRequests.entries()) {
			if (request.source !== source) {
				continue;
			}
			this.activeRequests.delete(requestKey);
			this.emitResolution(request, reason);
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
