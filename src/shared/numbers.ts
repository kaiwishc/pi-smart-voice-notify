/**
 * Shared numeric clamp/normalize helpers.
 *
 * Consolidates the `clampInt`, `clampNumber`, `normalizeFloat`,
 * `clampTimeoutSeconds`, `normalizeRate`, and `normalizePositiveInt`
 * duplicates that were previously redefined across config-store.ts,
 * desktop-notify.ts, tts.ts, and ai-messages.ts.
 */

/**
 * Parse an unknown value into a finite number, or `undefined`.
 */
export function parseNumeric(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

/**
 * Clamp a numeric value to [min, max] with optional rounding.
 * Returns `fallback` when the value is not finite.
 */
function clampFiniteNumber(value: number, fallback: number, min: number, max: number, round?: (n: number) => number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	const clamped = Math.min(max, Math.max(min, value));
	return round ? round(clamped) : clamped;
}

/**
 * Parse an unknown value, returning `fallback` if not numeric.
 */
function resolveClampedValue(value: unknown, fallback: number, min: number, max: number, round?: (n: number) => number): number {
	const numeric = parseNumeric(value);
	if (numeric === undefined) {
		return fallback;
	}
	return clampFiniteNumber(numeric, fallback, min, max, round);
}

/**
 * Clamp an unknown value to a truncated integer within [min, max].
 * Returns `fallback` when the value is not a finite number.
 */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	return resolveClampedValue(value, fallback, min, max, Math.trunc);
}

/**
 * Clamp an unknown value to a number within [min, max] (no truncation).
 * Returns `fallback` when the value is not a finite number.
 */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	return resolveClampedValue(value, fallback, min, max);
}

/**
 * Clamp a finite number to [min, max] (no rounding/truncation).
 * Returns `fallback` when the value is not finite.
 */
export function normalizeFloat(value: number, fallback: number, min: number, max: number): number {
	return clampFiniteNumber(value, fallback, min, max);
}

/**
 * Clamp a finite number to a rounded integer within [min, max].
 * Returns `fallback` when the value is not finite.
 */
export function clampRoundedInt(value: number, fallback: number, min: number, max: number): number {
	return clampFiniteNumber(value, fallback, min, max, Math.round);
}