import { appendFile } from "node:fs/promises";

export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function safeJsonStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, currentValue) => {
		if (currentValue instanceof Error) {
			return {
				name: currentValue.name,
				message: currentValue.message,
				stack: currentValue.stack,
			};
		}
		if (typeof currentValue === "bigint") {
			return currentValue.toString();
		}
		if (typeof currentValue === "object" && currentValue !== null) {
			if (seen.has(currentValue)) {
				return "[Circular]";
			}
			seen.add(currentValue);
		}
		return currentValue;
	});
}

interface LoggerOptions {
	extensionId: string;
	debugLogPath: string;
	isDebugEnabled: () => boolean;
	ensureDebugDirectory: () => void;
}

export interface ExtensionLogger {
	debug: (event: string, details?: Record<string, unknown>) => void;
	error: (error: unknown) => void;
	flush: () => Promise<void>;
}

export function createExtensionLogger(options: LoggerOptions): ExtensionLogger {
	const { extensionId, debugLogPath, isDebugEnabled, ensureDebugDirectory } = options;
	let writeQueue: Promise<void> = Promise.resolve();

	const enqueueAppend = (line: string): void => {
		writeQueue = writeQueue.then(
			() => appendFile(debugLogPath, `${line}\n`, "utf-8"),
			() => appendFile(debugLogPath, `${line}\n`, "utf-8"),
		);
		void writeQueue.catch(() => {
			// Debug logging must never write to stdout/stderr from extension code.
		});
	};

	const debug = (event: string, details: Record<string, unknown> = {}): void => {
		if (!isDebugEnabled()) {
			return;
		}

		try {
			ensureDebugDirectory();
			const line = safeJsonStringify({
				timestamp: new Date().toISOString(),
				extension: extensionId,
				event,
				...details,
			});
			enqueueAppend(line);
		} catch {
			// Debug logging must never write to stdout/stderr from extension code.
		}
	};

	const error = (cause: unknown): void => {
		debug("runtime.error", { error: cause });
	};

	const flush = (): Promise<void> => writeQueue.catch(() => undefined);

	return { debug, error, flush };
}
