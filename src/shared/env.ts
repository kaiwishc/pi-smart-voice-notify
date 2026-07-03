/**
 * Shared environment-variable reading helpers.
 *
 * Consolidates the `readEnv`/`envString`/`fromEnv` and `parseEnvBool`/`parseBoolean`
 * duplicates that were previously redefined in config-store.ts, index.ts, tts.ts,
 * and webhook.ts.
 */

/**
 * Read the first non-empty trimmed environment variable from the given keys.
 * Returns an empty string when none are set.
 */
export function readEnvFrom(...keys: string[]): string {
	for (const key of keys) {
		const value = process.env[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return "";
}

/**
 * Parse a string as a boolean using Pi extension conventions.
 * Recognises 1/true/yes/on and 0/false/no/off (case-insensitive).
 * Returns `undefined` when the value is empty or unrecognised.
 */
export function parseEnvBoolean(value: string | undefined): boolean | undefined {
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

/**
 * Read an environment variable as a boolean with a fallback default.
 */
export function envBoolean(defaultValue: boolean, ...keys: string[]): boolean {
	const raw = readEnvFrom(...keys).toLowerCase();
	if (!raw) {
		return defaultValue;
	}
	return parseEnvBoolean(raw) ?? defaultValue;
}

/**
 * Read an environment variable as an integer with a fallback default.
 */
export function envInteger(defaultValue: number, ...keys: string[]): number {
	const raw = readEnvFrom(...keys);
	if (!raw) {
		return defaultValue;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}
