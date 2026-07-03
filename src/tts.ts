import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAbortableCommand } from "./abortable-command.ts";
import { normalizeFloat } from "./config-store.ts";
import { getErrorMessage } from "./logging.ts";
import {
	clampRoundedInt,
	readEnvFrom,
	ENGINE_TTS_DEFAULTS,
} from "./shared/index.ts";
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
	...ENGINE_TTS_DEFAULTS,
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

const MAX_TTS_AUDIO_RESPONSE_BYTES = 10 * 1024 * 1024;

function mergeFloat(base: number, override: number | undefined, min: number, max: number): number {
	return normalizeFloat(override ?? base, base, min, max);
}

function mergeTtsConfig(base: TTSConfig, overrides: Partial<TTSConfig>): TTSConfig {
	return {
		...base,
		...overrides,
		fallbackChain: overrides.fallbackChain ? [...overrides.fallbackChain] : [...base.fallbackChain],
		commandTimeoutMs: clampRoundedInt(overrides.commandTimeoutMs ?? base.commandTimeoutMs, base.commandTimeoutMs, 3_000, 120_000),
		espeakRate: clampRoundedInt(overrides.espeakRate ?? base.espeakRate, base.espeakRate, 80, 450),
		espeakPitch: clampRoundedInt(overrides.espeakPitch ?? base.espeakPitch, base.espeakPitch, 0, 99),
		elevenLabsStability: mergeFloat(base.elevenLabsStability, overrides.elevenLabsStability, 0, 1),
		elevenLabsSimilarity: mergeFloat(base.elevenLabsSimilarity, overrides.elevenLabsSimilarity, 0, 1),
		elevenLabsStyle: normalizeFloat(
			overrides.elevenLabsStyle ?? base.elevenLabsStyle,
			base.elevenLabsStyle,
			0,
			1,
		),
		openaiTtsSpeed: normalizeFloat(overrides.openaiTtsSpeed ?? base.openaiTtsSpeed, base.openaiTtsSpeed, 0.25, 4),
		sapiRate: clampRoundedInt(overrides.sapiRate ?? base.sapiRate, base.sapiRate, -10, 10),
	};
}

function createConfig(overrides: Partial<TTSConfig> = {}): TTSConfig {
	const envConfig: Partial<TTSConfig> = {
		ttsEngine: (readEnvFrom("PI_SMART_VOICE_NOTIFY_TTS_ENGINE", "PI_TTS_ENGINE") as TTSEngine) || undefined,
		elevenLabsApiKey:
			overrides.elevenLabsApiKey ||
			readEnvFrom("ELEVENLABS_API_KEY", "PI_SMART_VOICE_NOTIFY_ELEVENLABS_API_KEY"),
		elevenLabsVoiceId:
			overrides.elevenLabsVoiceId ||
			readEnvFrom("ELEVENLABS_VOICE_ID", "PI_SMART_VOICE_NOTIFY_ELEVENLABS_VOICE_ID"),
		openaiTtsEndpoint:
			overrides.openaiTtsEndpoint ||
			readEnvFrom("OPENAI_TTS_ENDPOINT", "OPENAI_BASE_URL", "PI_SMART_VOICE_NOTIFY_OPENAI_TTS_ENDPOINT"),
		openaiTtsApiKey:
			overrides.openaiTtsApiKey ||
			readEnvFrom("OPENAI_API_KEY", "OPENAI_TTS_API_KEY", "PI_SMART_VOICE_NOTIFY_OPENAI_TTS_API_KEY"),
	};

	const merged = mergeTtsConfig(DEFAULT_TTS_CONFIG, { ...envConfig, ...overrides });
	const validEngines: TTSEngine[] = ["auto", "espeak-ng", "edge", "elevenlabs", "openai", "sapi"];
	if (!validEngines.includes(merged.ttsEngine)) {
		merged.ttsEngine = DEFAULT_TTS_CONFIG.ttsEngine;
	}
	return merged;
}

async function removeTempFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch (error) {
		// Temp-file cleanup is best-effort; a missing or locked file is non-fatal.
		void error;
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

function createAbortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function createFetchTimeoutSignal(timeoutMs: number, signal?: AbortSignal): { cleanup: () => void; signal: AbortSignal } {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(createAbortError("Speech request timed out."));
	}, Math.max(1, timeoutMs));

	const abortFromCaller = (): void => {
		controller.abort(createAbortError("Speech request aborted."));
	};

	if (signal?.aborted) {
		abortFromCaller();
	} else {
		signal?.addEventListener("abort", abortFromCaller, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abortFromCaller);
		},
	};
}

async function readAudioResponseWithLimit(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Buffer> {
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const parsedLength = Number(contentLength);
		if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
			await response.body?.cancel().catch(() => {});
			throw new Error(`TTS audio response exceeded ${maxBytes} bytes.`);
		}
	}

	if (!response.body) {
		return Buffer.alloc(0);
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			throwIfAborted(signal);
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}

			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				throw new Error(`TTS audio response exceeded ${maxBytes} bytes.`);
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}

	throwIfAborted(signal);
	return Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
		totalBytes,
	);
}

async function runTtsCommand(
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
		this.initialization = this.refreshEngineAvailability();
	}

	public async refreshEngineAvailability(): Promise<TTSAvailability> {
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
				const activeConfig = mergeTtsConfig(this.config, options);
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
			(): void => undefined,
			(): void => undefined,
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

		if (process.platform === "linux" && requestedEngine === "auto" && config.ttsEngine === "auto") {
			push("espeak-ng");
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
		const fetchSignal = createFetchTimeoutSignal(config.commandTimeoutMs, signal);
		try {
			const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenLabsVoiceId)}`;
			const response = await this.fetchJsonPost(endpoint, { "xi-api-key": config.elevenLabsApiKey }, {
				text,
				model_id: config.elevenLabsModel,
				voice_settings: {
					stability: config.elevenLabsStability,
					similarity_boost: config.elevenLabsSimilarity,
					style: config.elevenLabsStyle,
					use_speaker_boost: true,
				},
			}, fetchSignal.signal);

			return await this.handleProviderResponse(response, tempFile, fetchSignal, signal, "elevenlabs");
		} catch (error) {
			return this.handleFetchError(error, "elevenlabs");
		} finally {
			fetchSignal.cleanup();
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
		const fetchSignal = createFetchTimeoutSignal(config.commandTimeoutMs, signal);
		try {
			const endpoint = this.normalizeOpenAIEndpoint(config.openaiTtsEndpoint);
			const headers: Record<string, string> = {
				"content-type": "application/json",
			};
			if (config.openaiTtsApiKey.trim()) {
				headers.authorization = `Bearer ${config.openaiTtsApiKey}`;
			}

			const response = await this.fetchJsonPost(endpoint, headers, {
				model: config.openaiTtsModel,
				input: text,
				voice: config.openaiTtsVoice,
				response_format: format,
				speed: config.openaiTtsSpeed,
			}, fetchSignal.signal);

			return await this.handleProviderResponse(response, tempFile, fetchSignal, signal, "openai");
		} catch (error) {
			return this.handleFetchError(error, "openai");
		} finally {
			fetchSignal.cleanup();
			await removeTempFile(tempFile);
		}
	}

	private async downloadAndPlayAudio(response: Response, tempFile: string, fetchSignal: { signal: AbortSignal; cleanup: () => void }, signal?: AbortSignal): Promise<boolean> {
		throwIfAborted(fetchSignal.signal);
		const audioBuffer = await readAudioResponseWithLimit(
			response,
			MAX_TTS_AUDIO_RESPONSE_BYTES,
			fetchSignal.signal,
		);
		await writeFile(tempFile, audioBuffer);
		throwIfAborted(signal);
		return await this.playAudioFile(tempFile, signal);
	}

	private async fetchJsonPost(endpoint: string, headers: Record<string, string>, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
		return fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			signal,
			body: JSON.stringify(body),
		});
	}

	private async handleProviderResponse(response: Response, tempFile: string, fetchSignal: { signal: AbortSignal; cleanup: () => void }, signal: AbortSignal | undefined, provider: string): Promise<boolean> {
		if (!response.ok) {
			this.debug(`tts.${provider}.http_error`, { status: response.status });
			return false;
		}
		return await this.downloadAndPlayAudio(response, tempFile, fetchSignal, signal);
	}

	private handleFetchError(error: unknown, provider: string): boolean {
		if (isAbortError(error)) {
			this.debug(`tts.${provider}.aborted`, {});
			return false;
		}
		this.debug(`tts.${provider}.error`, { error: getErrorMessage(error) });
		return false;
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
		const result = await this.runPowerShellCommand(script, config.commandTimeoutMs, signal);
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
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PiSmartVoiceNotifyTTSWinMM {
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
  public static extern int mciSendString(string command, StringBuilder buffer, int bufferSize, IntPtr hwndCallback);
}
'@ -Language CSharp
$alias = 'pi_tts_' + [Guid]::NewGuid().ToString('N')
$buffer = New-Object System.Text.StringBuilder 260
function Invoke-Mci([string]$command) {
  [void]$buffer.Clear()
  $result = [PiSmartVoiceNotifyTTSWinMM]::mciSendString($command, $buffer, $buffer.Capacity, [IntPtr]::Zero)
  if ($result -ne 0) {
    throw "MCI command failed ($result): $command"
  }
  return $buffer.ToString()
}
try {
  [void](Invoke-Mci "open \`"$path\`" type mpegvideo alias $alias")
  [void](Invoke-Mci "seek $alias to start")
  [void](Invoke-Mci "play $alias wait")
} finally {
  [void][PiSmartVoiceNotifyTTSWinMM]::mciSendString("close $alias", $null, 0, [IntPtr]::Zero)
}
`;
			const result = await this.runPowerShellCommand(script, this.config.commandTimeoutMs, signal);
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

	private async runPowerShellCommand(script: string, timeoutMs: number, signal?: AbortSignal): Promise<TTSCommandResult> {
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

		return await runTtsCommand(command, args, timeoutMs, signal);
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

export async function speakViaService(text: string, engine: TTSEngine = "auto", options: SpeakOptions = {}): Promise<boolean> {
	return await getTTSService().speak(text, engine, options);
}
