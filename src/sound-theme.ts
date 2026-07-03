import { constants as fsConstants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getCurrentVolume, playAudio, setVolume } from "./linux.ts";
import {
	AUDIO_EXTENSIONS,
	isDirectory as checkIsDirectory,
	isReadableAudioFile as checkIsReadableAudioFile,
	listAudioFiles as listProjectAudioFiles,
	noop,
	normalizeVolume,
	resolveProjectSoundContext,
	uniquePaths,
} from "./per-project-sound.ts";
import { loadManifestRecord, emptySoundsByCategory } from "./shared/index.ts";

export const SOUND_CATEGORIES = ["notification", "alert", "success", "error", "reminder"] as const;

export type SoundCategory = (typeof SOUND_CATEGORIES)[number];

type CategorySoundMap = Partial<Record<SoundCategory, string>>;
type CategoryVolumeMap = Partial<Record<SoundCategory, number>>;
type FileVolumeMap = Record<string, number>;

export interface SoundThemeConfig {
	themeName?: string;
	themeDirectory?: string;
	themesRootDirectory?: string;
	themeConfigPath?: string;
	projectCwd?: string;
	enablePerProjectSounds?: boolean;
	randomizeSounds?: boolean;
	defaultVolume?: number;
	soundFiles?: CategorySoundMap;
	volumeByCategory?: CategoryVolumeMap;
	volumeByFile?: FileVolumeMap;
	customSoundDirectories?: string[];
	themeOverride?: {
		themeName?: string;
		themeDirectory?: string;
		soundFiles?: CategorySoundMap;
		volumeByCategory?: CategoryVolumeMap;
		volumeByFile?: FileVolumeMap;
		randomizeSounds?: boolean;
	};
}

interface ThemeManifest {
	sounds?: Partial<Record<SoundCategory, string | string[]>>;
	volumeByCategory?: CategoryVolumeMap;
	volumeByFile?: FileVolumeMap;
	randomizeSounds?: boolean;
}

export interface ResolvedSoundTheme {
	themeName: string;
	themeDirectory: string | null;
	searchDirectories: string[];
	soundsByCategory: Record<SoundCategory, string[]>;
	volumeByCategory: Record<SoundCategory, number | null>;
	volumeByFile: Record<string, number>;
	randomizeSounds: boolean;
}

export interface ResolvedSoundSelection {
	eventType: string;
	category: SoundCategory;
	candidates: string[];
	volumeByCategory: number | null;
	volumeByFile: Record<string, number>;
	themeName: string;
}

export interface SoundThemeServiceOptions {
	assetsDirectory?: string;
	debugLog?: (message: string) => void;
}

const EVENT_TO_CATEGORY: Record<string, SoundCategory> = {
	notification: "notification",
	alert: "alert",
	success: "success",
	error: "error",
	reminder: "reminder",
	idle: "success",
	permission: "alert",
	question: "notification",
	complete: "success",
	completed: "success",
	completion: "success",
	agent_complete: "success",
	agent_completed: "success",
	task_complete: "success",
	task_completed: "success",
	taskcomplete: "success",
	taskcompleted: "success",
};

const DEFAULT_ASSETS_DIRECTORY = fileURLToPath(new URL("../assets", import.meta.url));

type DebugLog = (message: string) => void;

async function isReadable(pathValue: string): Promise<boolean> {
	try {
		await access(pathValue, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}

const isDirectory = checkIsDirectory;

const isReadableAudioFile = checkIsReadableAudioFile;

const listAudioFiles = listProjectAudioFiles;

async function resolveSoundReference(reference: string, searchDirectories: string[]): Promise<string | null> {
	const trimmed = reference.trim();
	if (!trimmed) {
		return null;
	}

	const candidatePaths = isAbsolute(trimmed)
		? [trimmed]
		: searchDirectories.map((directory) => resolve(directory, trimmed));

	for (const candidatePath of candidatePaths) {
		if (await isReadableAudioFile(candidatePath)) {
			return candidatePath;
		}
	}

	return null;
}

function mapEventTypeToCategory(eventType: string): SoundCategory {
	const normalizedEvent = eventType.trim().toLowerCase();
	return EVENT_TO_CATEGORY[normalizedEvent] ?? "notification";
}

function pickSound(candidates: string[], randomize: boolean): string[] {
	if (candidates.length <= 1 || !randomize) {
		return [...candidates];
	}
	const randomIndex = Math.floor(Math.random() * candidates.length);
	const selected = candidates[randomIndex];
	const rest = candidates.filter((_, index) => index !== randomIndex);
	return selected ? [selected, ...rest] : [...candidates];
}

async function loadThemeManifest(themeDirectory: string): Promise<ThemeManifest | null> {
	const manifestCandidates = ["theme.json", "sound-theme.json"];
	const record = await loadManifestRecord(themeDirectory, manifestCandidates);
	return record as ThemeManifest | null;
}

async function loadConfigFromFile(configPath: string | undefined): Promise<SoundThemeConfig> {
	if (!configPath) {
		return {};
	}
	if (!(await isReadable(configPath))) {
		return {};
	}

	try {
		const content = await readFile(configPath, "utf-8");
		const parsed = JSON.parse(content) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		return parsed as SoundThemeConfig;
	} catch {
		return {};
	}
}

function mergeConfig(base: SoundThemeConfig, current: SoundThemeConfig): SoundThemeConfig {
	const merged: SoundThemeConfig = {
		...base,
		...current,
		soundFiles: {
			...(base.soundFiles ?? {}),
			...(current.soundFiles ?? {}),
		},
		volumeByCategory: {
			...(base.volumeByCategory ?? {}),
			...(current.volumeByCategory ?? {}),
		},
		volumeByFile: {
			...(base.volumeByFile ?? {}),
			...(current.volumeByFile ?? {}),
		},
		customSoundDirectories: current.customSoundDirectories ?? base.customSoundDirectories,
	};

	if (!current.themeOverride) {
		return merged;
	}

	return {
		...merged,
		themeName: current.themeOverride.themeName ?? merged.themeName,
		themeDirectory: current.themeOverride.themeDirectory ?? merged.themeDirectory,
		randomizeSounds: current.themeOverride.randomizeSounds ?? merged.randomizeSounds,
		soundFiles: {
			...(merged.soundFiles ?? {}),
			...(current.themeOverride.soundFiles ?? {}),
		},
		volumeByCategory: {
			...(merged.volumeByCategory ?? {}),
			...(current.themeOverride.volumeByCategory ?? {}),
		},
		volumeByFile: {
			...(merged.volumeByFile ?? {}),
			...(current.themeOverride.volumeByFile ?? {}),
		},
	};
}

async function buildFallbackSounds(assetsDirectory: string): Promise<Record<SoundCategory, string[]>> {
	const available = await listAudioFiles(assetsDirectory);
	const primary = available[0] ? [available[0]] : [];
	const secondary = available[1] ? [available[1]] : primary;

	return {
		notification: primary,
		alert: secondary,
		success: primary,
		error: secondary,
		reminder: primary,
	};
}

async function resolveThemeDirectories(config: SoundThemeConfig, assetsDirectory: string): Promise<string[]> {
	const directories: string[] = [];
	if (config.themeDirectory) {
		directories.push(config.themeDirectory);
	}
	if (config.themesRootDirectory && config.themeName) {
		directories.push(join(config.themesRootDirectory, config.themeName));
	}
	for (const customDirectory of config.customSoundDirectories ?? []) {
		directories.push(customDirectory);
	}
	directories.push(dirname(assetsDirectory));
	directories.push(assetsDirectory);

	const uniqueDirectories = uniquePaths(directories);
	const existingDirectories: string[] = [];
	for (const directory of uniqueDirectories) {
		if (await isDirectory(directory)) {
			existingDirectories.push(directory);
		}
	}
	return existingDirectories;
}

async function resolveThemeVolumeByFile(
	volumeByFile: Record<string, number>,
	searchDirectories: string[],
): Promise<Record<string, number>> {
	const resolved: Record<string, number> = {};

	for (const [sourcePath, rawVolume] of Object.entries(volumeByFile)) {
		const volume = normalizeVolume(rawVolume);
		if (volume === null) {
			continue;
		}

		const resolvedPath = await resolveSoundReference(sourcePath, searchDirectories);
		if (resolvedPath) {
			resolved[resolve(resolvedPath)] = volume;
		}
	}

	return resolved;
}

export class SoundThemeService {
	private readonly assetsDirectory: string;
	private readonly debugLog: DebugLog;

	public constructor(options: SoundThemeServiceOptions = {}) {
		this.assetsDirectory = resolve(options.assetsDirectory ?? DEFAULT_ASSETS_DIRECTORY);
		this.debugLog = options.debugLog ?? noop;
	}

	public async loadTheme(config: SoundThemeConfig): Promise<ResolvedSoundTheme> {
		const fileConfig = await loadConfigFromFile(config.themeConfigPath);
		const mergedConfig = mergeConfig(fileConfig, config);
		const projectContext = await resolveProjectSoundContext({
			cwd: mergedConfig.projectCwd,
			enabled: mergedConfig.enablePerProjectSounds,
			debugLog: this.debugLog,
		});

		const directories = await resolveThemeDirectories(
			{
				...mergedConfig,
				customSoundDirectories: projectContext
					? [projectContext.soundsDirectory, ...(mergedConfig.customSoundDirectories ?? [])]
					: mergedConfig.customSoundDirectories,
			},
			this.assetsDirectory,
		);

		const assetsRootDirectory = resolve(dirname(this.assetsDirectory));
		const themeDirectory =
			projectContext?.soundsDirectory ??
			directories.find(
				(directory) => directory !== this.assetsDirectory && directory !== assetsRootDirectory,
			) ??
			null;
		const manifest = themeDirectory ? await loadThemeManifest(themeDirectory) : null;
		const fallbackSounds = await buildFallbackSounds(this.assetsDirectory);
		const soundsByCategory = emptySoundsByCategory(SOUND_CATEGORIES);

		for (const category of SOUND_CATEGORIES) {
			const categoryCandidates: string[] = [];
			categoryCandidates.push(...(projectContext?.soundsByCategory[category] ?? []));

			const projectSound = projectContext?.soundFiles[category];
			if (projectSound) {
				const resolvedFromProjectConfig = await resolveSoundReference(projectSound, directories);
				if (resolvedFromProjectConfig) {
					categoryCandidates.push(resolvedFromProjectConfig);
				}
			}

			const configSound = mergedConfig.soundFiles?.[category];
			if (configSound) {
				const resolvedFromConfig = await resolveSoundReference(configSound, directories);
				if (resolvedFromConfig) {
					categoryCandidates.push(resolvedFromConfig);
				}
			}

			const manifestSound = manifest?.sounds?.[category];
			if (typeof manifestSound === "string") {
				const resolvedFromManifest = await resolveSoundReference(manifestSound, directories);
				if (resolvedFromManifest) {
					categoryCandidates.push(resolvedFromManifest);
				}
			}
			if (Array.isArray(manifestSound)) {
				for (const entry of manifestSound) {
					if (typeof entry !== "string") {
						continue;
					}
					const resolvedFromManifest = await resolveSoundReference(entry, directories);
					if (resolvedFromManifest) {
						categoryCandidates.push(resolvedFromManifest);
					}
				}
			}

			for (const directory of directories) {
				const categoryDir = join(directory, category);
				const fromCategoryDirectory = await listAudioFiles(categoryDir);
				categoryCandidates.push(...fromCategoryDirectory);

				for (const extension of AUDIO_EXTENSIONS) {
					const directFile = join(directory, `${category}${extension}`);
					if (await isReadableAudioFile(directFile)) {
						categoryCandidates.push(directFile);
					}
				}
			}

			const uniqueCategoryCandidates = uniquePaths(categoryCandidates);
			if (uniqueCategoryCandidates.length > 0) {
				soundsByCategory[category] = uniqueCategoryCandidates;
				continue;
			}
			soundsByCategory[category] = fallbackSounds[category];
		}

		const mergedVolumeByCategory: Record<SoundCategory, number | null> = {
			notification: normalizeVolume(
				projectContext?.volumeByCategory.notification ??
					mergedConfig.volumeByCategory?.notification ??
					manifest?.volumeByCategory?.notification ??
					mergedConfig.defaultVolume,
			),
			alert: normalizeVolume(
				projectContext?.volumeByCategory.alert ??
					mergedConfig.volumeByCategory?.alert ??
					manifest?.volumeByCategory?.alert ??
					mergedConfig.defaultVolume,
			),
			success: normalizeVolume(
				projectContext?.volumeByCategory.success ??
					mergedConfig.volumeByCategory?.success ??
					manifest?.volumeByCategory?.success ??
					mergedConfig.defaultVolume,
			),
			error: normalizeVolume(
				projectContext?.volumeByCategory.error ??
					mergedConfig.volumeByCategory?.error ??
					manifest?.volumeByCategory?.error ??
					mergedConfig.defaultVolume,
			),
			reminder: normalizeVolume(
				projectContext?.volumeByCategory.reminder ??
					mergedConfig.volumeByCategory?.reminder ??
					manifest?.volumeByCategory?.reminder ??
					mergedConfig.defaultVolume,
			),
		};

		const mergedVolumeByFile = await resolveThemeVolumeByFile(
			{
				...(manifest?.volumeByFile ?? {}),
				...(mergedConfig.volumeByFile ?? {}),
				...(projectContext?.volumeByFile ?? {}),
			},
			directories,
		);

		const randomizeSounds =
			projectContext?.randomizeSounds ??
			mergedConfig.randomizeSounds ??
			mergedConfig.themeOverride?.randomizeSounds ??
			manifest?.randomizeSounds ??
			true;

		return {
			themeName: projectContext?.themeName ?? mergedConfig.themeName ?? "default",
			themeDirectory,
			searchDirectories: directories,
			soundsByCategory,
			volumeByCategory: mergedVolumeByCategory,
			volumeByFile: mergedVolumeByFile,
			randomizeSounds,
		};
	}

	public async resolveEventSound(eventType: string, config: SoundThemeConfig): Promise<ResolvedSoundSelection | null> {
		const theme = await this.loadTheme(config);
		const category = mapEventTypeToCategory(eventType);
		const sounds = theme.soundsByCategory[category] ?? [];
		if (sounds.length === 0) {
			this.debugLog(`sound-theme: no sounds available for category '${category}'`);
			return null;
		}

		const candidates = pickSound(sounds, theme.randomizeSounds);
		return {
			eventType,
			category,
			candidates,
			volumeByCategory: theme.volumeByCategory[category],
			volumeByFile: theme.volumeByFile,
			themeName: theme.themeName,
		};
	}

	public async playEventSound(eventType: string, config: SoundThemeConfig, loops = 1): Promise<boolean> {
		const selection = await this.resolveEventSound(eventType, config);
		if (!selection) {
			return false;
		}

		const playCount = Math.max(1, Math.min(20, Math.floor(loops)));
		let initialVolume = -1;
		let volumeWasChanged = false;

		for (const candidate of selection.candidates) {
			if (!(await isReadableAudioFile(candidate))) {
				this.debugLog(`sound-theme: missing or unreadable sound file '${candidate}', trying fallback candidate`);
				continue;
			}

			const candidateVolume = selection.volumeByFile[resolve(candidate)] ?? selection.volumeByCategory;
			if (typeof candidateVolume === "number") {
				if (initialVolume < 0) {
					initialVolume = await getCurrentVolume({ debugLog: this.debugLog });
				}
				if (initialVolume >= 0 && initialVolume !== candidateVolume) {
					const changed = await setVolume(candidateVolume, { debugLog: this.debugLog });
					volumeWasChanged = volumeWasChanged || changed;
				}
			}

			const played = await playAudio(candidate, playCount, { debugLog: this.debugLog });
			if (played) {
				if (volumeWasChanged && initialVolume >= 0) {
					await setVolume(initialVolume, { debugLog: this.debugLog });
				}
				this.debugLog(
					`sound-theme: played '${basename(candidate)}' for '${eventType}' (${selection.themeName}/${selection.category})`,
				);
				return true;
			}

			this.debugLog(`sound-theme: playback failed for '${candidate}', trying fallback candidate`);
		}

		if (volumeWasChanged && initialVolume >= 0) {
			await setVolume(initialVolume, { debugLog: this.debugLog });
		}
		this.debugLog(`sound-theme: all sound candidates failed for '${eventType}'`);
		return false;
	}
}

export async function loadSoundTheme(config: SoundThemeConfig): Promise<ResolvedSoundTheme> {
	const service = new SoundThemeService();
	return await service.loadTheme(config);
}

export async function resolveSoundForEvent(
	eventType: string,
	config: SoundThemeConfig,
): Promise<ResolvedSoundSelection | null> {
	const service = new SoundThemeService();
	return await service.resolveEventSound(eventType, config);
}

export async function playThemeSound(eventType: string, config: SoundThemeConfig, loops = 1): Promise<boolean> {
	const service = new SoundThemeService();
	return await service.playEventSound(eventType, config, loops);
}

export const soundThemeCategories = SOUND_CATEGORIES;
export const eventCategoryMap = EVENT_TO_CATEGORY;
export const getSoundCategoryFromEvent = mapEventTypeToCategory;
