import { spawn } from "node:child_process";

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

function buildCommandString(command: string, args: readonly string[]): string {
	return args.length > 0 ? `${command} ${args.join(" ")}` : command;
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
	} catch {
		// noop
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
		const child = spawn(normalizedCommand, [...args], {
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

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			spawnError = error;
		});

		child.on("close", (code) => {
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
