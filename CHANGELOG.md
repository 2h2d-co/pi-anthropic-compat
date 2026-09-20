# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Native on-demand Anthropic compaction for manual and automatic Pi compaction.
- Persistent signed-summary replay, full session-history retention, and compaction usage accounting.
- Searchable `/anthropic-settings` menu with session changes, explicit saves, and discard controls.
- Trusted project configuration, cancellation, and concurrent session/configuration change protection.
- Configurable native tail retention with verified request boundaries, exact thinking replay, and resume/fork support.
- Strict thinking-prefix enforcement for retained history and a live Fable 5.1 low-effort test with rejection controls.

### Fixed

- Make request-boundary fingerprints independent of the machine's locale.
- Preserve explicit effort and adaptive-thinking controls in native summary requests without retaining incompatible structured-output settings.
