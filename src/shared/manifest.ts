/**
 * Shared JSON manifest-loading helpers.
 *
 * Consolidates the duplicated `loadManifest`/manifest-reading logic that
 * existed in both per-project-sound.ts and sound-theme.ts, and the
 * `readJsonFromFile` helper in permission-forwarding-watcher.ts.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read and parse a JSON file, returning a typed record or `null`.
 * Returns `null` if the file is missing, unreadable, not a JSON object,
 * or an array.
 */
export async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Coerce an unknown value into a record, returning `{}` for non-objects/arrays.
 */
export function toRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

/**
 * Load the first existing manifest from a list of candidate filenames inside
 * a base directory. Returns the parsed record or `null` when none exist or
 * all are invalid.
 */
export async function loadManifestRecord(
	baseDirectory: string,
	candidateNames: readonly string[],
): Promise<Record<string, unknown> | null> {
	for (const name of candidateNames) {
		const manifestPath = join(baseDirectory, name);
		const record = await readJsonRecord(manifestPath);
		if (record) {
			return record;
		}
	}
	return null;
}
