import { normalizeFloat } from "./config-store.ts";
import { getErrorMessage } from "./logging.ts";
import { clampRoundedInt } from "./shared/index.ts";
import type { FlatAIMessageConfig } from "./types.ts";

export const AI_EVENT_TYPES = [
	"idle",
	"permission",
	"question",
	"error",
	"idleReminder",
	"permissionReminder",
	"questionReminder",
	"errorReminder",
] as const;

export type CoreAIEventType = (typeof AI_EVENT_TYPES)[number];

export interface AIMessageContext {
	projectName?: string;
	time?: string;
	count?: number;
	toolName?: string;
	taskName?: string;
	reason?: string;
	variables?: Record<string, string | number | boolean | null | undefined>;
}

export interface AIMessageConfig extends FlatAIMessageConfig {
	templates: Partial<Record<CoreAIEventType, string[]>>;
}

interface OpenAIChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
}

interface CachedMessage {
	message: string;
	expiresAt: number;
}

interface AIMessageServiceOptions {
	config?: Partial<AIMessageConfig>;
	debugLog?: (message: string, details?: Record<string, unknown>) => void;
}

const DEFAULT_MAX_MESSAGE_LENGTH = 180;

const DEFAULT_TEMPLATES: Record<CoreAIEventType, string[]> = {
	idle: [
		"{projectName} is ready. Your task finished at {time}.",
		"All set for {projectName}. Latest work completed at {time}.",
		"Done with {projectName}. Please review the result.",
	],
	permission: [
		"Permission needed for {projectName}. Please approve in the terminal.",
		"I need your approval to continue {projectName}.",
		"Permission approval is pending. Please confirm the request.",
	],
	question: [
		"I need your input for {projectName}. Please check the terminal.",
		"Question pending{countLabel}. Please respond when ready.",
		"Input required for {projectName}. I am waiting for your answer.",
	],
	error: [
		"An error occurred in {projectName}. Please inspect the latest output.",
		"I hit an error while working on {projectName}.",
		"Something failed{reasonLabel}. Please take a look.",
	],
	idleReminder: [
		"Reminder: {projectName} is still waiting for your review.",
		"Reminder: your completed result is still open.",
	],
	permissionReminder: [
		"Reminder: permission is still pending for {projectName}.",
		"Reminder: I still need approval to proceed.",
	],
	questionReminder: [
		"Reminder: I am still waiting for your answer{countLabel}.",
		"Reminder: your input is still needed for {projectName}.",
	],
	errorReminder: [
		"Reminder: the error in {projectName} still needs attention.",
		"Reminder: unresolved error remains pending.",
	],
};

const EVENT_PROMPTS: Record<CoreAIEventType, string> = {
	idle: "Generate a short completion notification.",
	permission: "Generate a short permission-request notification.",
	question: "Generate a short question/input-needed notification.",
	error: "Generate a short error notification.",
	idleReminder: "Generate a short reminder that a completed task is waiting for review.",
	permissionReminder: "Generate a short reminder about pending permission approval.",
	questionReminder: "Generate a short reminder about unanswered questions.",
	errorReminder: "Generate a short reminder about unresolved errors.",
};

export const DEFAULT_AI_MESSAGE_CONFIG: AIMessageConfig = {
	enableAIMessages: false,
	aiEndpoint: "http://localhost:11434/v1",
	aiModel: "llama3",
	aiApiKey: "",
	aiTimeoutMs: 15_000,
	aiTemperature: 0.7,
	aiMaxTokens: 120,
	aiFallbackToTemplates: true,
	personality: "helpful assistant",
	tone: "friendly and concise",
	enableMessageCache: true,
	messageCacheTtlMs: 60_000,
	maxCacheEntries: 200,
	templates: {},
};

function normalizeAIMessageConfig(overrides: Partial<AIMessageConfig> = {}): AIMessageConfig {
	return {
		...DEFAULT_AI_MESSAGE_CONFIG,
		...overrides,
		aiTimeoutMs: clampRoundedInt(
			overrides.aiTimeoutMs ?? DEFAULT_AI_MESSAGE_CONFIG.aiTimeoutMs,
			DEFAULT_AI_MESSAGE_CONFIG.aiTimeoutMs,
			1_000,
			60_000,
		),
		aiMaxTokens: clampRoundedInt(
			overrides.aiMaxTokens ?? DEFAULT_AI_MESSAGE_CONFIG.aiMaxTokens,
			DEFAULT_AI_MESSAGE_CONFIG.aiMaxTokens,
			40,
			500,
		),
		aiTemperature: normalizeFloat(
			overrides.aiTemperature ?? DEFAULT_AI_MESSAGE_CONFIG.aiTemperature,
			DEFAULT_AI_MESSAGE_CONFIG.aiTemperature,
			0,
			2,
		),
		messageCacheTtlMs: clampRoundedInt(
			overrides.messageCacheTtlMs ?? DEFAULT_AI_MESSAGE_CONFIG.messageCacheTtlMs,
			DEFAULT_AI_MESSAGE_CONFIG.messageCacheTtlMs,
			5_000,
			600_000,
		),
		maxCacheEntries: clampRoundedInt(
			overrides.maxCacheEntries ?? DEFAULT_AI_MESSAGE_CONFIG.maxCacheEntries,
			DEFAULT_AI_MESSAGE_CONFIG.maxCacheEntries,
			20,
			2_000,
		),
		templates: {
			...DEFAULT_AI_MESSAGE_CONFIG.templates,
			...(overrides.templates ?? {}),
		},
	};
}

function ensureChatCompletionsEndpoint(endpoint: string): string {
	const base = endpoint.trim().length > 0 ? endpoint.trim() : DEFAULT_AI_MESSAGE_CONFIG.aiEndpoint;
	if (base.endsWith("/chat/completions")) {
		return base;
	}
	return `${base.replace(/\/$/, "")}/chat/completions`;
}

function buildTemplateVariables(eventType: string, context: AIMessageContext): Record<string, string> {
	const projectName = (context.projectName ?? "your project").trim() || "your project";
	const time = (context.time ?? new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })).trim();
	const count = Math.max(1, context.count ?? 1);
	const toolName = (context.toolName ?? "terminal").trim() || "terminal";
	const taskName = (context.taskName ?? "current task").trim() || "current task";
	const reason = (context.reason ?? "").trim();

	const variables: Record<string, string> = {
		eventType,
		projectName,
		time,
		count: String(count),
		toolName,
		taskName,
		reason,
		countLabel: count > 1 ? ` (${count} pending)` : "",
		reasonLabel: reason ? ` (${reason})` : "",
	};

	if (context.variables) {
		for (const [key, rawValue] of Object.entries(context.variables)) {
			if (rawValue === null || rawValue === undefined) {
				continue;
			}
			variables[key] = String(rawValue);
		}
	}

	return variables;
}

function applyTemplateVariables(template: string, variables: Record<string, string>): string {
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, variableName: string) => {
		const value = variables[variableName];
		return value !== undefined ? value : "";
	});
}

function sanitizeMessage(message: string, maxLength = DEFAULT_MAX_MESSAGE_LENGTH): string {
	const collapsed = message.replace(/\s+/g, " ").replace(/^['\"`]|['\"`]$/g, "").trim();
	if (collapsed.length <= maxLength) {
		return collapsed;
	}

	const clipped = collapsed.slice(0, maxLength);
	const safeBoundary = clipped.lastIndexOf(" ");
	if (safeBoundary < 40) {
		return `${clipped.trimEnd()}...`;
	}
	return `${clipped.slice(0, safeBoundary).trimEnd()}...`;
}

function getUsableTemplates(templates: string[]): string[] {
	return templates.filter((template) => template.trim().length > 0);
}

function pickTemplate(templates: string[]): string {
	const index = Math.floor(Math.random() * templates.length);
	return templates[index] ?? templates[0] ?? "Notification";
}

function isCoreEventType(eventType: string): eventType is CoreAIEventType {
	return (AI_EVENT_TYPES as readonly string[]).includes(eventType);
}

function getTemplatesForEvent(eventType: string, config: AIMessageConfig): string[] {
	if (!isCoreEventType(eventType)) {
		return ["Notification from {projectName}. Please check {toolName}."];
	}

	const overrideTemplates = config.templates[eventType];
	if (Array.isArray(overrideTemplates)) {
		const usableTemplates = getUsableTemplates(overrideTemplates);
		if (usableTemplates.length > 0) {
			return usableTemplates;
		}
	}
	return DEFAULT_TEMPLATES[eventType];
}

function buildSystemPrompt(config: AIMessageConfig): string {
	return [
		"You write short voice notification messages for a coding agent.",
		`Style personality: ${config.personality}.`,
		`Tone: ${config.tone}.`,
		`Keep the response under ${DEFAULT_MAX_MESSAGE_LENGTH} characters.`,
		"Return plain text only. Do not include quotation marks, markdown, or explanations.",
	].join(" ");
}

function buildUserPrompt(eventType: string, variables: Record<string, string>): string {
	const eventPrompt = isCoreEventType(eventType)
		? EVENT_PROMPTS[eventType]
		: "Generate a short coding-agent notification message.";

	const variableLines = Object.entries(variables)
		.map(([key, value]) => `- ${key}: ${value}`)
		.join("\n");

	return `${eventPrompt}\n\nContext:\n${variableLines}`;
}

function createCacheKey(eventType: string, variables: Record<string, string>, config: AIMessageConfig): string {
	return JSON.stringify({
		eventType,
		variables,
		endpoint: ensureChatCompletionsEndpoint(config.aiEndpoint),
		model: config.aiModel,
		personality: config.personality,
		tone: config.tone,
	});
}

export class AIMessageService {
	private config: AIMessageConfig;
	private readonly cache = new Map<string, CachedMessage>();
	private readonly debugLog: (message: string, details?: Record<string, unknown>) => void;

	constructor(options: AIMessageServiceOptions = {}) {
		this.config = normalizeAIMessageConfig(options.config);
		this.debugLog = options.debugLog ?? (() => {});
	}

	public updateAIMessageConfig(overrides: Partial<AIMessageConfig>): void {
		this.config = normalizeAIMessageConfig({ ...this.config, ...overrides });
	}

	public getAIMessageConfig(): AIMessageConfig {
		return { ...this.config, templates: { ...this.config.templates } };
	}

	public clearCache(): void {
		this.cache.clear();
	}

	public generateTemplateMessage(eventType: string, context: AIMessageContext = {}): string {
		const templates = getTemplatesForEvent(eventType, this.config);
		const template = pickTemplate(templates);
		const variables = buildTemplateVariables(eventType, context);
		const message = sanitizeMessage(applyTemplateVariables(template, variables));
		if (message.length > 0) {
			return message;
		}

		if (isCoreEventType(eventType)) {
			const fallbackTemplate = pickTemplate(DEFAULT_TEMPLATES[eventType]);
			const fallbackMessage = sanitizeMessage(applyTemplateVariables(fallbackTemplate, variables));
			if (fallbackMessage.length > 0) {
				return fallbackMessage;
			}
		}

		return "Notification: Please check the terminal.";
	}

	public async generateAIMessage(eventType: string, context: AIMessageContext = {}): Promise<string | null> {
		if (!this.config.enableAIMessages) {
			return null;
		}

		const variables = buildTemplateVariables(eventType, context);
		const cacheKey = createCacheKey(eventType, variables, this.config);
		const now = Date.now();

		if (this.config.enableMessageCache) {
			const cached = this.cache.get(cacheKey);
			if (cached && cached.expiresAt > now) {
				this.debugLog("ai_messages.cache_hit", { eventType });
				return cached.message;
			}
		}

		const endpoint = ensureChatCompletionsEndpoint(this.config.aiEndpoint);
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.config.aiApiKey.trim().length > 0) {
			headers.Authorization = `Bearer ${this.config.aiApiKey.trim()}`;
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.config.aiTimeoutMs);

		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				signal: controller.signal,
				body: JSON.stringify({
					model: this.config.aiModel,
					messages: [
						{
							role: "system",
							content: buildSystemPrompt(this.config),
						},
						{
							role: "user",
							content: buildUserPrompt(eventType, variables),
						},
					],
					temperature: this.config.aiTemperature,
					max_tokens: this.config.aiMaxTokens,
				}),
			});

			if (!response.ok) {
				this.debugLog("ai_messages.http_error", {
					eventType,
					status: response.status,
					statusText: response.statusText,
				});
				return null;
			}

			const payload = (await response.json()) as OpenAIChatCompletionResponse;
			const content = payload.choices?.[0]?.message?.content;
			if (!content) {
				this.debugLog("ai_messages.empty_response", { eventType });
				return null;
			}

			const message = sanitizeMessage(content);
			if (message.length < 5) {
				this.debugLog("ai_messages.invalid_length", { eventType, length: message.length });
				return null;
			}

			if (this.config.enableMessageCache) {
				this.cache.set(cacheKey, {
					message,
					expiresAt: now + this.config.messageCacheTtlMs,
				});
				this.pruneCache();
			}

			return message;
		} catch (error) {
			this.debugLog("ai_messages.request_failed", { eventType, error: getErrorMessage(error) });
			return null;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	public async generateMessage(eventType: string, context: AIMessageContext = {}): Promise<string> {
		const aiMessage = await this.generateAIMessage(eventType, context);
		if (aiMessage) {
			return aiMessage;
		}

		if (!this.config.aiFallbackToTemplates && this.config.enableAIMessages) {
			return "Notification: Please check the terminal.";
		}

		return this.generateTemplateMessage(eventType, context);
	}

	private pruneCache(): void {
		const now = Date.now();
		for (const [key, cached] of this.cache.entries()) {
			if (cached.expiresAt <= now) {
				this.cache.delete(key);
			}
		}

		while (this.cache.size > this.config.maxCacheEntries) {
			const next = this.cache.keys().next();
			const oldestKey = typeof next.value === "string" ? next.value : undefined;
			if (!oldestKey) {
				break;
			}
			this.cache.delete(oldestKey);
		}
	}
}

let aiMessageService: AIMessageService | null = null;

export function createAIMessageService(options: AIMessageServiceOptions = {}): AIMessageService {
	return new AIMessageService(options);
}

export function initializeAIMessageService(options: AIMessageServiceOptions = {}): AIMessageService {
	aiMessageService = new AIMessageService(options);
	return aiMessageService;
}

export function getAIMessageService(): AIMessageService {
	if (!aiMessageService) {
		aiMessageService = new AIMessageService();
	}
	return aiMessageService;
}

export function generateTemplateMessageSync(eventType: string, context: AIMessageContext = {}): string {
	return getAIMessageService().generateTemplateMessage(eventType, context);
}

export async function generateSmartMessage(eventType: string, context: AIMessageContext = {}): Promise<string> {
	return getAIMessageService().generateMessage(eventType, context);
}

export async function generateOptionalAIMessage(
	eventType: string,
	context: AIMessageContext = {},
): Promise<string | null> {
	return getAIMessageService().generateAIMessage(eventType, context);
}
