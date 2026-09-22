# pi-anthropic-compat

Native Anthropic compatibility for Pi, starting with signed on-demand compaction.

Requires **Pi 0.87.0 or newer** and Node.js 22.19 or newer.

## Install

```sh
pi install npm:pi-anthropic-compat
```

Native compaction starts **off**. Open `/anthropic-settings` and enable it.
Use your existing Anthropic API key or Claude subscription login in Pi.
The extension does not manage a separate credential store.

## Compaction

With native compaction enabled, `/compact` and Pi's automatic compaction request
a signed summary from Anthropic using `compact-2026-09-04`.

The extension:

- uses Pi's Anthropic serializer and authentication;
- checks the selected model's live compaction capability before summarizing;
- preserves the complete signed block, including opaque fields;
- summarizes the full active conversation or an older range with recent messages retained;
- sends the signed block first on later Anthropic requests;
- preserves original messages in Pi's append-only session tree;
- persists the checkpoint for resume, reload, and branch navigation;
- includes summary generation in Pi's token and cost totals; and
- cancels native compaction on failure without silently switching algorithms.

Run at least one ordinary Anthropic turn before the first native compaction.
This captures the final system instructions and tool definitions after other
extensions have transformed them. The capture persists in the session, so a
resumed session does not need another turn.

Full-history compaction is the default. Set **Native tail tokens** in
`/anthropic-settings` to retain recent messages verbatim, including their signed
thinking. This extension's `keepRecentTokens` setting controls retention.
Pi's separate setting with the same name does not control the native boundary.

### Retaining recent messages

Set `keepRecentTokens` to a positive integer, such as `16000`.
The extension selects an actual earlier Anthropic request as the older range.
It sends only that range for summarization, then replays the signed summary
followed by the unchanged recent messages.

The target uses Pi's approximate message token counts. Opaque thinking is not
accurately measurable with that estimate. Retention rounds up to a safe request
boundary and can exceed the target. A retained range can start with an assistant
response rather than a complete user/assistant exchange.

If no recorded boundary satisfies the target, compaction cancels without a
summary request. Run more Anthropic turns or reduce Native tail tokens.
Existing sessions need an ordinary turn with this extension version to record
a boundary. The extension never silently substitutes full-history compaction.

Retained history requires unchanged model, system instructions, tools, and
earlier messages. Incompatible changes stop replay before transmission.
Cache-marker movement and equivalent JSON formatting are allowed.
Pending tool calls must finish before compaction. Arbitrary messages cannot be
removed from the middle of retained history.

When thinking is enabled, keep-tail mode explicitly requests
`prefix_mismatch_behavior: "error"` instead of silently dropping invalid
thinking. Turning retention off does not discard a previously retained range.
To change system instructions or tools, first compact the whole conversation
with `keepRecentTokens: 0`, then make the change.

Pi records the current prompt and tool declarations on every compaction entry
and leads the compacted context with that snapshot. Models that accept prompt
updates in place, such as Fable 5.1 and Opus 5, keep the original leading
prompt in earlier requests, so a prompt or tool update anywhere in the active
conversation makes the snapshot differ from the request that bound the recent
thinking. Keep-tail compaction then cancels before any summary request. Models
that receive a collapsed prompt can still retain turns made after the update.
Full-history compaction is unaffected.

Pi synthesizes effort-control messages around Fable responses. The extension
removes only a verified duplicate boundary instruction that was already
summarized. It preserves every instruction inside the retained range.

### Pi lifecycle

Pi still owns automatic-compaction timing, cancellation, and retry behavior.
Pi also decides whether a session is large enough to compact before invoking
extensions. Very short sessions can return “Nothing to compact.”
The extension does not change Pi's global compaction settings or intercept
`/tree` branch summarization.

Turning native compaction off prevents new native summaries. Existing signed
summaries still replay until another Pi compaction replaces them.

### Models and endpoints

This version supports the direct Claude API and these documented model IDs:

- `claude-sonnet-5`, `claude-sonnet-4-6`
- `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`
- `claude-fable-5-1`, `claude-fable-5`
- `claude-mythos-5-1`, `claude-mythos-5`, `claude-mythos-preview`

The live Models API must also report support. Haiku 4.5 does not support native
on-demand compaction. Unsupported models, other providers, and proxies retain
Pi's ordinary compaction behavior.

When switching to an unsupported model or provider, Pi's readable summary
remains available as ordinary context. Returning to a supported Anthropic
model restores native replay if that checkpoint is still on the active branch.

Bedrock, Google Cloud, threshold compaction, context editing, and background
compaction are not implemented.

### Failure and cost

The summary input must fit the model's context window. Compact before the
window is exhausted. An already oversized conversation may require selecting
an earlier branch rather than attempting native overflow recovery.

Pending tool calls must have results before compaction. Empty or unsigned
summaries, refusals, timeouts, aborted requests, unsupported responses, and
concurrent session changes leave the original conversation intact. The
extension does not retry billed summary requests automatically.

Compaction is billed separately. Accounting uses `usage.iterations`, not the
top-level usage fields, which can be zero on a successful summary request.
Failed summary requests can still incur charges.

The extension stores final request templates, compact request-boundary hashes,
signed summaries, and retained native messages in Pi's existing session file.
It records a template and a boundary hash on every direct Anthropic turn, even
while native compaction is off, so that enabling it later can retain turns that
already happened. It does not store a complete transcript copy for every request.
It never stores authentication headers or logs raw provider error bodies.
Treat session files as private conversation data.

## Settings

`/anthropic-settings` provides a searchable settings list:

- **Space** changes a value.
- Changes apply to the current session immediately.
- **Ctrl+S** saves without closing.
- **Enter** saves and closes.
- **Escape** discards changes since opening or the last successful save.

Settings are stored in `~/.pi/agent/pi-anthropic-compat.json`.
`PI_CODING_AGENT_DIR` changes that directory.

```json
{
  "enabled": false,
  "keepRecentTokens": 0,
  "maxSummaryTokens": 4096,
  "timeoutSeconds": 120
}
```

| Setting            | Accepted values            |
| ------------------ | -------------------------- |
| `enabled`          | `true` or `false`          |
| `keepRecentTokens` | Integer from 0 to 200000   |
| `maxSummaryTokens` | Integer from 1024 to 32768 |
| `timeoutSeconds`   | Integer from 10 to 600     |

A trusted project's `.pi/pi-anthropic-compat.json` overrides global values.
The menu saves to that file when it already exists. Otherwise it saves globally.
Untrusted project configuration is ignored. Invalid configuration produces an
error instead of silently enabling native compaction.

Saving preserves unknown configuration keys and detects file changes made
since the menu opened. Reopen the menu after a concurrent configuration edit.

The menu requires TUI mode. File configuration also works in print and RPC
modes. `/compact <instructions>` supplies additional summary guidance.

## Development

```sh
mise trust
mise install
mise run install
mise run check
pi -e .
```

Keep extension loading enabled when using Anthropic. In particular, do not
disable an installed system-prompt patcher. Final provider-payload transforms
run before this extension captures system instructions and replays summaries.
Avoid another extension replacing the `anthropic` provider's stream function.

Tests use synthetic responses and real Pi session machinery without network
inference. They cover protocol validation, token accounting, configuration,
the settings menu, automatic/manual compaction, repeated summaries, durable
replay, forks, branch navigation, cancellation, and concurrent session changes.
Retained-history tests cover safe-boundary selection, token targets, thinking,
effort instructions, changed system/tools/content, and cold session resume.

Two live tests make billed Fable 5.1 requests at `low` effort:

```sh
mise exec -- npm run test:live
```

Both use your existing Pi Anthropic login and global context instructions and
require the system-prompt patcher installed under Pi's global npm directory.
The conversations contain synthetic facts.

The SDK test requires actual signed thinking, then verifies native keep-tail
compaction, unchanged replay, usage, and fact recovery. Two negative controls
must return thinking-prefix errors after deliberate system and history changes.
Low effort can omit thinking on simple tasks, so the fixture includes a
multi-step arithmetic problem. A response without thinking fails the test.

The CLI test packs the extension, loads the archive through the shipped Pi
executable in RPC mode with an isolated agent directory, and runs a turn that
reads the facts with Pi's built-in `read` tool, a native compaction, a
continuation, a restart, and a resumed continuation. Tool declarations and the
tool-call/result pair therefore pass through the summary request and replay.
Fact recall after compaction proves the signed block replayed, because the
extension withholds Pi's summary message once a checkpoint exists. Set
`PI_ANTHROPIC_CLI_PATH` to test another installed Pi 0.87 `cli.js`.
The default test suite and CI skip both tests.

Run the complete release validation with `mise run test:live`. It runs both
tests against the development Pi dependency, then repeats the CLI test against
Mise-installed Pi. It requires an existing Mise Pi installation.
Set `PI_PACKAGE_ARCHIVE` to test a prepared archive instead of packing the
working directory. Both CLI runs use that archive. An invalid supplied archive
fails rather than falling back to a newly packed package.

## Release

The shared release tooling records a package digest in a signed release commit.
The tag workflow verifies that digest, attests the archive, stages it on npm,
and creates the immutable GitHub release for the tag from the same archive and
the version's `CHANGELOG.md` section (`Unreleased` for prereleases).
The npm trusted publisher permits staging only and is restricted to this
repository's `publish.yml` workflow and `npm-publish` environment. Every
release after `0.0.1` stages through that workflow with npm provenance and
requires maintainer approval on npm.

Prepare and push a release:

```sh
mise exec -- npm run release -- X.Y.Z
git push --atomic origin main vX.Y.Z
```

Before signing, the release command runs `mise run test:live` against the exact
archive built from the staged files. Missing live-test prerequisites or a failed
test stop the release before the commit and tag. The post-commit reproducibility
rebuild does not repeat the live tests.

The `.github/npm-package-files` allowlist defines the complete public package.
Do not publish credentials, test fixtures, session data, or development notes.
Stable versions use `latest`. Prereleases use their prerelease identifier.

## References

- [Anthropic native compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Anthropic model capabilities](https://platform.claude.com/docs/en/api/beta/models/list)
- [Anthropic preserved-thinking contract](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#keep-tail-compaction)
