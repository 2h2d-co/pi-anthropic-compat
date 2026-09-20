# pi-anthropic-compat

Native Anthropic compatibility for Pi, starting with signed on-demand compaction.

Requires **Pi 0.85.1** (`>=0.85.1 <0.86.0`) and Node.js 22.19 or newer.
Pi 0.86 changes the provider transcript API and is not supported by this version.

## Install

Install from the repository:

```sh
pi install git:github.com/2h2d-co/pi-anthropic-compat
```

After an npm release is published:

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
- replaces the full active conversation with the summary;
- sends the signed block first on later Anthropic requests;
- preserves original messages in Pi's append-only session tree;
- persists the checkpoint for resume, reload, and branch navigation;
- includes summary generation in Pi's token and cost totals; and
- cancels native compaction on failure without silently switching algorithms.

Run at least one ordinary Anthropic turn before the first native compaction.
This captures the final system instructions and tool definitions after other
extensions have transformed them. The capture persists in the session, so a
resumed session does not need another turn.

Full-history compaction deliberately **does not keep recent turns verbatim**.
Pi's `keepRecentTokens` setting does not control the native summary boundary.
There are no retained thinking blocks from the summarized range.

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

Bedrock, Google Cloud, threshold compaction, context editing, background
compaction, and verbatim recent-turn retention are not implemented.

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

The extension stores final system/tool templates and signed summaries in Pi's
existing session file. It never stores authentication headers or logs raw
provider error bodies. Treat session files as private conversation data.

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
  "maxSummaryTokens": 4096,
  "timeoutSeconds": 120
}
```

| Setting            | Accepted values            |
| ------------------ | -------------------------- |
| `enabled`          | `true` or `false`          |
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
replay, branch navigation, cancellation, and concurrent session changes.

An optional live test makes billed Sonnet 5 requests:

```sh
mise exec -- npm run test:live
```

It uses your existing Pi Anthropic login and global context instructions.
It requires the system-prompt patcher installed under Pi's global npm directory.
The conversation contains synthetic facts and has no tools.
It verifies native compaction, signed replay, usage, and fact recovery.
The default test suite and CI skip this test.

## Release

No npm release is published by installing or checking this repository.

The shared release tooling records a package digest in a signed release commit.
The tag workflow verifies that digest before staging an npm package.
Before the first release, explicitly configure the GitHub release environment,
branch/tag protections, and npm trusted publishing. Repository creation alone
does not configure those controls.

With release authorization and that setup complete:

```sh
mise exec -- npm run release -- X.Y.Z
git push --atomic origin main vX.Y.Z
```

The `.github/npm-package-files` allowlist defines the complete public package.
Do not publish credentials, test fixtures, session data, or development notes.
Stable versions use `latest`. Prereleases use their prerelease identifier.

## References

- [Anthropic native compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Anthropic model capabilities](https://platform.claude.com/docs/en/api/beta/models/list)
