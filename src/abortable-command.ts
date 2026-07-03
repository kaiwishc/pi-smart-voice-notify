import { spawn } from "node:child_process";
import { basename } from "node:path";

import { buildCommandString, attachChildHandlers } from "./shared/index.ts";

const ALLOWED_ABORTABLE_COMMANDS = new Set([
	"aplay",
	"edge-tts",
	"espeak-ng",
	"ffplay",
	"gdbus",
	"paplay",
	"powershell",
	"powershell.exe",
	"swaymsg",
	"where",
	"which",
	"xdotool",
	"xprop",
]);

function normalizeCommandName(command: string): string {
	return basename(command).trim().toLowerCase();
}

function isAllowedAbortableCommand(command: string): boolean {
	const normalized = normalizeCommandName(command);
	const nodeExecutable = normalizeCommandName(process.execPath);
	return normalized === nodeExecutable || ALLOWED_ABORTABLE_COMMANDS.has(normalized);
}

export interface AbortableCommandOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

export interface AbortableCommandResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	errorMessage?: string;
}

function stringifyError(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function stopChildProcess(child: ReturnType<typeof spawn>, force = false): void {
	if (child.killed) {
		return;
	}

	try {
		if (process.platform === "win32") {
			child.kill();
			return;
		}
		child.kill(force ? "SIGKILL" : "SIGTERM");
	} catch (error) {
		// Killing a process that has already exited can throw on some platforms;
		// the error is non-actionable for shutdown/abort flows.
		void error;
	}
}

export async function runAbortableCommand(
	command: string,
	args: readonly string[] = [],
	options: AbortableCommandOptions = {},
): Promise<AbortableCommandResult> {
	const normalizedCommand = command.trim();
	if (!normalizedCommand) {
		throw new Error("runAbortableCommand: command must be a non-empty string");
	}
	if (!Array.isArray(args)) {
		throw new Error("runAbortableCommand: args must be an array of strings");
	}
	if (!isAllowedAbortableCommand(normalizedCommand)) {
		throw new Error(`runAbortableCommand: command is not allowlisted: ${normalizedCommand}`);
	}

	const commandLabel = buildCommandString(normalizedCommand, args);
	if (options.signal?.aborted) {
		return {
			code: 1,
			stdout: "",
			stderr: "",
			timedOut: false,
			aborted: true,
			errorMessage: `Command aborted before start: ${commandLabel}`,
		};
	}

	return await new Promise<AbortableCommandResult>((resolve) => {
		const child = spawn(normalizedCommand, Array.from(args), { // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- normalizedCommand is checked against ALLOWED_ABORTABLE_COMMANDS (plus the current Node executable for tests) before spawn; args are passed as an array with shell disabled.
			env: options.env ?? process.env,
			cwd: options.cwd,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let spawnError: Error | null = null;
		let forceKillTimer: NodeJS.Timeout | null = null;

		const cleanup = (): void => {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			if (forceKillTimer) {
				clearTimeout(forceKillTimer);
				forceKillTimer = null;
			}
			options.signal?.removeEventListener("abort", onAbort);
		};

		const scheduleForceKill = (): void => {
			if (process.platform === "win32" || forceKillTimer) {
				return;
			}
			forceKillTimer = setTimeout(() => {
				stopChildProcess(child, true);
			}, 750);
		};

		const onAbort = (): void => {
			aborted = true;
			stopChildProcess(child);
			scheduleForceKill();
		};

		const timeoutMs = typeof options.timeoutMs === "number" ? Math.max(1, Math.floor(options.timeoutMs)) : 0;
		const timeoutTimer =
			timeoutMs > 0
				? setTimeout(() => {
					timedOut = true;
					stopChildProcess(child);
					scheduleForceKill();
				}, timeoutMs)
				: null;

		options.signal?.addEventListener("abort", onAbort, { once: true });

		attachChildHandlers(child, (text: string) => { stdout += text; }, (text: string) => { stderr += text; }, (error: Error) => { spawnError = error; });

		child.on("close", (code: number | null) => {
			cleanup();
			resolve({
				code: code ?? (spawnError || timedOut || aborted ? 1 : 0),
				stdout,
				stderr,
				timedOut,
				aborted,
				errorMessage: spawnError
					? stringifyError(spawnError)
					: timedOut
						? `Command timed out after ${timeoutMs}ms: ${commandLabel}`
						: aborted
							? `Command aborted: ${commandLabel}`
							: undefined,
			});
		});
	});
}
