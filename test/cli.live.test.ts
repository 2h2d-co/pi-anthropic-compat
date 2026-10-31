import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json" with { type: "json" };
type RpcClientModule =
  typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js");
import { object } from "../extensions/anthropic-compat/json.ts";
import { CHECKPOINT_TYPE } from "../extensions/anthropic-compat/protocol.ts";
import { REQUEST_TYPE } from "../extensions/anthropic-compat/tail.ts";
import { PROMPT_FIRST_TYPE } from "../extensions/anthropic-compat/prompt-order.ts";
import { describeFailure, errorLog } from "./support/error-log.ts";
import { archiveEntries, packageArchive } from "./support/package-archive.ts";
import { isolatePromptPatcher } from "./support/prompt-patcher.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isRpcClientModule(value: unknown): value is RpcClientModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "RpcClient" in value &&
    typeof value.RpcClient === "function"
  );
}

async function loadRpcClient(piRoot: string): Promise<RpcClientModule> {
  const loaded: unknown = await import(
    pathToFileURL(join(piRoot, "dist/modes/rpc/rpc-client.js")).href
  );
  assert.ok(isRpcClientModule(loaded), `Pi at ${piRoot} does not export RpcClient.`);
  return loaded;
}

const FACTS =
  "project Lantern, language TypeScript, port 4317, storage SQLite, " +
  "constraint no network access, next task implement /health";
const READ_FACTS =
  "Use the read tool to read facts.txt in the working directory. It lists six synthetic project " +
  "facts. Remember them, then reply with the single word OK.";

/**
 * Uses the supplied archive or packs the extension, then loads it through the Pi CLI for one turn,
 * a native compaction, a continuation, a CLI restart, and a resumed continuation against
 * the real Anthropic API. The compaction summary message is withheld from the model once a
 * signed checkpoint exists, so fact recall after compaction proves the signed block replayed.
 * Fable 5.1 runs only in the SDK test. Pi AI builds its requests like these models'.
 */
const scenarios = [
  { modelId: "claude-opus-5-5", keepRecentTokens: 0, strictLimit: false },
  { modelId: "claude-opus-5-5", keepRecentTokens: 1, strictLimit: false },
  { modelId: "claude-sonnet-5-5", keepRecentTokens: 0, strictLimit: false },
  { modelId: "claude-sonnet-5-5", keepRecentTokens: 1, strictLimit: false },
  { modelId: "claude-haiku-5-5", keepRecentTokens: 0, strictLimit: false },
  { modelId: "claude-haiku-5-5", keepRecentTokens: 1, strictLimit: false },
  // Pi's strict built-in tools plus these exceed Anthropic's limit of 20 strict tools, so Pi
  // retries every turn with preferred strict tools non-strict, and compaction must follow. Such
  // sessions compact the full history even when retention is configured.
  { modelId: "claude-sonnet-5-5", keepRecentTokens: 0, strictLimit: true },
  { modelId: "claude-sonnet-5-5", keepRecentTokens: 1, strictLimit: true },
  // A shell command before the first prompt comes first in Pi's transcript. The extension moves
  // the prompt ahead of it, so keep-tail compaction finds the turns' prompt and tools unchanged.
  { modelId: "claude-sonnet-5-5", keepRecentTokens: 1, strictLimit: false, shellFirst: true },
];
const STRICT_FIXTURE_TOOLS = 21;
const STRICT_FIXTURE = `export default function (pi) {
  for (let index = 0; index < ${STRICT_FIXTURE_TOOLS}; index++) {
    pi.registerTool({
      name: \`strict_fixture_\${index}\`,
      label: \`Strict fixture \${index}\`,
      description: "Synthetic test tool. Never call it.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
  }
}
`;
for (const { modelId, keepRecentTokens, strictLimit, shellFirst = false } of scenarios) {
  const variant = `keepRecentTokens=${keepRecentTokens}${strictLimit ? ", strict tool limit" : ""}${shellFirst ? ", shell command first" : ""}`;
  test(
    `live packaged Pi CLI ${modelId} compaction, replay, and resume (${variant})`,
    { skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1", timeout: 300_000 },
    async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), "anthropic-packaged-cli-"));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const archive = await packageArchive(root, temporary, process.env["PI_PACKAGE_ARCHIVE"]);
      const expected = (await readFile(join(root, ".github/npm-package-files"), "utf8"))
        .trim()
        .split("\n")
        .map((file) => `package/${file}`)
        .sort();
      const files = archiveEntries(archive);
      assert.deepEqual(files, expected);
      execFileSync("tar", ["-xzf", archive, "-C", temporary]);
      const packageRoot = join(temporary, "package");
      // Installed packages have no node_modules: every pi-* import must resolve through Pi's aliases.
      assert.equal(existsSync(join(packageRoot, "node_modules")), false);

      const cli = await realpath(
        process.env["PI_ANTHROPIC_CLI_PATH"] ??
          join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      );
      const piRoot = resolve(dirname(cli), "../..");
      const piManifest = object(JSON.parse(await readFile(join(piRoot, "package.json"), "utf8")));
      const piVersion = manifest.devDependencies["@earendil-works/pi-coding-agent"];
      assert.equal(
        piManifest["version"],
        piVersion,
        "Live validation requires the Pi version pinned as the development dependency.",
      );
      // Drive each executable with its own RPC client rather than mixing installations.
      const { RpcClient } = await loadRpcClient(piRoot);

      // Isolated agent state with the real Claude login and the pinned prompt patcher.
      const realAgentDir = getAgentDir();
      const patcher = join(root, "node_modules/pi-system-prompt-patcher");
      assert.ok(existsSync(patcher), "Run npm ci to install the system-prompt patcher.");
      const agent = join(temporary, "agent");
      await mkdir(agent);
      await symlink(join(realAgentDir, "auth.json"), join(agent, "auth.json"));
      // The patcher's replacement targets can reference prompt text from APPEND_SYSTEM.md.
      if (existsSync(join(realAgentDir, "APPEND_SYSTEM.md"))) {
        await copyFile(join(realAgentDir, "APPEND_SYSTEM.md"), join(agent, "APPEND_SYSTEM.md"));
      }
      // Copy the effective global rules for this provider and model. Path rules use the patcher's
      // placeholders, so they match the selected executable's package directory unchanged.
      await isolatePromptPatcher({
        sourceAgentDir: realAgentDir,
        agentDir: agent,
        provider: "anthropic",
        model: modelId,
      });
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({
          retry: { enabled: false, provider: { maxRetries: 0 } },
          compaction: { enabled: false, keepRecentTokens: 1 },
        }),
      );
      // Configured summary instructions replace the default guidance in every packaged run.
      const summaryInstructions = (
        await readFile(join(root, "test/fixtures/summary-instructions.txt"), "utf8")
      ).trim();
      await writeFile(
        join(agent, "pi-anthropic-compat.json"),
        JSON.stringify({ enabled: true, keepRecentTokens, summaryInstructions }),
      );
      const sessionFile = join(temporary, "session.jsonl");
      const strictFixture = join(temporary, "strict-fixture.js");
      if (strictLimit) await writeFile(strictFixture, STRICT_FIXTURE);
      const clientOptions = {
        cliPath: cli,
        cwd: temporary,
        provider: "anthropic",
        model: modelId,
        env: {
          PI_CODING_AGENT_DIR: agent,
          PI_TELEMETRY: "0",
        },
        args: [
          "--thinking",
          "low",
          "--session",
          sessionFile,
          "-e",
          packageRoot,
          "-e",
          patcher,
          ...(strictLimit ? ["-e", strictFixture] : []),
        ],
      };
      // Check the same package-directory selection used for the actual RPC session.
      const versionEnv: NodeJS.ProcessEnv = { ...process.env, ...clientOptions.env };
      assert.equal(
        execFileSync(process.execPath, [cli, "--version"], {
          env: versionEnv,
          encoding: "utf8",
        }).trim(),
        piVersion,
      );
      const errors = errorLog(t);
      let client = new RpcClient(clientOptions);
      t.after(async () => client.stop());
      client.onEvent(errors.rpcEvent);
      await client.start();
      const state = await client.getState();
      assert.equal(state.model?.id, modelId);
      assert.notEqual(
        state.model?.name,
        modelId,
        "The selected Pi catalog must contain the model rather than synthesizing an unknown ID.",
      );
      assert.ok(
        (await client.getCommands()).some((command) => command.name === "anthropic-settings"),
      );

      async function turn(prompt: string, pattern: RegExp): Promise<void> {
        const events = await client.promptAndWait(prompt, undefined, 120_000);
        assert.deepEqual(
          events.filter((event: { type: string }) => event.type === "extension_error"),
          [],
        );
        const assistant = (await client.getMessages())
          .filter((message) => message.role === "assistant")
          .at(-1);
        assert.ok(assistant);
        assert.equal(assistant.model, modelId, "Pi must preserve the selected model.");
        assert.equal(assistant.responseModel, undefined, "Anthropic must not substitute a model.");
        assert.equal(assistant.stopReason, "stop", describeFailure(assistant));
        const text = assistant.content.flatMap((item) => (item.type === "text" ? [item.text] : []));
        assert.match(text.join(""), pattern);
        assert.doesNotMatch(client.getStderr(), /Failed to load extension|not a function/);
      }

      await writeFile(join(temporary, "facts.txt"), `${FACTS}\n`);
      if (shellFirst) {
        const shell = await client.bash("printf 'Synthetic shell output: project Lantern\\n'");
        assert.equal(shell.exitCode, 0);
      }
      await turn(READ_FACTS, /OK/i);
      const before = await client.getEntries();
      assert.ok(
        before.entries.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.content.some(
              (block) => block.type === "toolCall" && block.name === "read",
            ),
        ),
        "The model read the facts file with the built-in read tool.",
      );
      if (strictLimit) {
        const fallbacks = before.entries.filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            (entry.message.diagnostics ?? []).some(
              (diagnostic) => diagnostic.type === "anthropic_strict_tools_fallback",
            ),
        );
        assert.ok(fallbacks.length > 0, "Anthropic rejected the strict tool set and Pi retried.");
        // Only the request Anthropic accepted is recorded, once per response.
        assert.equal(
          before.entries.filter(
            (entry) => entry.type === "custom" && entry.customType === REQUEST_TYPE,
          ).length,
          before.entries.filter(
            (entry) => entry.type === "message" && entry.message.role === "assistant",
          ).length,
        );
      }
      const compacted = await client.compact();
      assert.ok(compacted.summary.length > 0);
      const { entries } = await client.getEntries();
      const checkpoint = entries.findLast((entry) => entry.type === "compaction");
      assert.ok(checkpoint?.type === "compaction");
      assert.equal(object(checkpoint.details)["type"], CHECKPOINT_TYPE);
      assert.equal(object(checkpoint.details)["model"], modelId);
      assert.equal(
        Boolean(object(checkpoint.details)["retained"]),
        keepRecentTokens > 0 && !strictLimit,
      );
      assert.ok(checkpoint.systemMessage, "Pi 0.86 records the prompt snapshot on the entry.");
      assert.equal(
        entries.filter((entry) => entry.type === "custom" && entry.customType === PROMPT_FIRST_TYPE)
          .length,
        shellFirst ? 1 : 0,
      );
      await turn("Reply with only the port number from the project facts.", /4317/);
      await client.stop();

      client = new RpcClient(clientOptions);
      client.onEvent(errors.rpcEvent);
      await client.start();
      await turn("Reply with only the storage engine from the project facts.", /SQLite/i);
      const resumed = await client.getEntries();
      const afterCheckpoint = resumed.entries.slice(
        resumed.entries.findIndex((entry) => entry.id === checkpoint.id) + 1,
      );
      assert.ok(
        afterCheckpoint.some(
          (entry) => entry.type === "custom" && entry.customType === REQUEST_TYPE,
        ),
        "Requests after compaction pass through the extension's provider wrapper.",
      );
      await client.stop();
      t.diagnostic(
        `Pi ${piVersion} loaded the packaged extension for ${modelId}: native compaction, signed replay, and resume passed (${variant}).`,
      );
    },
  );
}
