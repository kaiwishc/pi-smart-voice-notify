/**
 * Shared string-normalization helpers.
 *
 * Consolidates `normalizeOptionalString`, `normalizeAgentName`,
 * `normalizePermissionForwardingSessionId`, and related string helpers
 * that were duplicated across index.ts, permission-forwarding-watcher.ts,
 * and config-store.ts.
 */

/**
 * Normalize a value to a trimmed non-empty string, or `null`.
 */
export function normalizeNullableString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize a value to a trimmed non-empty string, or `undefined`.
 */
export function normalizeOptionalString(value: unknown): string | undefined {
	const result = normalizeNullableString(value);
	return result === null ? undefined : result;
}

/**
 * Normalize a permission-forwarding session id.
 * Returns `null` for non-strings, empty strings, or the literal "unknown".
 */
export function normalizePermissionForwardingSessionId(value: unknown): string | null {
	const trimmed = normalizeNullableString(value);
	if (!trimmed || trimmed.toLowerCase() === "unknown") {
		return null;
	}
	return trimmed;
}

/**
 * Sanitize an agent name: strip non-alphanumeric characters, collapse whitespace,
 * and cap at 48 characters. Returns `null` when the result is empty.
 */
export function sanitizeAgentName(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.replace(/[^a-zA-Z0-9._ -]/g, "").trim().replace(/\s+/g, " ");
	if (normalized.length === 0) {
		return null;
	}
	return normalized.slice(0, 48);
}

/**
 * Normalize a string array of values into a de-duplicated list of enum members.
 * Lowercases each candidate and keeps only those present in `allowed`.
 * Returns `fallback` when no candidates survive.
 */
export function normalizeStringEnumArray<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: readonly T[],
	normalizeCase: (entry: string) => string = (entry) => entry.toLowerCase(),
): T[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}
	const allowedSet = new Set(allowed.map(normalizeCase));
	const candidates = value
		.map((entry) => (typeof entry === "string" ? normalizeCase(entry.trim()) : ""))
		.filter((entry): entry is T => entry.length > 0 && allowedSet.has(entry as T));
	return candidates.length > 0 ? [...new Set(candidates)] : [...fallback];
}

/**
 * Normalize a single value into an enum member, falling back when invalid.
 */
export function normalizeStringEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
): T {
	if (typeof value === "string" && allowed.includes(value as T)) {
		return value as T;
	}
	return fallback;
}
