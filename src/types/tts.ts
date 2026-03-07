export type TTSEngine = "auto" | "espeak-ng" | "edge" | "elevenlabs" | "openai" | "sapi";

export type ConcreteTTSEngine = Exclude<TTSEngine, "auto">;

export interface TTSConfig {
	enableTts: boolean;
	ttsEngine: TTSEngine;
	fallbackChain: ConcreteTTSEngine[];
	commandTimeoutMs: number;
	edgeVoice: string;
	edgeRate: string;
	edgePitch: string;
	edgeVolume: string;
	espeakVoice: string;
	espeakRate: number;
	espeakPitch: number;
	elevenLabsApiKey: string;
	elevenLabsVoiceId: string;
	elevenLabsModel: string;
	elevenLabsStability: number;
	elevenLabsSimilarity: number;
	elevenLabsStyle: number;
	openaiTtsEndpoint: string;
	openaiTtsApiKey: string;
	openaiTtsModel: string;
	openaiTtsVoice: string;
	openaiTtsFormat: string;
	openaiTtsSpeed: number;
	sapiVoice: string;
	sapiRate: number;
}

export interface SpeakOptions {
	fallbackChain?: ConcreteTTSEngine[];
	commandTimeoutMs?: number;
	signal?: AbortSignal;
	edgeVoice?: string;
	edgeRate?: string;
	edgePitch?: string;
	edgeVolume?: string;
	espeakVoice?: string;
	espeakRate?: number;
	espeakPitch?: number;
	elevenLabsApiKey?: string;
	elevenLabsVoiceId?: string;
	elevenLabsModel?: string;
	elevenLabsStability?: number;
	elevenLabsSimilarity?: number;
	elevenLabsStyle?: number;
	openaiTtsEndpoint?: string;
	openaiTtsApiKey?: string;
	openaiTtsModel?: string;
	openaiTtsVoice?: string;
	openaiTtsFormat?: string;
	openaiTtsSpeed?: number;
	sapiVoice?: string;
	sapiRate?: number;
}

export interface TTSCommandResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	errorMessage?: string;
}

export interface TTSExecRunner {
	exec: (command: string, args: string[], options?: { timeout?: number }) => Promise<{
		code: number;
		stdout: string;
		stderr: string;
	}>;
}

export interface TTSServiceOptions {
	config?: Partial<TTSConfig>;
	execRunner?: TTSExecRunner;
	debug?: (event: string, details?: Record<string, unknown>) => void;
}

export interface TTSAvailability {
	"espeak-ng": boolean;
	edge: boolean;
	elevenlabs: boolean;
	openai: boolean;
	sapi: boolean;
}

export interface TTSService {
	speak(text: string, engine?: TTSEngine, options?: SpeakOptions): Promise<boolean>;
	detectAvailableEngines(): Promise<TTSAvailability>;
	getAvailableEngines(): Readonly<TTSAvailability>;
	getConfig(): Readonly<TTSConfig>;
}
