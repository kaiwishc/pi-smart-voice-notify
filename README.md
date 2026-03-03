# 🔔 pi-smart-voice-notify

Windows-optimized smart notification extension for the Pi coding agent.

**pi-smart-voice-notify** monitors Pi session and tool events to alert you via **Windows SAPI TTS**, **sound playback**, and **desktop toast notifications** when the agent requires your attention.

![pi-smart-voice-notify configuration modal](https://raw.githubusercontent.com/MasuRii/pi-smart-voice-notify/main/assets/pi-smart-voice-notify.png)

## Features

- **Multi-channel notifications**
  - **Sound** – Windows audio playback via PowerShell (with beep fallback)
  - **Voice** – Windows SAPI text-to-speech with configurable voice and rate
  - **Desktop toasts** – Cross-platform notifications via `node-notifier` (Windows/macOS/Linux)

- **Intelligent event detection**
  - Task completion (idle)
  - Permission blocks
  - Questions requiring input (when custom `question` tool is loaded)
  - Errors

- **Reminder system**
  - Configurable reminder delays with follow-up scheduling
  - Exponential backoff multiplier for follow-ups
  - Auto-cancel reminders on user activity

- **Wake monitor support**
  - Wakes display from sleep before notifications
  - Cross-platform: Windows (SendKeys), macOS (caffeinate), Linux (xset/GNOME)

- **Interactive settings UI**
  - `/voice-notify` command opens a modal for live configuration
  - Settings persist to disk automatically

- **Debug logging**
  - Optional JSONL debug output for troubleshooting

## Installation

### Local Extension Folder

Place this folder in either location (Pi auto-discovers both):

- **Global:** `~/.pi/agent/extensions/pi-smart-voice-notify`
- **Project:** `.pi/extensions/pi-smart-voice-notify`

### As an npm Package

```bash
pi install npm:pi-smart-voice-notify
```

### From Git

```bash
pi install git:github.com/MasuRii/pi-smart-voice-notify
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/voice-notify` | Opens the settings modal (interactive mode) or prints config summary |
| `/voice-notify status` | Displays current configuration and question tool availability |
| `/voice-notify reload` | Reloads config from disk and resets reminder state |
| `/voice-notify on` | Enables the extension |
| `/voice-notify off` | Disables the extension |
| `/voice-notify test [type]` | Triggers a test notification (bypasses throttling) |

**Test types:** `idle`, `permission`, `question`, `error`

### Example

```text
/voice-notify test idle
/voice-notify test permission
```

## Configuration

Configuration is stored at:

```
~/.pi/agent/extensions/pi-smart-voice-notify/config.json
```

A starter template is provided in `config/config.example.json`. On startup, the extension creates `config.json` with defaults if missing.

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Master on/off switch |
| `windowsOptimized` | boolean | `true` | Show warning on non-Windows platforms |
| `notificationMode` | string | `"sound-first"` | Mode: `sound-first`, `tts-first`, `both`, `sound-only` |
| `enableSound` | boolean | `true` | Enable sound playback (Windows) |
| `enableTts` | boolean | `true` | Enable text-to-speech (Windows) |
| `enableDesktopNotification` | boolean | `true` | Enable desktop toast notifications |
| `desktopNotificationTimeout` | number | `8` | Toast display duration in seconds (1–60) |
| `wakeMonitor` | boolean | `true` | Wake display from sleep before notifying |
| `idleThresholdSeconds` | number | `30` | System idle threshold before waking monitor (5–600) |

### Event Toggles

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enableIdleNotification` | boolean | `true` | Notify when agent finishes a task |
| `enablePermissionNotification` | boolean | `true` | Notify on permission blocks |
| `enableQuestionNotification` | boolean | `true` | Notify when agent asks a question* |
| `enableErrorNotification` | boolean | `true` | Notify on errors |
| `suppressIdleAfterError` | boolean | `true` | Skip idle notification if turn had errors |

*Question notifications only work when a custom `question` tool is loaded.

### Reminder Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `reminderEnabled` | boolean | `true` | Enable reminder notifications |
| `reminderDelaySeconds` | number | `30` | Initial delay before first reminder (5–300) |
| `followUpEnabled` | boolean | `true` | Enable follow-up reminders |
| `maxFollowUps` | number | `3` | Maximum follow-up count (1–10) |
| `followUpBackoffMultiplier` | number | `1.5` | Delay multiplier for each follow-up |

### TTS Settings (Windows)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ttsVoice` | string | `"Microsoft Zira Desktop"` | SAPI voice name |
| `ttsRate` | number | `-1` | Speech rate (-10 to 10) |

### Sound File Paths

| Option | Type | Default |
|--------|------|---------|
| `idleSoundFile` | string | `"assets/Soft-high-tech-notification-sound-effect.mp3"` |
| `permissionSoundFile` | string | `"assets/Machine-alert-beep-sound-effect.mp3"` |
| `questionSoundFile` | string | `"assets/Machine-alert-beep-sound-effect.mp3"` |
| `errorSoundFile` | string | `"assets/Machine-alert-beep-sound-effect.mp3"` |

Paths can be absolute or relative to the extension directory.

### Advanced Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `minNotificationIntervalMs` | number | `1500` | Throttle interval between same-type notifications |
| `debugLog` | boolean | `false` | Enable debug logging to file |

## Notification Modes

| Mode | Behavior |
|------|----------|
| `sound-first` | Play sound first; fall back to TTS on failure |
| `tts-first` | Speak TTS first; fall back to sound on failure |
| `both` | Play sound and speak TTS simultaneously |
| `sound-only` | Play sound only, no TTS or reminders |

## Troubleshooting

### Settings modal doesn't appear

The modal requires **interactive UI mode** (`ctx.hasUI`). In non-interactive contexts, `/voice-notify` prints a config summary instead.

### Desktop notifications not showing

1. Ensure `enableDesktopNotification` is `true`
2. Check that `node-notifier` is installed
3. Enable `debugLog` and check `debug/pi-smart-voice-notify.log` for `desktop.notify.failed` events

### No sound or voice on Windows

1. Sound and TTS are Windows-only (`process.platform === "win32"`)
2. The extension uses PowerShell for audio playback and SAPI—ensure PowerShell is available
3. Enable `debugLog` and search for `powershell.exec` entries

### Question notifications never trigger

Question notifications require a custom `question` tool to be loaded. Run `/voice-notify status` to verify `questionToolAvailable=true`.

### Wake monitor not working

- **Windows:** Uses SendKeys (F15) via PowerShell
- **macOS:** Uses `caffeinate -u -t 1`
- **Linux:** Uses `xset dpms force on` or GNOME D-Bus

Ensure system idle time exceeds `idleThresholdSeconds` for wake to trigger.

## Technical Details

### Architecture

```
index.ts                    → Extension entrypoint (re-exports src/index.ts)
src/
├── index.ts                → Main extension logic, event handlers, command registration
├── config-store.ts         → Config paths, normalization, load/save utilities
├── types.ts                → TypeScript interfaces and types
├── notify-audio.ts         → Windows sound + SAPI TTS + monitor wake service
├── desktop-notify.ts       → Desktop toast notifications via node-notifier
├── logging.ts              → Debug logger with JSONL output
└── zellij-modal.ts         → Settings modal UI components
```

### Event Hooks

| Event | Behavior |
|-------|----------|
| `session_start` | Load config, reset state, update status bar |
| `session_switch` | Reset state, refresh question tool availability |
| `session_shutdown` | Cancel reminders, clear status |
| `input` | Track user activity, cancel pending reminders |
| `agent_start` | Reset error tracking |
| `tool_call` | Detect permission blocks |
| `tool_result` | Classify results (question/permission/error) |
| `agent_end` | Trigger idle notification (if enabled) |

### Debug Logging

When `debugLog: true`, JSONL events are written to:

```
~/.pi/agent/extensions/pi-smart-voice-notify/debug/pi-smart-voice-notify.log
```

Events include: config changes, notifications triggered, audio dispatch, reminders, and errors.

## Development

```bash
npm install
npm run build      # TypeScript compilation
npm run lint       # Run linter
npm run test       # Run tests
npm run check      # lint + test
```

**Requirements:** Node.js ≥ 20

## License

MIT
