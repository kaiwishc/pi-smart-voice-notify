import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";

import { createTTSService } from "../src/tts.ts";
import type { TTSExecRunner } from "../src/types/tts.ts";

const MAX_TTS_AUDIO_RESPONSE_BYTES = 10 * 1024 * 1024;

interface CommandCall {
	args: string[];
	command: string;
}

function installFetch(t: TestContext, fetchImpl: typeof fetch): void {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
}

function createFailingExecRunner(): { calls: CommandCall[]; runner: TTSExecRunner } {
	const calls: CommandCall[] = [];
	return {
		calls,
		runner: {
			async exec(command, args) {
				calls.push({ command, args });
				return { code: 1, stdout: "", stderr: "" };
			},
		},
	};
}

function hasPlaybackCommand(calls: CommandCall[]): boolean {
	const playbackCommands = new Set(["afplay", "paplay", "aplay", "ffplay", "powershell.exe"]);
	return calls.some((call) => playbackCommands.has(call.command));
}

test("elevenlabs TTS fetch uses the configured timeout", async (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());

	const debugEvents: string[] = [];
	const { runner } = createFailingExecRunner();
	let abortObserved = false;
	let resolveFetchStarted: () => void = () => {};
	const fetchStarted = new Promise<void>((resolve) => {
		resolveFetchStarted = resolve;
	});

	installFetch(t, (async (_input, init) => {
		const signal = init?.signal as AbortSignal | undefined;
		assert.ok(signal, "expected fetch to receive an abort signal");

		return await new Promise<Response>((_resolve, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					abortObserved = true;
					reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
				},
				{ once: true },
			);
			resolveFetchStarted();
		});
	}) as typeof fetch);

	const service = createTTSService({
		config: {
			commandTimeoutMs: 3_000,
			elevenLabsApiKey: "test-elevenlabs-key",
			fallbackChain: [],
			ttsEngine: "elevenlabs",
		},
		execRunner: runner,
		debug: (event) => {
			debugEvents.push(event);
		},
	});

	const speakResult = service.speak("hello", "elevenlabs");
	await fetchStarted;
	mock.timers.tick(3_000);

	assert.equal(await speakResult, false);
	assert.equal(abortObserved, true);
	assert.ok(debugEvents.includes("tts.elevenlabs.aborted"));
});

test("openai TTS fetch rejects oversized streamed audio before playback", async (t) => {
	const debugEvents: string[] = [];
	const { calls, runner } = createFailingExecRunner();
	const chunk = new Uint8Array(1024 * 1024);
	let chunksSent = 0;

	installFetch(t, (async () => {
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunksSent += 1;
				controller.enqueue(chunk);
				if (chunksSent > MAX_TTS_AUDIO_RESPONSE_BYTES / chunk.byteLength) {
					controller.close();
				}
			},
		});
		return new Response(stream, { status: 200 });
	}) as typeof fetch);

	const service = createTTSService({
		config: {
			commandTimeoutMs: 3_000,
			fallbackChain: [],
			openaiTtsEndpoint: "https://api.example.test",
			ttsEngine: "openai",
		},
		execRunner: runner,
		debug: (event) => {
			debugEvents.push(event);
		},
	});

	assert.equal(await service.speak("hello", "openai"), false);
	assert.ok(chunksSent > MAX_TTS_AUDIO_RESPONSE_BYTES / chunk.byteLength);
	assert.ok(debugEvents.includes("tts.openai.error"));
	assert.equal(hasPlaybackCommand(calls), false);
});
