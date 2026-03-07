import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const PROJECT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"go.mod",
	"Cargo.toml",
	"composer.json",
	"pom.xml",
	"build.gradle",
	".pi",
] as const;

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);

export const PROJECT_SOUND_CATEGORIES = ["notification", "alert", "success", "error", "reminder"] as const;

export type ProjectSoundCategory = (typeof PROJECT_SOUND_CATEGORIES)[number];

export interface ProjectSoundContext {
	projectRoot: string;
	soundsDirectory: string;
	themeName: string;
	soundsByCategory: Record<ProjectSoundCategory, string[]>;
	soundFiles: Partial<Record<ProjectSoundCategory, string>>;
	volumeByCategory: Partial<Record<ProjectSoundCategory, number>>;
	volumeByFile: Record<string, number>;
	randomizeSounds?: boolean;
}

export interface ResolveProjectSoundOptions {
	cwd?: string;
	enabled?: boolean;
	debugLog?: (message: string) => void;
}

interface ProjectSoundsManifest {
	themeName?: string;
	randomizeSounds?: boolean;
	sounds?: Partial<Record<ProjectSoundCategory, string | string[]>>;
	soundFiles?: Partial<Record<ProjectSoundCategory, string | string[]>>;
	volumeByCategory?: Partial<Record<ProjectSoundCategory, number>>;
	volumeByFile?: Record<string, number>;
}

let activeProjectRoot: string | null = null;
const projectSoundCache = new Map<string, ProjectSoundContext | null>();

function noop(): void {
	// no-op
}

async function pathExists(pathValue: string): Promise<boolean> {
	try {
		await access(pathValue, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(pathValue: string): Promise<boolean> {
	try {
		const stats = await stat(pathValue);
		return stats.isDirectory();
	} catch {
		return false;
	}
}

async function isReadableAudioFile(pathValue: string): Promise<boolean> {
	if (!AUDIO_EXTENSIONS.has(extname(pathValue).toLowerCase())) {
		return false;
	}

	try {
		const stats = await stat(pathValue);
		if (!stats.isFile()) {
			return false;
		}
		await access(pathValue, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}

async function listAudioFiles(directory: string): Promise<string[]> {
	if (!(await isDirectory(directory))) {
		return [];
	}

	const entries = await readdir(directory, { withFileTypes: true });
	const candidates = entries
		.filter((entry) => entry.isFile())
		.map((entry) => join(directory, entry.name))
		.filter((filePath) => AUDIO_EXTENSIONS.has(extname(filePath).toLowerCase()))
		.sort((left, right) => left.localeCompare(right));

	const files: string[] = [];
	for (const filePath of candidates) {
		if (await isReadableAudioFile(filePath)) {
			files.push(resolve(filePath));
		}
	}

	return files;
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths.map((entry) => resolve(entry)))];
}

function normalizeVolume(value: number | undefined): number | undefined {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return undefined;
	}
	const clamped = Math.max(0, Math.min(100, Math.round(value)));
	return Number.isFinite(clamped) ? clamped : undefined;
}

async function hasProjectMarker(directory: string): Promise<boolean> {
	for (const marker of PROJECT_MARKERS) {
		if (await pathExists(join(directory, marker))) {
			return true;
		}
	}
	return false;
}

export async function detectProjectRoot(cwd = process.cwd()): Promise<string | null> {
	let currentDirectory = resolve(cwd);

	while (true) {
		if (await hasProjectMarker(currentDirectory)) {
			return currentDirectory;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			break;
		}
		currentDirectory = parentDirectory;
	}

	return null;
}

async function loadManifest(soundsDirectory: string): Promise<ProjectSoundsManifest | null> {
	const candidates = [
		"project-sounds.json",
		"sound-theme.json",
		"theme.json",
		"config.json",
	].map((fileName) => join(soundsDirectory, fileName));

	for (const manifestPath of candidates) {
		if (!(await pathExists(manifestPath))) {
			continue;
		}

		try {
			const raw = await readFile(manifestPath, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as ProjectSoundsManifest;
			}
		} catch {
			return null;
		}
	}

	return null;
}

async function resolveReference(reference: string, soundsDirectory: string): Promise<string | null> {
	const trimmed = reference.trim();
	if (!trimmed) {
		return null;
	}

	const absolutePath = isAbsolute(trimmed) ? trimmed : join(soundsDirectory, trimmed);
	if (await isReadableAudioFile(absolutePath)) {
		return resolve(absolutePath);
	}

	return null;
}

async function resolveCategoryEntries(
	manifest: ProjectSoundsManifest | null,
	soundsDirectory: string,
	category: ProjectSoundCategory,
): Promise<string[]> {
	const resolved: string[] = [];
	const manifestEntry = manifest?.soundFiles?.[category] ?? manifest?.sounds?.[category];

	if (typeof manifestEntry === "string") {
		const resolvedPath = await resolveReference(manifestEntry, soundsDirectory);
		if (resolvedPath) {
			resolved.push(resolvedPath);
		}
	}

	if (Array.isArray(manifestEntry)) {
		for (const entry of manifestEntry) {
			if (typeof entry !== "string") {
				continue;
			}
			const resolvedPath = await resolveReference(entry, soundsDirectory);
			if (resolvedPath) {
				resolved.push(resolvedPath);
			}
		}
	}

	resolved.push(...(await listAudioFiles(join(soundsDirectory, category))));

	for (const extension of AUDIO_EXTENSIONS) {
		const directPath = join(soundsDirectory, `${category}${extension}`);
		if (await isReadableAudioFile(directPath)) {
			resolved.push(resolve(directPath));
		}
	}

	return uniquePaths(resolved);
}

async function resolveVolumeByFile(
	soundsDirectory: string,
	volumeByFile: Record<string, number> | undefined,
): Promise<Record<string, number>> {
	if (!volumeByFile) {
		return {};
	}

	const resolved: Record<string, number> = {};
	for (const [filePath, rawVolume] of Object.entries(volumeByFile)) {
		const normalizedVolume = normalizeVolume(rawVolume);
		if (normalizedVolume === undefined) {
			continue;
		}

		const resolvedPath = await resolveReference(filePath, soundsDirectory);
		if (resolvedPath) {
			resolved[resolvedPath] = normalizedVolume;
		}
	}

	return resolved;
}

async function buildProjectSoundContext(projectRoot: string): Promise<ProjectSoundContext | null> {
	const soundsDirectory = join(projectRoot, ".pi", "sounds");
	if (!(await isDirectory(soundsDirectory))) {
		return null;
	}

	const manifest = await loadManifest(soundsDirectory);
	const soundsByCategory: Record<ProjectSoundCategory, string[]> = {
		notification: [],
		alert: [],
		success: [],
		error: [],
		reminder: [],
	};
	const soundFiles: Partial<Record<ProjectSoundCategory, string>> = {};
	for (const category of PROJECT_SOUND_CATEGORIES) {
		const entries = await resolveCategoryEntries(manifest, soundsDirectory, category);
		soundsByCategory[category] = entries;
		if (entries[0]) {
			soundFiles[category] = entries[0];
		}
	}

	const volumeByCategory: Partial<Record<ProjectSoundCategory, number>> = {};
	for (const category of PROJECT_SOUND_CATEGORIES) {
		const normalizedVolume = normalizeVolume(manifest?.volumeByCategory?.[category]);
		if (normalizedVolume !== undefined) {
			volumeByCategory[category] = normalizedVolume;
		}
	}

	const volumeByFile = await resolveVolumeByFile(soundsDirectory, manifest?.volumeByFile);

	return {
		projectRoot,
		soundsDirectory,
		themeName: manifest?.themeName?.trim() || `project:${basename(projectRoot)}`,
		soundsByCategory,
		soundFiles,
		volumeByCategory,
		volumeByFile,
		randomizeSounds: manifest?.randomizeSounds,
	};
}

export async function resolveProjectSoundContext(
	options: ResolveProjectSoundOptions = {},
): Promise<ProjectSoundContext | null> {
	const debugLog = options.debugLog ?? noop;
	if (options.enabled === false) {
		return null;
	}

	const projectRoot = await detectProjectRoot(options.cwd);
	if (projectRoot !== activeProjectRoot) {
		projectSoundCache.clear();
		activeProjectRoot = projectRoot;
		debugLog(`per-project-sound: active project changed to '${projectRoot ?? "none"}', cache cleared`);
	}

	if (!projectRoot) {
		return null;
	}

	if (projectSoundCache.has(projectRoot)) {
		return projectSoundCache.get(projectRoot) ?? null;
	}

	const context = await buildProjectSoundContext(projectRoot);
	projectSoundCache.set(projectRoot, context);
	if (!context) {
		debugLog(`per-project-sound: no project sounds found for '${projectRoot}'`);
		return null;
	}

	debugLog(`per-project-sound: loaded sounds from '${context.soundsDirectory}'`);
	return context;
}

export function clearProjectSoundCache(): void {
	projectSoundCache.clear();
	activeProjectRoot = null;
}
