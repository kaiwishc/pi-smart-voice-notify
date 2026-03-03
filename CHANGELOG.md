# Changelog

## [0.1.1] - 2026-03-04

### Changed
- Rewrote README.md with professional documentation standards
- Added comprehensive feature documentation, configuration reference, and usage examples

## 0.1.0

- Standardized repository structure to `index.ts` shim + `src/` implementation.
- Added config template and package metadata/scripts aligned with Pi extension conventions.
- Vendored `zellij-modal` into this repository to remove cross-extension imports.
- Modularized implementation into config store, logging, and audio notification modules while preserving runtime behavior.
