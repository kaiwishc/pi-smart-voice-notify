# Changelog

## [0.2.3] - 2026-03-13

### Added
- Integration with `pi-permission-system:permission-request` event channel for permission request notifications
- Automatic cancellation of permission reminders when approval/denial is received from the permission system
- Deduplication to prevent duplicate notifications when permission system events precede tool_call events
- New test coverage for permission system event integration

### Changed
- Refactored to use shared `toRecord` utility from `pi-permission-system`, removing duplicate implementation

## [0.2.2] - 2026-03-12

### Changed
- Refactored to use shared `toRecord` utility, removing duplicate implementation
- Consolidated exports and simplified `index.ts`

## [0.2.0] - 2026-03-07

### Added
- Added multi-engine TTS support with auto selection plus Edge, espeak-ng, ElevenLabs, OpenAI-compatible, and SAPI backends.
- Added forwarded permission request watching, reminder playback control, Linux wake/focus helpers, per-project sound discovery, webhook delivery, and AI-generated notification message support.
- Added targeted tests for abortable commands, reminder playback, and forwarded-permission notification flows.

### Changed
- Expanded configuration normalization and example config to cover nested reminder, webhook, AI-message, focus-detection, and sound-theme settings while keeping legacy keys compatible.
- Improved notification orchestration so reminder scheduling, focused-terminal suppression, and desktop/audio delivery can share richer runtime context.
- Switched the test runner to Node's built-in TypeScript stripping support and raised the documented runtime baseline to Node.js 24.

### Fixed
- Restored the package test workflow so the published repo can run its checked-in TypeScript tests without a missing loader file.
- Updated README documentation to cover the new engines, watchers, webhook/AI integrations, and sound-theme behavior.

## [0.1.2] - 2026-03-04

### Fixed
- Use absolute GitHub raw URL for README image to fix npm display

## [0.1.1] - 2026-03-04

### Changed
- Rewrote README.md with professional documentation standards
- Added comprehensive feature documentation, configuration reference, and usage examples

## 0.1.0

- Standardized repository structure to `index.ts` shim + `src/` implementation.
- Added config template and package metadata/scripts aligned with Pi extension conventions.
- Vendored `zellij-modal` into this repository to remove cross-extension imports.
- Modularized implementation into config store, logging, and audio notification modules while preserving runtime behavior.
