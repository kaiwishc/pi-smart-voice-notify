import { runAbortableCommand } from "./abortable-command.ts";
import {
	clampInt,
	DEFAULT_CONFIG,
	isWindows,
	resolveSoundFile,
	SOUND_LOOPS,
} from "./config-store.ts";
import type { NotificationType, VoiceNotifyConfig } from "./types.ts";

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface ExecRunner {
	exec: (executable: string, args: string[], options?: { timeout?: number }) => Promise<ExecResult>;
}

interface AudioServiceOptions {
	execRunner: ExecRunner;
	getConfig: () => VoiceNotifyConfig;
	debug: (event: string, details?: Record<string, unknown>) => void;
}

export class AudioNotificationService {
	private readonly execRunner: ExecRunner;
	private readonly getConfig: () => VoiceNotifyConfig;
	private readonly debug: (event: string, details?: Record<string, unknown>) => void;
	private voicesCache: { values: string[]; timestamp: number } = { values: [], timestamp: 0 };

	public constructor(options: AudioServiceOptions) {
		this.execRunner = options.execRunner;
		this.getConfig = options.getConfig;
		this.debug = options.debug;
	}

	public async wakeMonitor(): Promise<void> {
		const config = this.getConfig();
		if (!config.wakeMonitor) {
			this.debug("wake.monitor.skipped", { reason: "disabled" });
			return;
		}

		const threshold = clampInt(config.idleThresholdSeconds, DEFAULT_CONFIG.idleThresholdSeconds, 5, 600);

		try {
			const idleSeconds = await this.getSystemIdleSeconds();
			if (idleSeconds < threshold) {
				this.debug("wake.monitor.skipped", {
					reason: "below_threshold",
					idleSeconds,
					threshold,
				});
				return;
			}

			this.debug("wake.monitor.attempt", {
				platform: process.platform,
				idleSeconds,
				threshold,
			});

			if (isWindows()) {
				const script = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{F15}')";
				const result = await this.runPowerShell(script, 6_000, "wake-monitor-windows");
				if (!result.ok) {
					throw new Error(result.stderr || result.stdout || "Failed to wake monitor on Windows");
				}
				this.debug("wake.monitor.success", { platform: process.platform });
				return;
			}

			if (process.platform === "darwin") {
				const result = await this.runProcess("caffeinate", ["-u", "-t", "1"], 6_000, "wake-monitor-macos");
				if (!result.ok) {
					throw new Error(result.stderr || result.stdout || "Failed to wake monitor on macOS");
				}
				this.debug("wake.monitor.success", { platform: process.platform });
				return;
			}

			if (process.platform === "linux") {
				const script =
					"xset dpms force on || gdbus call --session --dest org.gnome.SettingsDaemon.Power --object-path /org/gnome/SettingsDaemon/Power --method org.gnome.SettingsDaemon.Power.Screen.StepUp";
				const result = await this.runShell(script, 6_000, "wake-monitor-linux");
				if (!result.ok) {
					throw new Error(result.stderr || result.stdout || "Failed to wake monitor on Linux");
				}
				this.debug("wake.monitor.success", { platform: process.platform });
				return;
			}

			this.debug("wake.monitor.skipped", {
				reason: "unsupported_platform",
				platform: process.platform,
			});
		} catch (error) {
			this.debug("wake.monitor.error", { error });
		}
	}

	public async playWindowsSound(type: NotificationType): Promise<void> {
		const config = this.getConfig();
		if (!isWindows() || !config.enableSound) {
			return;
		}

		const soundFile = resolveSoundFile(config, type);
		const loops = SOUND_LOOPS[type];
		const soundFileBase64 = soundFile ? Buffer.from(soundFile, "utf8").toString("base64") : "";

		const script = `
$ErrorActionPreference = 'Stop'
$loops = ${loops}
$path = ''
if ('${soundFileBase64}') {
  $path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${soundFileBase64}'))
}

try {
  if ($path -and (Test-Path -LiteralPath $path)) {
    Add-Type -AssemblyName PresentationCore
    $player = New-Object System.Windows.Media.MediaPlayer
    try {
      $player.Volume = 1.0
      for ($i = 0; $i -lt $loops; $i++) {
        $player.Open([Uri]::new($path))

        $openDeadline = (Get-Date).AddSeconds(3)
        while (-not $player.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $openDeadline) {
          Start-Sleep -Milliseconds 50
        }

        $durationMs = if ($player.NaturalDuration.HasTimeSpan) {
          [Math]::Max(200, [Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds))
        } else {
          2500
        }

        $player.Position = [TimeSpan]::Zero
        $player.Play()
        Start-Sleep -Milliseconds $durationMs
        $player.Stop()
        Start-Sleep -Milliseconds 120
      }
    } finally {
      $player.Close()
    }
    exit 0
  }

  for ($i = 0; $i -lt $loops; $i++) {
    try {
      [Console]::Beep(1047, 180)
      Start-Sleep -Milliseconds 80
      [Console]::Beep(1319, 220)
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

		const result = await this.runPowerShell(script, 30_000, "play-windows-sound");
		if (!result.ok) {
			throw new Error(result.stderr || result.stdout || "Failed to play Windows sound");
		}
	}

	public async speakWithSapi(text: string, signal?: AbortSignal): Promise<void> {
		const config = this.getConfig();
		if (!isWindows() || !config.enableTts) {
			return;
		}
		if (signal?.aborted) {
			return;
		}

		const textBase64 = Buffer.from(text, "utf8").toString("base64");
		const voiceBase64 = Buffer.from(config.ttsVoice, "utf8").toString("base64");
		const rate = clampInt(config.ttsRate, DEFAULT_CONFIG.ttsRate, -10, 10);

		const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${textBase64}'))
  $voice = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${voiceBase64}'))
  $synth.Rate = ${rate}
  if ($voice) {
    try { $synth.SelectVoice($voice) } catch { }
  }
  $synth.Speak($text)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($synth) { $synth.Dispose() }
}
`;

		const result = await this.runPowerShell(script, 30_000, "speak-sapi", signal);
		if (signal?.aborted) {
			return;
		}
		if (!result.ok) {
			throw new Error(result.stderr || result.stdout || "Failed to speak with SAPI");
		}
	}

	public async getInstalledVoices(force = false): Promise<string[]> {
		const config = this.getConfig();
		if (!isWindows()) {
			return [config.ttsVoice];
		}

		const cacheAge = Date.now() - this.voicesCache.timestamp;
		if (!force && this.voicesCache.values.length > 0 && cacheAge < 5 * 60_000) {
			return this.voicesCache.values;
		}

		const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
} finally {
  if ($synth) { $synth.Dispose() }
}
`;

		const result = await this.runPowerShell(script, 20_000, "list-sapi-voices");
		if (!result.ok) {
			throw new Error(result.stderr || result.stdout || "Failed to list SAPI voices");
		}

		const values = result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const unique = Array.from(new Set(values));
		if (unique.length === 0) {
			unique.push(config.ttsVoice);
		}

		if (!unique.includes(config.ttsVoice)) {
			unique.push(config.ttsVoice);
		}

		this.voicesCache = { values: unique, timestamp: Date.now() };
		return unique;
	}

	private encodePowerShell(script: string): string {
		return Buffer.from(script, "utf16le").toString("base64");
	}

	private async runPowerShell(
		script: string,
		timeout = 20_000,
		action = "unknown",
		signal?: AbortSignal,
	): Promise<{ ok: boolean; stdout: string; stderr: string }> {
		const startedAt = Date.now();
		const encoded = this.encodePowerShell(script);
		const result = signal
			? await runAbortableCommand(
					"powershell.exe",
					["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
					{ timeoutMs: timeout, signal },
				)
			: await this.execRunner.exec(
					"powershell.exe",
					["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
					{ timeout },
				);
		const payload = {
			ok: result.code === 0,
			stdout: result.stdout,
			stderr: result.stderr,
		};
		this.debug("powershell.exec", {
			action,
			ok: payload.ok,
			exitCode: result.code,
			durationMs: Date.now() - startedAt,
			stdoutPreview: payload.stdout.slice(0, 300),
			stderrPreview: payload.stderr.slice(0, 300),
		});
		return payload;
	}

	private async runProcess(
		executable: string,
		args: string[],
		timeout = 20_000,
		action = "process",
		signal?: AbortSignal,
	): Promise<{ ok: boolean; stdout: string; stderr: string }> {
		const startedAt = Date.now();
		const result = signal
			? await runAbortableCommand(executable, args, { timeoutMs: timeout, signal })
			: await this.execRunner.exec(executable, args, { timeout });
		const payload = {
			ok: result.code === 0,
			stdout: result.stdout,
			stderr: result.stderr,
		};
		this.debug("process.exec", {
			action,
			executable,
			ok: payload.ok,
			exitCode: result.code,
			durationMs: Date.now() - startedAt,
			stdoutPreview: payload.stdout.slice(0, 300),
			stderrPreview: payload.stderr.slice(0, 300),
		});
		return payload;
	}

	private async runShell(
		script: string,
		timeout = 20_000,
		action = "shell",
	): Promise<{ ok: boolean; stdout: string; stderr: string }> {
		return this.runProcess("sh", ["-lc", script], timeout, action);
	}

	private parseIdleSeconds(stdout: string): number | null {
		const candidate = stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		if (!candidate) {
			return null;
		}
		const value = Number.parseFloat(candidate);
		if (Number.isNaN(value) || !Number.isFinite(value) || value < 0) {
			return null;
		}
		return value;
	}

	private async getSystemIdleSeconds(): Promise<number> {
		const config = this.getConfig();
		const fallbackSeconds = clampInt(config.idleThresholdSeconds, DEFAULT_CONFIG.idleThresholdSeconds, 5, 600);

		if (isWindows()) {
			const script = `
$ErrorActionPreference = 'Stop'
$signature = @'
using System;
using System.Runtime.InteropServices;
public struct LASTINPUTINFO {
  public uint cbSize;
  public uint dwTime;
}
public static class IdleTimeProbe {
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

  [DllImport("kernel32.dll")]
  public static extern ulong GetTickCount64();
}
'@
Add-Type -TypeDefinition $signature -Language CSharp

$info = New-Object LASTINPUTINFO
$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]LASTINPUTINFO)
if (-not [IdleTimeProbe]::GetLastInputInfo([ref]$info)) {
  throw 'GetLastInputInfo failed.'
}
$idleMs = [IdleTimeProbe]::GetTickCount64() - [uint64]$info.dwTime
[Math]::Floor($idleMs / 1000)
`;
			const result = await this.runPowerShell(script, 8_000, "idle-seconds-windows");
			const parsed = result.ok ? this.parseIdleSeconds(result.stdout) : null;
			if (parsed !== null) {
				return parsed;
			}
			this.debug("wake.monitor.idle_fallback", {
				platform: process.platform,
				reason: result.ok ? "unparseable" : "exec_failed",
				fallbackSeconds,
			});
			return fallbackSeconds;
		}

		if (process.platform === "darwin") {
			const result = await this.runShell(
				"ioreg -c IOHIDSystem | awk '/HIDIdleTime/ { printf(\"%d\\n\", $NF/1000000000); exit }'",
				8_000,
				"idle-seconds-macos",
			);
			const parsed = result.ok ? this.parseIdleSeconds(result.stdout) : null;
			if (parsed !== null) {
				return parsed;
			}
			this.debug("wake.monitor.idle_fallback", {
				platform: process.platform,
				reason: result.ok ? "unparseable" : "exec_failed",
				fallbackSeconds,
			});
			return fallbackSeconds;
		}

		if (process.platform === "linux") {
			const script = "if command -v xprintidle >/dev/null 2>&1; then xprintidle | awk '{ printf(\"%d\\n\", $1/1000) }'; else echo ''; fi";
			const result = await this.runShell(script, 8_000, "idle-seconds-linux");
			const parsed = result.ok ? this.parseIdleSeconds(result.stdout) : null;
			if (parsed !== null) {
				return parsed;
			}
			this.debug("wake.monitor.idle_fallback", {
				platform: process.platform,
				reason: result.ok ? "unparseable" : "exec_failed",
				fallbackSeconds,
			});
			return fallbackSeconds;
		}

		return fallbackSeconds;
	}
}
