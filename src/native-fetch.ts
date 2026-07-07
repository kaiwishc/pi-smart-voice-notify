/**
 * Native HTTP fetch using Node.js http.request — works around undici compatibility
 * issues with certain HTTP servers (e.g. Microsoft-HTTPAPI/2.0 behind HttpListener).
 */
import { request as httpRequest, type IncomingMessage } from "node:http";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB safety limit

export type WebhookLogger = (message: string, details?: Record<string, unknown>) => void;

export interface NativeFetchOptions {
	timeoutMs?: number;
	logger?: WebhookLogger;
}

function debugTrace(traceId: string, msg: string, logger?: WebhookLogger): void {
	if (logger) {
		logger(`x-native-fetch-trace.${traceId}`, { message: msg });
	}
}

function collectBody(
	res: IncomingMessage,
	maxSize: number,
	traceId: string,
	logger?: WebhookLogger,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalSize = 0;

		res.on("data", (chunk: Buffer) => {
			totalSize += chunk.length;
			if (totalSize > maxSize) {
				res.destroy();
				debugTrace(traceId, "response body exceeds limit", logger);
				reject(new Error("Response body too large"));
				return;
			}
			chunks.push(chunk);
		});

		res.on("end", () => {
			debugTrace(traceId, `body collected: ${totalSize} bytes`, logger);
			resolve(Buffer.concat(chunks).toString("utf8"));
		});

		res.on("error", (err: Error) => {
			debugTrace(traceId, `body read error: ${err.message}`, logger);
			reject(err);
		});
	});
}

function resolveHeaders(res: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(res.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else {
			headers.set(key, value);
		}
	}
	return headers;
}

function createBlob(data: string): Blob {
	try {
		return new Blob([data]);
	} catch {
		// Node.js < 18 fallback — minimal Blob-like object
		const buf = Buffer.from(data, "utf8");
		return {
			size: buf.length,
			type: "",
			arrayBuffer: () => Promise.resolve(buf.buffer as ArrayBuffer),
			text: () => Promise.resolve(data),
			bytes: () => Promise.resolve(new Uint8Array(buf)),
			slice: () => {
				throw new Error("Not implemented");
			},
			stream: () => {
				throw new Error("Not implemented");
			},
		} as unknown as Blob;
	}
}

/**
 * Bare-bones HTTP/1.1 fetch using Node.js http.request.
 * Only handles HTTP (not HTTPS), which covers LAN webhook URLs.
 */
export async function nativeFetch(
	urlStr: string,
	init: RequestInit & { dispatcher?: unknown },
	options: NativeFetchOptions = {},
): Promise<Response> {
	const parsed = new URL(urlStr);
	if (parsed.protocol !== "http:") {
		throw new Error("nativeFetch only supports HTTP");
	}

	const method = (init.method ?? "GET").toUpperCase();
	const timeoutMs = options.timeoutMs ?? 8_000;
	const logger = options.logger;
	const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const abortSignal = init.signal ?? undefined;

	// Build headers
	const headers: Record<string, string> = {};
	if (init.headers) {
		if (init.headers instanceof Headers) {
			init.headers.forEach((value, key) => {
				headers[key] = value;
			});
		} else if (Array.isArray(init.headers)) {
			for (const [key, value] of init.headers) {
				headers[key] = value;
			}
		} else {
			Object.assign(headers, init.headers as Record<string, string>);
		}
	}
	if (!headers["host"]) headers["host"] = parsed.host;
	if (!headers["connection"]) headers["connection"] = "close";

	// Build body
	let bodyStr = "";
	if (init.body) {
		bodyStr = typeof init.body === "string"
			? init.body
			: init.body instanceof Uint8Array
				? Buffer.from(init.body).toString("utf8")
				: String(init.body);
	}
	if (bodyStr.length > 0 && !headers["content-length"]) {
		headers["content-length"] = String(Buffer.byteLength(bodyStr, "utf8"));
	}

	debugTrace(traceId, `connecting to ${parsed.hostname}:${parsed.port || 80}`, logger);

	return new Promise<Response>((resolve, reject) => {
		let settled = false;

		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};

		const cleanup = (): void => {
			if (abortSignal) {
				abortSignal.removeEventListener("abort", onAbort);
			}
		};

		const onAbort = (): void => {
			debugTrace(traceId, "aborted by signal", logger);
			req.destroy();
			settle(() => reject(new Error("Request aborted")));
		};

		if (abortSignal?.aborted) {
			reject(new Error("Request aborted before connecting"));
			return;
		}

		abortSignal?.addEventListener("abort", onAbort, { once: true });

		const req = httpRequest(
			{
				hostname: parsed.hostname,
				port: Number(parsed.port) || 80,
				path: parsed.pathname + parsed.search,
				method,
				headers,
				timeout: timeoutMs,
			},
			(res: IncomingMessage) => {
				debugTrace(traceId, `response: ${res.statusCode ?? 0}`, logger);
				collectBody(res, MAX_RESPONSE_SIZE, traceId, logger)
					.then((bodyText) => {
						const respHeaders = resolveHeaders(res);
						const status = res.statusCode ?? 0;
						const statusText = res.statusMessage ?? "";

						settle(() => {
							resolve({
								status,
								statusText,
								ok: status >= 200 && status < 300,
								headers: respHeaders,
								text: () => Promise.resolve(bodyText),
								json: () => Promise.resolve(JSON.parse(bodyText)),
								arrayBuffer: () =>
									Promise.resolve(
										new TextEncoder().encode(bodyText).buffer as ArrayBuffer,
									),
								blob: () => Promise.resolve(createBlob(bodyText)),
								bodyUsed: false,
								redirected: false,
								type: "basic" as ResponseType,
								url: urlStr,
								clone() {
									return Promise.resolve(this);
								},
							} as unknown as Response);
						});
					})
					.catch((err: unknown) => {
						settle(() => reject(err));
					});
			},
		);

		req.on("error", (err: Error) => {
			debugTrace(traceId, `request error: ${err.message}`, logger);
			settle(() => reject(err));
		});

		req.on("timeout", () => {
			debugTrace(traceId, "request timeout", logger);
			req.destroy();
			settle(() => reject(new Error(`nativeFetch timed out after ${timeoutMs}ms`)));
		});

		if (bodyStr.length > 0) {
			req.write(bodyStr);
		}
		req.end();
	});
}

export default nativeFetch;
