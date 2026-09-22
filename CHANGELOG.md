# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.0.3] - 2026-09-22

### Changed

- Require Pi 0.87.0 or newer and validate against Pi 0.87.0.
- Respect Pi's message omissions and replacements when selecting recent messages to retain.

### Fixed

- Preserve mid-conversation prompt and tool updates during retained-history replay on Pi 0.87.

## [0.0.2] - 2026-09-20

### Fixed

- Load under an installed Pi package by importing the Anthropic Messages adapter through the `@earendil-works/pi-ai/compat` entry that Pi resolves for extensions, instead of an unresolvable `api/` subpath.

## [0.0.1] - 2026-09-20

### Added

- Native on-demand Anthropic compaction for manual and automatic Pi compaction on Pi 0.86.0 or newer.
- Persistent signed-summary replay, full session-history retention, and compaction usage accounting.
- Searchable `/anthropic-settings` menu with session changes, explicit saves, and discard controls.
- Trusted project configuration, cancellation, and concurrent session/configuration change protection.
- Configurable native tail retention with verified request boundaries, exact thinking replay, and resume/fork support.
- Strict thinking-prefix enforcement for retained history and a live Fable 5.1 low-effort test with rejection controls.
- Live packaged-CLI test that exercises native compaction, replay, and resume through the shipped Pi executable.

[Unreleased]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.3...HEAD
[0.0.3]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/2h2d-co/pi-anthropic-compat/releases/tag/v0.0.1
