export type LinuxSessionType = "x11" | "wayland" | "tty" | "unknown";

export interface LinuxSessionInfo {
	sessionType: LinuxSessionType;
	isX11: boolean;
	isWayland: boolean;
	display: string | null;
	waylandDisplay: string | null;
}

export interface LinuxCommandResult {
	command: string;
	args: string[];
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	success: boolean;
	timedOut: boolean;
	errorMessage?: string;
}

export interface LinuxUtilsOptions {
	debugLog?: (message: string) => void;
}

export interface PlayAudioOptions {
	loops?: number;
	timeoutMs?: number;
}
