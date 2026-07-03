/**
 * Shared command/process helpers.
 *
 * Consolidates `buildCommandString` (duplicated in abortable-command.ts and
 * linux.ts) and `runSpawnCommand`-style command wrappers.
 */

/**
 * Build a readable command string from a command and its arguments.
 */
export function buildCommandString(command: string, args: readonly string[]): string {
	return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

/**
 * Attach stdout/stderr collectors and spawn error handler to a child process.
 */
export function attachChildHandlers(child: { stdout: { on: (event: string, handler: (chunk: Buffer | string) => void) => void } | null; stderr: { on: (event: string, handler: (chunk: Buffer | string) => void) => void } | null; on: (event: string, handler: (arg: unknown) => void) => void }, onStdout: (text: string) => void, onStderr: (text: string) => void, onError: (error: Error) => void): void {
	child.stdout?.on("data", (chunk: Buffer | string) => onStdout(chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer | string) => onStderr(chunk.toString()));
	child.on("error", onError);
}
