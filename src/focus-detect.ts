import { exec, type ExecOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { getErrorMessage } from "./logging.ts";

export type LinuxSessionType = "x11" | "wayland" | "unknown";

export interface FocusDetectOptions {
	debug?: boolean;
	cacheTtlMs?: number;
	timeoutMs?: number;
	logger?: (message: string, details?: Record<string, unknown>) => void;
}

interface FocusCacheState {
	isFocused: boolean;
	timestamp: number;
	focusedWindow: string | null;
	sessionType: LinuxSessionType;
}

interface SwayTreeNode {
	focused?: boolean;
	name?: string;
	app_id?: string;
	window_properties?: {
		class?: string;
		instance?: string;
		title?: string;
	};
	nodes?: SwayTreeNode[];
	floating_nodes?: SwayTreeNode[];
}

type WaylandDesktop = "sway" | "gnome" | "unknown";

type ExecAsync = (
	command: string,
	options?: ExecOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

const execAsync = promisify(exec) as ExecAsync;

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_CACHE_TTL_MS = 400;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

const TERMINAL_IDENTIFIERS = [
	"wezterm",
	"org.wezfurlong.wezterm",
	"alacritty",
	"kitty",
	"gnome-terminal",
	"gnome-terminal-server",
	"xfce4-terminal",
	"xfce terminal",
	"konsole",
	"tilix",
	"terminator",
	"xterm",
	"urxvt",
	"rxvt",
	"foot",
	"st",
	"mate-terminal",
	"lxterminal",
	"kgx",
	"gnome console",
] as const;

let focusCache: FocusCacheState = {
	isFocused: false,
	timestamp: 0,
	focusedWindow: null,
	sessionType: "unknown",
};

function emitLog(
	level: "debug" | "error",
	message: string,
	options: FocusDetectOptions,
	details: Record<string, unknown> = {},
): void {
	const logger = options.logger;

	if (level === "debug") {
		if (!options.debug) {
			return;
		}
		if (logger) {
			logger(message, details);
			return;
		}
		console.debug("[focus-detect]", message, details);
		return;
	}

	if (logger) {
		logger(message, details);
		return;
	}
	console.warn("[focus-detect]", message, details);
}

export function detectLinuxSessionType(env: NodeJS.ProcessEnv = process.env): LinuxSessionType {
	const explicit = env.XDG_SESSION_TYPE?.toLowerCase().trim();
	if (explicit === "x11" || explicit === "wayland") {
		return explicit;
	}

	if (env.WAYLAND_DISPLAY) {
		return "wayland";
	}

	if (env.DISPLAY) {
		return "x11";
	}

	return "unknown";
}

function detectWaylandDesktop(env: NodeJS.ProcessEnv = process.env): WaylandDesktop {
	const desktop = [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION]
		.filter(Boolean)
		.join(":")
		.toLowerCase();

	if (desktop.includes("sway") || Boolean(env.SWAYSOCK)) {
		return "sway";
	}

	if (desktop.includes("gnome")) {
		return "gnome";
	}

	return "unknown";
}

async function runCommand(
	command: string,
	label: string,
	options: FocusDetectOptions,
	maxBuffer = DEFAULT_MAX_BUFFER,
): Promise<string | null> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	try {
		const { stdout, stderr } = await execAsync(command, {
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer,
		});

		if (stderr.trim()) {
			emitLog("debug", `${label}: stderr`, options, { stderr: stderr.trim() });
		}

		const output = stdout.trim();
		if (!output) {
			emitLog("debug", `${label}: empty output`, options);
			return null;
		}

		return output;
	} catch (error) {
		emitLog("error", `${label}: command failed`, options, {
			command,
			error: getErrorMessage(error),
		});
		return null;
	}
}

function parseQuotedValues(text: string): string[] {
	const matches = text.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g) ?? [];
	return matches
		.map((value) => value.slice(1, -1).trim())
		.filter((value) => value.length > 0);
}

async function getFocusedWindowX11(options: FocusDetectOptions): Promise<string | null> {
	const activeWindow = await runCommand("xdotool getactivewindow", "x11.xdotool.getactivewindow", options);
	if (!activeWindow) {
		return null;
	}

	const windowId = activeWindow.split(/\s+/)[0]?.trim();
	if (!windowId) {
		emitLog("error", "x11.xdotool returned empty window id", options);
		return null;
	}

	const windowProps = await runCommand(
		`xprop -id ${windowId} WM_CLASS WM_NAME _NET_WM_NAME`,
		"x11.xprop.window",
		options,
	);
	if (!windowProps) {
		return null;
	}

	const quotedValues = parseQuotedValues(windowProps);
	if (quotedValues.length > 0) {
		return quotedValues.join(" ");
	}

	return windowProps;
}

function findFocusedSwayNode(node: SwayTreeNode): SwayTreeNode | null {
	if (node.focused) {
		return node;
	}

	const children = [...(node.nodes ?? []), ...(node.floating_nodes ?? [])];
	for (const child of children) {
		const focusedChild = findFocusedSwayNode(child);
		if (focusedChild) {
			return focusedChild;
		}
	}

	return null;
}

async function getFocusedWindowWaylandSway(options: FocusDetectOptions): Promise<string | null> {
	const treeOutput = await runCommand("swaymsg -t get_tree", "wayland.sway.get_tree", options, 8 * 1024 * 1024);
	if (!treeOutput) {
		return null;
	}

	try {
		const tree = JSON.parse(treeOutput) as SwayTreeNode;
		const focused = findFocusedSwayNode(tree);
		if (!focused) {
			emitLog("debug", "wayland.sway focused node not found", options);
			return null;
		}

		return (
			focused.app_id ??
			focused.window_properties?.class ??
			focused.window_properties?.instance ??
			focused.window_properties?.title ??
			focused.name ??
			null
		);
	} catch (error) {
		emitLog("error", "wayland.sway failed to parse sway tree", options, {
			error: getErrorMessage(error),
		});
		return null;
	}
}

function parseGnomeEvalResult(output: string): string | null {
	const tupleMatch = output.trim().match(/^\((true|false),\s*(.*)\)$/s);
	if (!tupleMatch) {
		return output.trim() || null;
	}

	if (tupleMatch[1] !== "true") {
		return null;
	}

	let value = tupleMatch[2]?.trim() ?? "";
	if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
		value = value.slice(1, -1);
	}

	const unescaped = value.replace(/\\'/g, "'").replace(/\\"/g, '"').trim();
	return unescaped.length > 0 ? unescaped : null;
}

async function getFocusedWindowWaylandGnome(options: FocusDetectOptions): Promise<string | null> {
	const command =
		"gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval '(() => { const w = global.display.focus_window; if (!w) return \"\"; return [w.get_wm_class_instance && w.get_wm_class_instance(), w.get_wm_class && w.get_wm_class(), w.get_title && w.get_title()].filter(Boolean).join(\" \"); })()'";

	const evalOutput = await runCommand(command, "wayland.gnome.gdbus", options);
	if (!evalOutput) {
		return null;
	}

	return parseGnomeEvalResult(evalOutput);
}

async function getFocusedWindowWayland(options: FocusDetectOptions): Promise<string | null> {
	const desktop = detectWaylandDesktop();
	emitLog("debug", "wayland.desktop.detected", options, { desktop });

	if (desktop === "sway") {
		const swayFocused = await getFocusedWindowWaylandSway(options);
		if (swayFocused) {
			return swayFocused;
		}
	}

	if (desktop === "gnome") {
		const gnomeFocused = await getFocusedWindowWaylandGnome(options);
		if (gnomeFocused) {
			return gnomeFocused;
		}
	}

	const swayFocused = await getFocusedWindowWaylandSway(options);
	if (swayFocused) {
		return swayFocused;
	}

	return getFocusedWindowWaylandGnome(options);
}

function normalize(value: string): string {
	return value.toLowerCase().trim();
}

function isKnownTerminalWindow(value: string | null): boolean {
	if (!value) {
		return false;
	}

	const normalized = normalize(value);
	return TERMINAL_IDENTIFIERS.some((identifier) => normalized.includes(identifier));
}

export function clearFocusDetectCache(): void {
	focusCache = {
		isFocused: false,
		timestamp: 0,
		focusedWindow: null,
		sessionType: "unknown",
	};
}

export function getFocusDetectCacheState(): FocusCacheState {
	return { ...focusCache };
}

export async function isTerminalFocused(options: FocusDetectOptions = {}): Promise<boolean> {
	const now = Date.now();
	const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

	if (now - focusCache.timestamp < cacheTtlMs) {
		emitLog("debug", "cache.hit", options, {
			isFocused: focusCache.isFocused,
			focusedWindow: focusCache.focusedWindow,
			sessionType: focusCache.sessionType,
		});
		return focusCache.isFocused;
	}

	const sessionType = detectLinuxSessionType();
	emitLog("debug", "session.detected", options, { sessionType });

	let focusedWindow: string | null = null;
	if (sessionType === "x11") {
		focusedWindow = await getFocusedWindowX11(options);
	} else if (sessionType === "wayland") {
		focusedWindow = await getFocusedWindowWayland(options);
	} else {
		emitLog("error", "unable to determine linux session type", options, {
			XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE ?? null,
			WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? null,
			DISPLAY: process.env.DISPLAY ?? null,
		});
	}

	const isFocused = isKnownTerminalWindow(focusedWindow);
	focusCache = {
		isFocused,
		timestamp: now,
		focusedWindow,
		sessionType,
	};

	emitLog("debug", "focus.result", options, {
		isFocused,
		focusedWindow,
		sessionType,
	});

	return isFocused;
}

export default {
	isTerminalFocused,
	detectLinuxSessionType,
	clearFocusDetectCache,
	getFocusDetectCacheState,
};
