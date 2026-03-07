import type { NotificationType } from "./types.js";
import { getErrorMessage } from "./logging.js";

export type WebhookEventType = NotificationType | (string & {});
export type WebhookProvider = "discord" | "generic";

type MentionValue = string | boolean;

export interface DiscordEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

export interface WebhookEvent {
	type: WebhookEventType;
	title: string;
	message: string;
	projectName?: string;
	sessionId?: string;
	count?: number;
	mention?: MentionValue;
	metadata?: Record<string, unknown>;
	payload?: unknown;
}

export interface WebhookTargetConfig {
	provider?: WebhookProvider;
	url: string;
	enabled?: boolean;
	events?: string[];
	headers?: Record<string, string>;
	mention?: MentionValue;
	username?: string;
	avatarUrl?: string;
}

export interface WebhookConfig {
	enabled?: boolean;
	discordWebhookUrl?: string;
	genericWebhookUrl?: string;
	targets?: WebhookTargetConfig[];
	eventTriggers?: Partial<Record<string, boolean>>;
	eventAllowList?: string[];
	maxQueueSize?: number;
	minIntervalMs?: number;
	maxRetries?: number;
	baseRetryDelayMs?: number;
	requestTimeoutMs?: number;
	discordMention?: MentionValue;
	discordUsername?: string;
	discordAvatarUrl?: string;
	genericHeaders?: Record<string, string>;
	logger?: (message: string, details?: Record<string, unknown>) => void;
}

export interface WebhookDispatchResult {
	queued: number;
	skipped: boolean;
}

interface ResolvedWebhookTarget {
	provider: WebhookProvider;
	url: string;
	events: string[];
	headers: Record<string, string>;
	mention?: MentionValue;
	username?: string;
	avatarUrl?: string;
}

interface ResolvedWebhookConfig {
	enabled: boolean;
	targets: ResolvedWebhookTarget[];
	eventTriggers: Partial<Record<string, boolean>>;
	eventAllowList: string[];
	maxQueueSize: number;
	minIntervalMs: number;
	maxRetries: number;
	baseRetryDelayMs: number;
	requestTimeoutMs: number;
	discordMention?: MentionValue;
	discordUsername?: string;
	discordAvatarUrl?: string;
	logger: (message: string, details?: Record<string, unknown>) => void;
}

interface QueueItem {
	target: ResolvedWebhookTarget;
	event: WebhookEvent;
}

interface SendAttemptResult {
	success: boolean;
	statusCode?: number;
	retryAfterMs?: number;
	error?: string;
}

interface RateLimitState {
	lastSentAt: number;
	nextAllowedAt: number;
}

const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_MIN_INTERVAL_MS = 1_500;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 700;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

function defaultLogger(message: string, details: Record<string, unknown> = {}): void {
	console.warn("[pi-smart-voice-notify:webhook]", message, details);
}

const DISCORD_COLORS: Record<NotificationType | "default", number> = {
	idle: 0x2ecc71,
	permission: 0xf39c12,
	question: 0x3498db,
	error: 0xe74c3c,
	default: 0x5865f2,
};

function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (!value) {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return undefined;
}

function parseInteger(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed)) {
		return undefined;
	}
	return parsed;
}

function isValidHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

function isDiscordUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		if (!DISCORD_HOSTS.has(parsed.hostname.toLowerCase())) {
			return false;
		}
		return parsed.pathname.includes("/api/webhooks/");
	} catch {
		return false;
	}
}

function maskWebhookUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}/***`;
	} catch {
		return "<invalid-url>";
	}
}

function normalizeList(values: string[] | undefined): string[] {
	if (!values || values.length === 0) {
		return [];
	}
	const unique = new Set<string>();
	for (const value of values) {
		const normalized = value.trim().toLowerCase();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}
	return [...unique];
}

function parseEnvConfig(env: NodeJS.ProcessEnv): WebhookConfig {
	const eventListRaw = env.PI_SMART_NOTIFY_WEBHOOK_EVENTS ?? env.WEBHOOK_EVENTS;
	const eventAllowList = eventListRaw
		? eventListRaw
				.split(",")
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
		: [];

	const enabled =
		parseBoolean(env.PI_SMART_NOTIFY_WEBHOOK_ENABLED) ?? parseBoolean(env.WEBHOOK_ENABLED) ?? false;

	return {
		enabled,
		discordWebhookUrl:
			env.PI_SMART_NOTIFY_DISCORD_WEBHOOK_URL ?? env.PI_SMART_VOICE_NOTIFY_DISCORD_WEBHOOK_URL ?? env.DISCORD_WEBHOOK_URL,
		genericWebhookUrl:
			env.PI_SMART_NOTIFY_WEBHOOK_URL ?? env.PI_SMART_VOICE_NOTIFY_WEBHOOK_URL ?? env.WEBHOOK_URL,
		eventAllowList,
		minIntervalMs: parseInteger(env.PI_SMART_NOTIFY_WEBHOOK_MIN_INTERVAL_MS),
		maxRetries: parseInteger(env.PI_SMART_NOTIFY_WEBHOOK_MAX_RETRIES),
		baseRetryDelayMs: parseInteger(env.PI_SMART_NOTIFY_WEBHOOK_BASE_RETRY_DELAY_MS),
		requestTimeoutMs: parseInteger(env.PI_SMART_NOTIFY_WEBHOOK_TIMEOUT_MS),
		discordMention: env.PI_SMART_NOTIFY_DISCORD_MENTION,
		discordUsername: env.PI_SMART_NOTIFY_DISCORD_USERNAME,
		discordAvatarUrl: env.PI_SMART_NOTIFY_DISCORD_AVATAR_URL,
	};
}

function mergeHeaders(
	genericHeaders: Record<string, string> | undefined,
	targetHeaders: Record<string, string> | undefined,
): Record<string, string> {
	return {
		...(genericHeaders ?? {}),
		...(targetHeaders ?? {}),
	};
}

function resolveTargets(config: WebhookConfig): ResolvedWebhookTarget[] {
	const targets: ResolvedWebhookTarget[] = [];

	const addTarget = (target: WebhookTargetConfig): void => {
		if (target.enabled === false || !target.url || !isValidHttpUrl(target.url)) {
			return;
		}
		const provider =
			target.provider ?? (isDiscordUrl(target.url) ? "discord" : "generic");
		if (provider === "discord" && !isDiscordUrl(target.url)) {
			return;
		}
		targets.push({
			provider,
			url: target.url,
			events: normalizeList(target.events),
			headers: mergeHeaders(config.genericHeaders, target.headers),
			mention: target.mention,
			username: target.username,
			avatarUrl: target.avatarUrl,
		});
	};

	if (config.discordWebhookUrl && isValidHttpUrl(config.discordWebhookUrl)) {
		addTarget({
			provider: "discord",
			url: config.discordWebhookUrl,
			mention: config.discordMention,
			username: config.discordUsername,
			avatarUrl: config.discordAvatarUrl,
		});
	}

	if (config.genericWebhookUrl && isValidHttpUrl(config.genericWebhookUrl)) {
		addTarget({
			provider: "generic",
			url: config.genericWebhookUrl,
			headers: config.genericHeaders,
		});
	}

	for (const target of config.targets ?? []) {
		addTarget(target);
	}

	const unique = new Map<string, ResolvedWebhookTarget>();
	for (const target of targets) {
		const key = `${target.provider}:${target.url}`;
		if (!unique.has(key)) {
			unique.set(key, target);
		}
	}

	return [...unique.values()];
}

function resolveConfig(config: WebhookConfig = {}, env: NodeJS.ProcessEnv = process.env): ResolvedWebhookConfig {
	const envConfig = parseEnvConfig(env);
	const merged: WebhookConfig = {
		...envConfig,
		...config,
		eventTriggers: {
			...(envConfig.eventTriggers ?? {}),
			...(config.eventTriggers ?? {}),
		},
		genericHeaders: {
			...(envConfig.genericHeaders ?? {}),
			...(config.genericHeaders ?? {}),
		},
	};

	const maxQueueSize = Math.max(1, merged.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
	const minIntervalMs = Math.max(0, merged.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
	const maxRetries = Math.max(0, merged.maxRetries ?? DEFAULT_MAX_RETRIES);
	const baseRetryDelayMs = Math.max(100, merged.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS);
	const requestTimeoutMs = Math.max(500, merged.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

	const logger = merged.logger ?? defaultLogger;
	const targets = resolveTargets(merged);
	const isEnabled = merged.enabled === true && targets.length > 0;

	return {
		enabled: isEnabled,
		targets,
		eventTriggers: merged.eventTriggers ?? {},
		eventAllowList: normalizeList(merged.eventAllowList),
		maxQueueSize,
		minIntervalMs,
		maxRetries,
		baseRetryDelayMs,
		requestTimeoutMs,
		discordMention: merged.discordMention,
		discordUsername: merged.discordUsername,
		discordAvatarUrl: merged.discordAvatarUrl,
		logger,
	};
}

function eventColor(eventType: WebhookEventType): number {
	const normalized = eventType.toLowerCase();
	if (normalized === "idle") return DISCORD_COLORS.idle;
	if (normalized === "permission") return DISCORD_COLORS.permission;
	if (normalized === "question") return DISCORD_COLORS.question;
	if (normalized === "error") return DISCORD_COLORS.error;
	return DISCORD_COLORS.default;
}

function shouldRetry(statusCode: number | undefined): boolean {
	if (statusCode === undefined) {
		return true;
	}
	if (statusCode === 408 || statusCode === 429) {
		return true;
	}
	return statusCode >= 500;
}

function parseRetryAfterMs(value: string | null): number {
	if (!value) {
		return 0;
	}
	const numeric = Number.parseFloat(value);
	if (!Number.isFinite(numeric) || numeric <= 0) {
		return 0;
	}
	if (numeric <= 60) {
		return Math.round(numeric * 1_000);
	}
	return Math.round(numeric);
}

function buildDiscordPayload(target: ResolvedWebhookTarget, event: WebhookEvent, config: ResolvedWebhookConfig): unknown {
	const mention =
		typeof event.mention !== "undefined"
			? event.mention
			: typeof target.mention !== "undefined"
				? target.mention
				: config.discordMention;
	const mentionContent = mention === true ? "@everyone" : typeof mention === "string" ? mention : undefined;

	const fields: DiscordEmbedField[] = [];
	if (event.projectName) {
		fields.push({ name: "Project", value: event.projectName, inline: true });
	}
	if (event.sessionId) {
		fields.push({ name: "Session", value: `${event.sessionId.slice(0, 8)}...`, inline: true });
	}
	if (typeof event.count === "number" && event.count > 1) {
		fields.push({ name: "Count", value: String(event.count), inline: true });
	}

	return {
		username: target.username ?? config.discordUsername ?? "Pi Smart Notify",
		avatar_url: target.avatarUrl ?? config.discordAvatarUrl,
		content: mentionContent,
		embeds: [
			{
				title: event.title,
				description: event.message,
				color: eventColor(event.type),
				timestamp: new Date().toISOString(),
				fields: fields.length > 0 ? fields : undefined,
				footer: {
					text: "pi-smart-voice-notify",
				},
			},
		],
	};
}

function buildGenericPayload(event: WebhookEvent): unknown {
	if (typeof event.payload !== "undefined") {
		return event.payload;
	}

	return {
		event: event.type,
		title: event.title,
		message: event.message,
		projectName: event.projectName,
		sessionId: event.sessionId,
		count: event.count,
		metadata: event.metadata,
		timestamp: new Date().toISOString(),
	};
}

export class WebhookService {
	private sourceConfig: WebhookConfig;
	private config: ResolvedWebhookConfig;
	private queue: QueueItem[] = [];
	private processingQueue = false;
	private rateLimitState = new Map<string, RateLimitState>();

	constructor(config: WebhookConfig = {}) {
		this.sourceConfig = { ...config };
		this.config = resolveConfig(this.sourceConfig);
	}

	public updateConfig(config: WebhookConfig): void {
		this.sourceConfig = {
			...this.sourceConfig,
			...config,
			eventTriggers: {
				...(this.sourceConfig.eventTriggers ?? {}),
				...(config.eventTriggers ?? {}),
			},
			genericHeaders: {
				...(this.sourceConfig.genericHeaders ?? {}),
				...(config.genericHeaders ?? {}),
			},
		};
		this.config = resolveConfig(this.sourceConfig);
	}

	public isEnabled(): boolean {
		return this.config.enabled;
	}

	public dispatch(event: WebhookEvent): WebhookDispatchResult {
		if (!this.config.enabled || !this.isEventEnabled(event.type)) {
			return { queued: 0, skipped: true };
		}

		let queued = 0;
		for (const target of this.config.targets) {
			if (!this.targetAllowsEvent(target, event.type)) {
				continue;
			}
			this.enqueue({
				target,
				event,
			});
			queued += 1;
		}

		if (!this.processingQueue) {
			queueMicrotask(() => {
				void this.processQueue();
			});
		}

		return { queued, skipped: queued === 0 };
	}

	public async flush(): Promise<void> {
		await this.processQueue();
	}

	public getQueueSize(): number {
		return this.queue.length;
	}

	private enqueue(item: QueueItem): void {
		if (this.queue.length >= this.config.maxQueueSize) {
			this.queue.shift();
		}
		this.queue.push(item);
	}

	private isEventEnabled(eventType: WebhookEventType): boolean {
		const normalized = eventType.toLowerCase();
		if (this.config.eventAllowList.length > 0 && !this.config.eventAllowList.includes(normalized)) {
			return false;
		}
		const explicit = this.config.eventTriggers[normalized];
		if (explicit === false) {
			return false;
		}
		return true;
	}

	private targetAllowsEvent(target: ResolvedWebhookTarget, eventType: WebhookEventType): boolean {
		if (target.events.length === 0) {
			return true;
		}
		const normalized = eventType.toLowerCase();
		return target.events.includes("*") || target.events.includes(normalized);
	}

	private targetKey(target: ResolvedWebhookTarget): string {
		return `${target.provider}:${target.url}`;
	}

	private async waitForRateLimit(target: ResolvedWebhookTarget): Promise<void> {
		const key = this.targetKey(target);
		const state = this.rateLimitState.get(key) ?? { lastSentAt: 0, nextAllowedAt: 0 };
		const waitUntil = Math.max(state.nextAllowedAt, state.lastSentAt + this.config.minIntervalMs);
		const now = Date.now();
		if (waitUntil > now) {
			await delay(waitUntil - now);
		}
	}

	private markRequest(target: ResolvedWebhookTarget): void {
		const key = this.targetKey(target);
		const existing = this.rateLimitState.get(key) ?? { lastSentAt: 0, nextAllowedAt: 0 };
		existing.lastSentAt = Date.now();
		this.rateLimitState.set(key, existing);
	}

	private markRateLimited(target: ResolvedWebhookTarget, retryAfterMs: number): void {
		const key = this.targetKey(target);
		const existing = this.rateLimitState.get(key) ?? { lastSentAt: 0, nextAllowedAt: 0 };
		existing.nextAllowedAt = Date.now() + Math.max(0, retryAfterMs);
		this.rateLimitState.set(key, existing);
	}

	private log(message: string, details: Record<string, unknown> = {}): void {
		this.config.logger(message, details);
	}

	private async processQueue(): Promise<void> {
		if (this.processingQueue) {
			return;
		}
		this.processingQueue = true;
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift();
				if (!item) {
					continue;
				}
				await this.sendWithRetry(item);
			}
		} finally {
			this.processingQueue = false;
		}
	}

	private async sendWithRetry(item: QueueItem): Promise<void> {
		for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
			await this.waitForRateLimit(item.target);
			const result = await this.sendOnce(item.target, item.event);
			if (result.success) {
				return;
			}

			const targetLabel = maskWebhookUrl(item.target.url);
			const shouldRetryCurrentAttempt = attempt < this.config.maxRetries && shouldRetry(result.statusCode);
			if (!shouldRetryCurrentAttempt) {
				this.log("webhook.send.failed", {
					target: targetLabel,
					provider: item.target.provider,
					eventType: item.event.type,
					statusCode: result.statusCode,
					error: result.error,
				});
				return;
			}

			const backoffDelay = this.config.baseRetryDelayMs * 2 ** attempt;
			const retryDelay = Math.max(backoffDelay, result.retryAfterMs ?? 0);
			this.log("webhook.send.retry", {
				target: targetLabel,
				provider: item.target.provider,
				eventType: item.event.type,
				attempt: attempt + 1,
				delayMs: retryDelay,
				statusCode: result.statusCode,
			});
			await delay(retryDelay);
		}
	}

	private async sendOnce(target: ResolvedWebhookTarget, event: WebhookEvent): Promise<SendAttemptResult> {
		this.markRequest(target);
		const payload =
			target.provider === "discord"
				? buildDiscordPayload(target, event, this.config)
				: buildGenericPayload(event);

		const controller = new AbortController();
		const timeout = setTimeout(() => {
			controller.abort();
		}, this.config.requestTimeoutMs);

		const headers: HeadersInit = {
			"Content-Type": "application/json",
			...target.headers,
		};

		try {
			const response = await fetch(target.url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			});

			if (response.status === 429) {
				const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
				this.markRateLimited(target, retryAfterMs);
				return {
					success: false,
					statusCode: response.status,
					retryAfterMs,
					error: "Rate limited",
				};
			}

			if (response.ok) {
				return { success: true, statusCode: response.status };
			}

			return {
				success: false,
				statusCode: response.status,
				error: `HTTP ${response.status}`,
			};
		} catch (error) {
			const message = getErrorMessage(error);
			return {
				success: false,
				error: message,
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}

export function createWebhookService(config: WebhookConfig = {}): WebhookService {
	return new WebhookService(config);
}

export default {
	WebhookService,
	createWebhookService,
};
