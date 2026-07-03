/**
 * Shared utilities for pi-smart-voice-notify.
 *
 * Centralizes env readers, numeric clamps, string normalizers, command helpers,
 * and manifest loaders that were previously duplicated across source modules.
 */
export {
	readEnvFrom,
	parseEnvBoolean,
	envBoolean,
	envInteger,
} from "./env.ts";

export {
	parseNumeric,
	clampInt,
	clampNumber,
	normalizeFloat,
	clampRoundedInt,
} from "./numbers.ts";

export {
	normalizeOptionalString,
	normalizeNullableString,
	normalizePermissionForwardingSessionId,
	sanitizeAgentName,
	normalizeStringEnumArray,
	normalizeStringEnum,
} from "./strings.ts";

export { buildCommandString, attachChildHandlers } from "./command.ts";

export {
	readJsonRecord,
	toRecord,
	loadManifestRecord,
} from "./manifest.ts";

/**
 * Create an empty sound-by-category map.
 */
export function emptySoundsByCategory<C extends string>(categories: readonly C[]): Record<C, string[]> {
	return Object.fromEntries(categories.map((c) => [c, []])) as Record<C, string[]>;
}

export { ENGINE_TTS_DEFAULTS } from "./tts-defaults.ts";
export type { EngineTtsSettings } from "./tts-defaults.ts";
