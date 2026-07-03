/**
 * Shared engine-specific TTS default values.
 *
 * Consolidates the duplicated edge/espeak/elevenLabs/openai TTS settings
 * that appeared in both DEFAULT_CONFIG (config-store.ts) and
 * DEFAULT_TTS_CONFIG (tts.ts).
 */

export const ENGINE_TTS_DEFAULTS = {
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
} as const;

/** Widened type for engine-specific TTS settings. */
export type EngineTtsSettings = { -readonly [K in keyof typeof ENGINE_TTS_DEFAULTS]: (typeof ENGINE_TTS_DEFAULTS)[K] extends string ? string : number };
