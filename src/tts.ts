import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAbortableCommand } from "./abortable-command.ts";
import { normalizeFloat } from "./config-store.ts";
import { getErrorMessage } from "./logging.ts";
import type {
	ConcreteTTSEngine,
	SpeakOptions,
	TTSAvailability,
	TTSCommandResult,
	TTSConfig,
	TTSEngine,
	TTSExecRunner,
	TTSService,
	TTSServiceOptions,
} from "./types/tts.ts";

const DEFAULT_TTS_CONFIG: TTSConfig = {
	enableTts: true,
	ttsEngine: "auto",
	fallbackChain: ["edge", "espeak-ng", "sapi"],
	commandTimeoutMs: 30_000,
	edgeVoice: "en-US-JennyNeural",
	edgeRate: "+10%",
	edgePitch: "+0Hz",
	edgeVolume: "+0%",
	espeakVoice: "en",
	espeakRate: 175,
	espeakPitch: 50,
	elevenLabsApiKey: "",
	elevenLabsVoiceId: "cgSgspJ2msm6clMCkdW9",
	elevenLabsModel: "eleven_turbo_v2_5",
	elevenLabsStability: 0.5,
	elevenLabsSimilarity: 0.75,
	elevenLabsStyle: 0.5,
	openaiTtsEndpoint: "",
	openaiTtsApiKey: "",
	openaiTtsModel: "tts-1",
	openaiTtsVoice: "alloy",
	openaiTtsFormat: "mp3",
	openaiTtsSpeed: 1,
	sapiVoice: "Microsoft Zira Desktop",
	sapiRate: -1,
};

const EMPTY_AVAILABILITY: TTSAvailability = {
	"espeak-ng": false,
	edge: false,
	elevenlabs: false,
	openai: false,
	sapi: false,
};

function fromEnv(...keys: string[]): string {
	for (const key of keys) {
		const value = process.env[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return "";
}

function normalizeRate(value: number, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.round(value)));
}

function mergeConfig(base: TTSConfig, overrides: Partial<TTSConfig>): TTSConfig {
	return {
		...base,
		...overrides,
		fallbackChain: overrides.fallbackChain ? [...overrides.fallbackChain] : [...base.fallbackChain],
		commandTimeoutMs: normalizeRate(overrides.commandTimeoutMs ?? base.commandTimeoutMs, base.commandTimeoutMs, 3_000, 120_000),
		espeakRate: normalizeRate(overrides.espeakRate ?? base.espeakRate, base.espeakRate, 80, 450),
		espeakPitch: normalizeRate(overrides.espeakPitch ?? base.espeakPitch, base.espeakPitch, 0, 99),
		elevenLabsStability: normalizeFloat(
			overrides.elevenLabsStability ?? base.elevenLabsStability,
			base.elevenLabsStability,
			0,
			1,
		),
		elevenLabsSimilarity: normalizeFloat(
			overrides.elevenLabsSimilarity ?? base.elevenLabsSimilarity,
			base.elevenLabsSimilarity,
			0,
			1,
		),
		elevenLabsStyle: normalizeFloat(
			overrides.elevenLabsStyle ?? base.elevenLabsStyle,
			base.elevenLabsStyle,
			0,
			1,
		),
		openaiTtsSpeed: normalizeFloat(overrides.openaiTtsSpeed ?? base.openaiTtsSpeed, base.openaiTtsSpeed, 0.25, 4),
		sapiRate: normalizeRate(overrides.sapiRate ?? base.sapiRate, base.sapiRate, -10, 10),
	};
}

function createConfig(overrides: Partial<TTSConfig> = {}): TTSConfig {
	const envConfig: Partial<TTSConfig> = {
		ttsEngine: (fromEnv("PI_SMART_VOICE_NOTIFY_TTS_ENGINE", "PI_TTS_ENGINE") as TTSEngine) || undefined,
		elevenLabsApiKey:
			overrides.elevenLabsApiKey ||
			fromEnv("ELEVENLABS_API_KEY", "PI_SMART_VOICE_NOTIFY_ELEVENLABS_API_KEY"),
		elevenLabsVoiceId:
			overrides.elevenLabsVoiceId ||
			fromEnv("ELEVENLABS_VOICE_ID", "PI_SMART_VOICE_NOTIFY_ELEVENLABS_VOICE_ID"),
		openaiTtsEndpoint:
			overrides.openaiTtsEndpoint ||
			fromEnv("OPENAI_TTS_ENDPOINT", "OPENAI_BASE_URL", "PI_SMART_VOICE_NOTIFY_OPENAI_TTS_ENDPOINT"),
		openaiTtsApiKey:
			overrides.openaiTtsApiKey ||
			fromEnv("OPENAI_API_KEY", "OPENAI_TTS_API_KEY", "PI_SMART_VOICE_NOTIFY_OPENAI_TTS_API_KEY"),
	};

	const merged = mergeConfig(DEFAULT_TTS_CONFIG, { ...envConfig, ...overrides });
	const validEngines: TTSEngine[] = ["auto", "espeak-ng", "edge", "elevenlabs", "openai", "sapi"];
	if (!validEngines.includes(merged.ttsEngine)) {
		merged.ttsEngine = DEFAULT_TTS_CONFIG.ttsEngine;
	}
	return merged;
}

async function removeTempFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch {
		// noop
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		const error = new Error("Speech request aborted.");
		error.name = "AbortError";
		throw error;
	}
}

async function runSpawnCommand(
	command: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<TTSCommandResult> {
	const result = await runAbortableCommand(command, args, { timeoutMs, signal });
	return {
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr,
		timedOut: result.timedOut,
		errorMessage: result.errorMessage,
	};
}

class TTSEngineService implements TTSService {
	private readonly execRunner?: TTSExecRunner;
	private readonly debug: (event: string, details?: Record<string, unknown>) => void;
	private config: TTSConfig;
	private availability: TTSAvailability = { ...EMPTY_AVAILABILITY };
	private initialization: Promise<TTSAvailability>;
	private speechQueue: Promise<void> = Promise.resolve();

	public constructor(options: TTSServiceOptions = {}) {
		this.execRunner = options.execRunner;
		this.debug = options.debug ?? (() => {});
		this.config = createConfig(options.config);
		this.initialization = this.detectAvailableEngines();
	}

	public async detectAvailableEngines(): Promise<TTSAvailability> {
		const [hasEspeak, hasEdgeCli, hasPowerShell, hasEdgeModule] = await Promise.all([
			this.commandExists("espeak-ng"),
			this.commandExists("edge-tts"),
			process.platform === "win32" ? this.commandExists("powershell.exe") : Promise.resolve(false),
			this.canLoadMsEdgeModule(),
		]);

		this.availability = {
			"espeak-ng": hasEspeak,
			edge: hasEdgeCli || hasEdgeModule,
			elevenlabs: this.config.elevenLabsApiKey.trim().length > 0,
			openai: this.config.openaiTtsEndpoint.trim().length > 0,
			sapi: process.platform === "win32" && hasPowerShell,
		};

		this.debug("tts.engines.detected", {
			espeak: hasEspeak,
			edgeCli: hasEdgeCli,
			edgeModule: hasEdgeModule,
			elevenlabs: this.availability.elevenlabs,
			openai: this.availability.openai,
			sapi: this.availability.sapi,
		});
		return { ...this.availability };
	}

	public getAvailableEngines(): Readonly<TTSAvailability> {
		return { ...this.availability };
	}

	public getConfig(): Readonly<TTSConfig> {
		return { ...this.config, fallbackChain: [...this.config.fallbackChain] };
	}

	public async speak(text: string, engine: TTSEngine = "auto", options: SpeakOptions = {}): Promise<boolean> {
		const normalizedText = text.trim();
		if (!this.config.enableTts || normalizedText.length === 0) {
			return false;
		}

		const run = async (): Promise<boolean> => {
			try {
				throwIfAborted(options.signal);
				await this.initialization;
				throwIfAborted(options.signal);
				const activeConfig = mergeConfig(this.config, options);
				const chain = this.resolveEngineChain(engine, activeConfig);

				for (const candidate of chain) {
					if (!this.availability[candidate]) {
						continue;
					}
					try {
						throwIfAborted(options.signal);
						const ok = await this.speakWithEngine(candidate, normalizedText, activeConfig, options.signal);
						if (ok) {
							this.debug("tts.speak.success", { engine: candidate });
							return true;
						}
					} catch (error) {
						if (isAbortError(error)) {
							this.debug("tts.speak.aborted", { engine: candidate });
							return false;
						}
						this.debug("tts.speak.engine_error", {
							engine: candidate,
							error: getErrorMessage(error),
						});
					}
				}

				this.debug("tts.speak.failed", {
					requestedEngine: engine,
					triedEngines: chain,
				});
				return false;
			} catch (error) {
				if (isAbortError(error)) {
					this.debug("tts.speak.aborted", { requestedEngine: engine });
					return false;
				}
				throw error;
			}
		};

		const queued = this.speechQueue.then(run, run);
		this.speechQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return await queued;
	}

	private resolveEngineChain(requestedEngine: TTSEngine, config: TTSConfig): ConcreteTTSEngine[] {
		const ordered: ConcreteTTSEngine[] = [];
		const push = (engine: ConcreteTTSEngine): void => {
			if (!ordered.includes(engine)) {
				ordered.push(engine);
			}
		};

		if (requestedEngine !== "auto") {
			push(requestedEngine);
		} else if (config.ttsEngine !== "auto") {
			push(config.ttsEngine);
		}

		if (config.elevenLabsApiKey.trim().length > 0) {
			push("elevenlabs");
		}
		if (config.openaiTtsEndpoint.trim().length > 0) {
			push("openai");
		}

		push("edge");
		if (process.platform === "linux") {
			push("espeak-ng");
		}
		if (process.platform === "win32") {
			push("sapi");
		}

		for (const fallbackEngine of config.fallbackChain) {
			push(fallbackEngine);
		}

		push("espeak-ng");
		push("sapi");
		return ordered;
	}

	private async speakWithEngine(
		engine: ConcreteTTSEngine,
		text: string,
		config: TTSConfig,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (engine === "espeak-ng") {
			return await this.speakWithEspeak(text, config, signal);
		}
		if (engine === "edge") {
			return await this.speakWithEdge(text, config, signal);
		}
		if (engine === "elevenlabs") {
			return await this.speakWithElevenLabs(text, config, signal);
		}
		if (engine === "openai") {
			return await this.speakWithOpenAI(text, config, signal);
		}
		return await this.speakWithSapi(text, config, signal);
	}

	private async speakWithEspeak(text: string, config: TTSConfig, signal?: AbortSignal): Promise<boolean> {
		throwIfAborted(signal);
		const args: string[] = [
			"-s",
			String(config.espeakRate),
			"-p",
			String(config.espeakPitch),
			"-v",
			config.espeakVoice,
			text,
		];
		const result = await this.runCommand("espeak-ng", args, config.commandTimeoutMs, signal);
		return result.code === 0;
	}

	private async speakWithEdge(text: string, config: TTSConfig, signal?: AbortSignal): Promise<boolean> {
		throwIfAborted(signal);
		const tempFile = this.createTempFilePath("edge", "mp3");
		try {
			const edgeCliResult = await this.runCommand(
				"edge-tts",
				[
					"--voice",
					config.edgeVoice,
					"--rate",
					config.edgeRate,
					"--volume",
					config.edgeVolume,
					"--pitch",
					config.edgePitch,
					"--text",
					text,
					"--write-media",
					tempFile,
				],
				config.commandTimeoutMs,
				signal,
			);

			if (edgeCliResult.code === 0 && existsSync(tempFile)) {
				throwIfAborted(signal);
				return await this.playAudioFile(tempFile, signal);
			}
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			this.debug("tts.edge.cli.error", { error: getErrorMessage(error) });
		}

		try {
			throwIfAborted(signal);
			const edgeModule = (await import("msedge-tts")) as {
				MsEdgeTTS: new () => {
					setMetadata: (voice: string, format: string) => Promise<void>;
					toFile: (
						tmpPath: string,
						inputText: string,
						settings: { pitch: string; rate: string; volume: string },
					) => Promise<{ audioFilePath: string }>;
				};
				OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: string };
			};

			const edgeClient = new edgeModule.MsEdgeTTS();
			await edgeClient.setMetadata(config.edgeVoice, edgeModule.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
			throwIfAborted(signal);
			const generated = await edgeClient.toFile(tmpdir(), text, {
				pitch: config.edgePitch,
				rate: config.edgeRate,
				volume: config.edgeVolume,
			});
			const generatedPath = generated.audioFilePath;
			throwIfAborted(signal);
			const played = await this.playAudioFile(generatedPath, signal);
			await removeTempFile(generatedPath);
			return played;
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			this.debug("tts.edge.module.error", { error: getErrorMessage(error) });
			return false;
		} finally {
			await removeTempFile(tempFile);
		}
	}

	private async speakWithElevenLabs(text: string, config: TTSConfig, signal?: AbortSignal): Promise<boolean> {
		if (!config.elevenLabsApiKey.trim()) {
			return false;
		}

		throwIfAborted(signal);
		const tempFile = this.createTempFilePath("elevenlabs", "mp3");
		try {
			const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenLabsVoiceId)}`;
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"xi-api-key": config.elevenLabsApiKey,
				},
				signal,
				body: JSON.stringify({
					text,
					model_id: config.elevenLabsModel,
					voice_settings: {
						stability: config.elevenLabsStability,
						similarity_boost: config.elevenLabsSimilarity,
						style: config.elevenLabsStyle,
						use_speaker_boost: true,
					},
				}),
			});

			if (!response.ok) {
				this.debug("tts.elevenlabs.http_error", { status: response.status });
				return false;
			}

			throwIfAborted(signal);
			const audioBuffer = await response.arrayBuffer();
			await writeFile(tempFile, Buffer.from(audioBuffer));
			throwIfAborted(signal);
			return await this.playAudioFile(tempFile, signal);
		} catch (error) {
			if (isAbortError(error)) {
				this.debug("tts.elevenlabs.aborted", {});
				return false;
			}
			this.debug("tts.elevenlabs.error", { error: getErrorMessage(error) });
			return false;
		} finally {
			await removeTempFile(tempFile);
		}
	}

	private async speakWithOpenAI(text: string, config: TTSConfig, signal?: AbortSignal): Promise<boolean> {
		if (!config.openaiTtsEndpoint.trim()) {
			return false;
		}

		throwIfAborted(signal);
		const format = config.openaiTtsFormat.trim() || "mp3";
		const tempFile = this.createTempFilePath("openai", format);
		try {
			const endpoint = this.normalizeOpenAIEndpoint(config.openaiTtsEndpoint);
			const headers: Record<string, string> = {
				"content-type": "application/json",
			};
			if (config.openaiTtsApiKey.trim()) {
				headers.authorization = `Bearer ${config.openaiTtsApiKey}`;
			}

			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				signal,
				body: JSON.stringify({
					model: config.openaiTtsModel,
					input: text,
					voice: config.openaiTtsVoice,
					response_format: format,
					speed: config.openaiTtsSpeed,
				}),
			});

			if (!response.ok) {
				this.debug("tts.openai.http_error", { status: response.status });
				return false;
			}

			throwIfAborted(signal);
			const audioBuffer = await response.arrayBuffer();
			await writeFile(tempFile, Buffer.from(audioBuffer));
			throwIfAborted(signal);
			return await this.playAudioFile(tempFile, signal);
		} catch (error) {
			if (isAbortError(error)) {
				this.debug("tts.openai.aborted", {});
				return false;
			}
			this.debug("tts.openai.error", { error: getErrorMessage(error) });
			return false;
		} finally {
			await removeTempFile(tempFile);
		}
	}

	private async speakWithSapi(text: string, config: TTSConfig, signal?: AbortSignal): Promise<boolean> {
		if (process.platform !== "win32") {
			return false;
		}

		throwIfAborted(signal);
		const textBase64 = Buffer.from(text, "utf8").toString("base64");
		const voiceBase64 = Buffer.from(config.sapiVoice, "utf8").toString("base64");

		const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${textBase64}'))
  $voice = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${voiceBase64}'))
  $synth.Rate = ${config.sapiRate}
  if ($voice) {
    try { $synth.SelectVoice($voice) } catch { }
  }
  $synth.Speak($text)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($synth) { $synth.Dispose() }
}
`;
		const result = await this.runPowerShell(script, config.commandTimeoutMs, signal);
		return result.code === 0;
	}

	private async playAudioFile(filePath: string, signal?: AbortSignal): Promise<boolean> {
		throwIfAborted(signal);
		if (process.platform === "darwin") {
			const result = await this.runCommand("afplay", [filePath], this.config.commandTimeoutMs, signal);
			if (result.code === 0) {
				return true;
			}
		}

		if (process.platform === "win32") {
			const pathBase64 = Buffer.from(filePath, "utf8").toString("base64");
			const script = `
$ErrorActionPreference = 'Stop'
$path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${pathBase64}'))
if (-not (Test-Path -LiteralPath $path)) {
  throw 'Audio file not found.'
}
Add-Type -AssemblyName PresentationCore
$player = New-Object System.Windows.Media.MediaPlayer
try {
  $player.Open([Uri]::new($path))
  $deadline = (Get-Date).AddSeconds(6)
  while (-not $player.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 40
  }
  $durationMs = if ($player.NaturalDuration.HasTimeSpan) {
    [Math]::Max(250, [Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds))
  } else {
    2500
  }
  $player.Play()
  Start-Sleep -Milliseconds $durationMs
} finally {
  $player.Close()
}
`;
			const result = await this.runPowerShell(script, this.config.commandTimeoutMs, signal);
			if (result.code === 0) {
				return true;
			}
		}

		const fallbacks: Array<{ command: string; args: string[] }> = [
			{ command: "paplay", args: [filePath] },
			{ command: "aplay", args: [filePath] },
			{ command: "ffplay", args: ["-autoexit", "-nodisp", "-loglevel", "error", filePath] },
		];

		for (const fallback of fallbacks) {
			const result = await this.runCommand(fallback.command, fallback.args, this.config.commandTimeoutMs, signal);
			if (result.code === 0) {
				return true;
			}
		}

		return false;
	}

	private createTempFilePath(prefix: string, extension: string): string {
		const safeExt = extension.replace(/[^a-z0-9]/gi, "") || "mp3";
		return join(tmpdir(), `pi-smart-voice-notify-${prefix}-${randomUUID()}.${safeExt}`);
	}

	private normalizeOpenAIEndpoint(endpoint: string): string {
		const trimmed = endpoint.trim().replace(/\/$/, "");
		if (trimmed.endsWith("/v1/audio/speech")) {
			return trimmed;
		}
		return `${trimmed}/v1/audio/speech`;
	}

	private async canLoadMsEdgeModule(): Promise<boolean> {
		try {
			await import("msedge-tts");
			return true;
		} catch {
			return false;
		}
	}

	private async commandExists(command: string): Promise<boolean> {
		const checker = process.platform === "win32" ? "where" : "which";
		const result = await this.runCommand(checker, [command], 3_000);
		return result.code === 0;
	}

	private async runPowerShell(script: string, timeoutMs: number, signal?: AbortSignal): Promise<TTSCommandResult> {
		const encodedScript = Buffer.from(script, "utf16le").toString("base64");
		return await this.runCommand(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript],
			timeoutMs,
			signal,
		);
	}

	private async runCommand(
		command: string,
		args: string[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<TTSCommandResult> {
		if (this.execRunner && !signal) {
			try {
				const result = await this.execRunner.exec(command, args, { timeout: timeoutMs });
				return {
					code: result.code,
					stdout: result.stdout,
					stderr: result.stderr,
					timedOut: false,
				};
			} catch (error) {
				return {
					code: 1,
					stdout: "",
					stderr: "",
					timedOut: false,
					errorMessage: getErrorMessage(error),
				};
			}
		}

		return await runSpawnCommand(command, args, timeoutMs, signal);
	}
}

let sharedTTSService: TTSService | null = null;

export function createTTSService(options: TTSServiceOptions = {}): TTSService {
	return new TTSEngineService(options);
}

export function initializeTTSService(options: TTSServiceOptions = {}): TTSService {
	sharedTTSService = createTTSService(options);
	return sharedTTSService;
}

export function getTTSService(): TTSService {
	if (!sharedTTSService) {
		sharedTTSService = createTTSService();
	}
	return sharedTTSService;
}

export async function speak(text: string, engine: TTSEngine = "auto", options: SpeakOptions = {}): Promise<boolean> {
	return await getTTSService().speak(text, engine, options);
}
