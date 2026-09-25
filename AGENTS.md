# Agent Instructions

- This project is a Pi package with a TypeScript extension entrypoint.
- Pi extensions run with full system permissions; keep side effects explicit and documented.
- Keep `extensions/index.ts` thin. Compatibility behavior belongs in focused modules under `extensions/anthropic-compat/`.
- Native compaction must fail closed. Do not silently substitute a plain-text summary after native failure.
- Preserve exact native blocks and signatures. Never print credentials, signed block contents, or raw provider error bodies.
- Keep final provider-payload transforms effective, including the Anthropic system-prompt patcher.
- Keep-tail compaction must use verified earlier native requests and preserve the retained messages exactly. Never infer native boundaries from displayed turn counts or silently fall back to full-history compaction.
- Keep request-boundary records compact. Persist hashes rather than a complete transcript copy for every request.
- Validate retained thinking with Fable 5.1 and Opus 5.5 at low effort, real signed thinking blocks, explicit error enforcement, and rejection controls. Never increase live-test effort without authorization.
- The release script must run `mise run test:live` against its exact candidate archive before signing. This runs both models' SDK and packaged-CLI tests on the repository Pi, then repeats the Fable CLI test against Mise-installed Pi. Cover both full-history and retained-message compaction for Opus 5.5. A missing prerequisite or failed live test blocks signing and tagging. Keep the post-commit reproducibility rebuild free of duplicate live requests. SDK tests alone do not establish runtime compatibility.
- Bind each packaged-CLI test's `PI_PACKAGE_DIR` to the selected executable's package directory. Run tests through the Mise tasks, which bind in-process `PI_PACKAGE_DIR` to the repository Pi and record the parent's package root in `PI_ANTHROPIC_PARENT_PACKAGE_DIR`. Never bind ordinary Pi launches globally.
- Resolve the effective prompt-patcher rules the way the patcher does (model file over provider file; relative, absolute, and `~/` references), copy them into the isolated agent directory, and point isolated settings at the copy. Adjust matching package paths only in those temporary targets. Preserve replacement text and global configuration.
- Read prompt and tool declarations from transcript system messages, never from `getSystemPrompt()` or tool lists. Serialize retained tails behind the prompt snapshot Pi records on compaction entries.
- Background compaction remains out of scope.
- Keep `/anthropic-settings` aligned with `/codex-settings`: Enter edits drafts,
  Apply to session changes the active session without file writes, Ctrl+S saves
  and applies, and Escape discards only unapplied drafts. Reopening must show
  active session values, not file values. Preserve
  changed-field persistence, inheritance, conflict detection, and the shared
  interaction tests in `test/settings-menu.test.ts`.
- Preserve unrelated concurrent filesystem changes. Ask only when they directly conflict with scoped work.
- Run complete non-writing validation through `mise run check`.
- Run `npm run check` and `npm test` before committing meaningful code changes.
- Run `npm run pack:dry` to inspect the npm package contents before release.
- Keep `.github/npm-package-files` synchronized with every intentional package-content change; local release validation and both CI jobs enforce it exactly.
- Use Conventional Commits and maintain `CHANGELOG.md` in Keep a Changelog style; add entries for `feat:` and `fix:` changes under `Unreleased`.
- Keep changelog entries under `Unreleased` for prereleases and move them into a release section only for stable releases.
- Use `npm run release -- <version>` to build the release package locally, create an SSH-signed `release: v<version>` commit containing its `Npm-Artifact-SHA256` trailer, verify a clean rebuild, and create the matching lightweight tag.
- Push the release commit and tag atomically; do not use `git tag -a`, `git tag -s`, `git tag -m`, or `cog bump --annotated`.
- Push stable or prerelease `v<version>` tags and let CI build and stage the package with trusted publishing and provenance, then create the immutable GitHub release from the verified archive and the version's changelog section. Never create GitHub releases by hand. Stable versions use `latest`; prereleases derive a non-`latest` dist-tag from their first prerelease identifier.
