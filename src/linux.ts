import { spawn } from "child_process";

import { getErrorMessage } from "./logging.ts";
import type {
	LinuxCommandResult,
	LinuxSessionInfo,
	LinuxSessionType,
	LinuxUtilsOptions,
} from "./types/linux.ts";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_AUDIO_TIMEOUT_MS = 20_000;
type DebugLog = (message: string) => void;

function createDebugLog(options?: LinuxUtilsOptions): DebugLog {
	return options?.debugLog ?? (() => {});
}

function buildCommandString(command: string, args: string[]): string {
	if (args.length === 0) {
		return command;
	}
	return `${command} ${args.join(" ")}`;
}

async function runSpawnCommand(
	command: string,
	args: string[],
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LinuxCommandResult> {
	return await new Promise<LinuxCommandResult>((resolve) => {
		const child = spawn(command, args, { env: process.env });
		const fullCommand = buildCommandString(command, args);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let spawnError: Error | null = null;

		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			spawnError = error;
		});

		child.on("close", (exitCode, signal) => {
			clearTimeout(timeout);
			const success = exitCode === 0 && !timedOut && !spawnError;
			resolve({
				command,
				args,
				exitCode,
				signal,
				stdout,
				stderr,
				success,
				timedOut,
				errorMessage: timedOut
					? `Command timed out after ${timeoutMs}ms: ${fullCommand}`
					: spawnError
						? getErrorMessage(spawnError)
						: undefined,
			});
		});
	});
}

function parsePactlVolume(output: string): number {
	const match = output.match(/(\d+)%/);
	if (!match?.[1]) {
		return -1;
	}
	const volume = Number.parseInt(match[1], 10);
	if (!Number.isFinite(volume)) {
		return -1;
	}
	return volume;
}

function parseAmixerVolume(output: string): number {
	const match = output.match(/\[(\d+)%\]/);
	if (!match?.[1]) {
		return -1;
	}
	const volume = Number.parseInt(match[1], 10);
	if (!Number.isFinite(volume)) {
		return -1;
	}
	return volume;
}

function normalizeSessionType(value: string | undefined): LinuxSessionType {
	if (value === "x11" || value === "wayland" || value === "tty") {
		return value;
	}
	return "unknown";
}

export function detectLinuxSession(env: NodeJS.ProcessEnv = process.env): LinuxSessionInfo {
	const fromSessionType = normalizeSessionType(env.XDG_SESSION_TYPE?.toLowerCase());
	const hasWaylandDisplay = Boolean(env.WAYLAND_DISPLAY);
	const hasX11Display = Boolean(env.DISPLAY) && !hasWaylandDisplay;

	let sessionType = fromSessionType;
	if (sessionType === "unknown") {
		if (hasWaylandDisplay) {
			sessionType = "wayland";
		} else if (hasX11Display) {
			sessionType = "x11";
		} else if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
			sessionType = "tty";
		}
	}

	return {
		sessionType,
		isX11: sessionType === "x11",
		isWayland: sessionType === "wayland",
		display: env.DISPLAY ?? null,
		waylandDisplay: env.WAYLAND_DISPLAY ?? null,
	};
}

export async function wakeMonitor(options: LinuxUtilsOptions = {}): Promise<boolean> {
	const debugLog = createDebugLog(options);
	if (process.platform !== "linux") {
		debugLog(`wakeMonitor: skipped on non-Linux platform ${process.platform}`);
		return false;
	}

	const session = detectLinuxSession();
	const wakeCommands = [
		{
			name: "xset",
			command: "xset",
			args: ["dpms", "force", "on"],
		},
		{
			name: "gdbus",
			command: "gdbus",
			args: [
				"call",
				"--session",
				"--dest",
				"org.gnome.SettingsDaemon.Power",
				"--object-path",
				"/org/gnome/SettingsDaemon/Power",
				"--method",
				"org.gnome.SettingsDaemon.Power.Screen.StepUp",
			],
		},
	];

	const ordered = session.isWayland
		? [wakeCommands[1], wakeCommands[0]]
		: [wakeCommands[0], wakeCommands[1]];

	for (const wakeCommand of ordered) {
		const result = await runSpawnCommand(wakeCommand.command, wakeCommand.args, DEFAULT_TIMEOUT_MS);
		if (result.success) {
			debugLog(`wakeMonitor: ${wakeCommand.name} succeeded`);
			return true;
		}
		debugLog(
			`wakeMonitor: ${wakeCommand.name} failed (exitCode=${result.exitCode}, stderr=${result.stderr.trim() || result.errorMessage || "none"})`,
		);
	}

	debugLog(`wakeMonitor: all methods failed for session ${session.sessionType}`);
	return false;
}

export async function getCurrentVolume(options: LinuxUtilsOptions = {}): Promise<number> {
	const debugLog = createDebugLog(options);
	if (process.platform !== "linux") {
		debugLog(`getCurrentVolume: unsupported platform ${process.platform}`);
		return -1;
	}

	const pulseResult = await runSpawnCommand("pactl", ["get-sink-volume", "@DEFAULT_SINK@"]);
	if (pulseResult.success) {
		const pulseVolume = parsePactlVolume(pulseResult.stdout);
		if (pulseVolume >= 0) {
			return pulseVolume;
		}
		debugLog("getCurrentVolume: pactl output could not be parsed, falling back to ALSA");
	} else {
		debugLog(
			`getCurrentVolume: pactl failed (exitCode=${pulseResult.exitCode}, stderr=${pulseResult.stderr.trim() || pulseResult.errorMessage || "none"})`,
		);
	}

	const alsaResult = await runSpawnCommand("amixer", ["get", "Master"]);
	if (!alsaResult.success) {
		debugLog(
			`getCurrentVolume: amixer failed (exitCode=${alsaResult.exitCode}, stderr=${alsaResult.stderr.trim() || alsaResult.errorMessage || "none"})`,
		);
		return -1;
	}

	const alsaVolume = parseAmixerVolume(alsaResult.stdout);
	if (alsaVolume < 0) {
		debugLog("getCurrentVolume: amixer output could not be parsed");
	}
	return alsaVolume;
}

export async function setVolume(volume: number, options: LinuxUtilsOptions = {}): Promise<boolean> {
	const debugLog = createDebugLog(options);
	if (!Number.isFinite(volume)) {
		throw new Error(`setVolume: expected a finite number, received ${String(volume)}`);
	}
	if (process.platform !== "linux") {
		debugLog(`setVolume: unsupported platform ${process.platform}`);
		return false;
	}

	const clampedVolume = Math.max(0, Math.min(100, Math.round(volume)));

	const pulseResult = await runSpawnCommand("pactl", [
		"set-sink-volume",
		"@DEFAULT_SINK@",
		`${clampedVolume}%`,
	]);
	if (pulseResult.success) {
		return true;
	}
	debugLog(
		`setVolume: pactl failed (exitCode=${pulseResult.exitCode}, stderr=${pulseResult.stderr.trim() || pulseResult.errorMessage || "none"}), falling back to ALSA`,
	);

	const alsaResult = await runSpawnCommand("amixer", ["set", "Master", `${clampedVolume}%`, "unmute"]);
	if (!alsaResult.success) {
		debugLog(
			`setVolume: amixer failed (exitCode=${alsaResult.exitCode}, stderr=${alsaResult.stderr.trim() || alsaResult.errorMessage || "none"})`,
		);
		return false;
	}

	return true;
}

export async function playAudio(
	filePath: string,
	loops = 1,
	options: LinuxUtilsOptions = {},
): Promise<boolean> {
	const debugLog = createDebugLog(options);
	if (!filePath.trim()) {
		throw new Error("playAudio: filePath must be a non-empty string");
	}
	if (process.platform !== "linux") {
		debugLog(`playAudio: unsupported platform ${process.platform}`);
		return false;
	}

	const playCount = Math.max(1, Math.min(20, Math.floor(loops)));
	for (let attempt = 0; attempt < playCount; attempt += 1) {
		const pulseResult = await runSpawnCommand("paplay", [filePath], DEFAULT_AUDIO_TIMEOUT_MS);
		if (pulseResult.success) {
			continue;
		}

		debugLog(
			`playAudio: paplay failed (exitCode=${pulseResult.exitCode}, stderr=${pulseResult.stderr.trim() || pulseResult.errorMessage || "none"}), falling back to aplay`,
		);

		const alsaResult = await runSpawnCommand("aplay", [filePath], DEFAULT_AUDIO_TIMEOUT_MS);
		if (alsaResult.success) {
			continue;
		}

		debugLog(
			`playAudio: aplay failed (exitCode=${alsaResult.exitCode}, stderr=${alsaResult.stderr.trim() || alsaResult.errorMessage || "none"})`,
		);
		return false;
	}

	return true;
}

export async function getIdleTime(options: LinuxUtilsOptions = {}): Promise<number> {
	const debugLog = createDebugLog(options);
	if (process.platform !== "linux") {
		debugLog(`getIdleTime: unsupported platform ${process.platform}`);
		return -1;
	}

	const result = await runSpawnCommand("xprintidle", [], 6_000);
	if (!result.success) {
		debugLog(
			`getIdleTime: xprintidle failed (exitCode=${result.exitCode}, stderr=${result.stderr.trim() || result.errorMessage || "none"})`,
		);
		return -1;
	}

	const idleMs = Number.parseInt(result.stdout.trim(), 10);
	if (!Number.isFinite(idleMs) || idleMs < 0) {
		debugLog(`getIdleTime: unable to parse xprintidle output: ${result.stdout.trim()}`);
		return -1;
	}

	return Math.floor(idleMs / 1000);
}
