import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RpcClient } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js";
import { object } from "../extensions/anthropic-compat/json.ts";
import { CHECKPOINT_TYPE } from "../extensions/anthropic-compat/protocol.ts";
import { REQUEST_TYPE } from "../extensions/anthropic-compat/tail.ts";
import { archiveEntries, packageArchive } from "./package-archive.ts";
import { isolatePromptPatcher, parentPackageDirectory } from "./prompt-patcher.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
 */
test(
  "live packaged Pi CLI native compaction, replay, and resume",
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
    const manifest = object(JSON.parse(await readFile(join(piRoot, "package.json"), "utf8")));
    const piVersion = manifest["version"];
    assert.ok(typeof piVersion === "string", "Pi manifest version is required.");
    const [major = 0, minor = 0] = piVersion.split(".").map(Number);
    assert.ok(major > 0 || minor >= 87, `Pi ${piVersion} predates the supported range.`);

    // Isolated agent state with the real Claude login and the required prompt patcher.
    const realAgentDir = getAgentDir();
    const patcher = join(realAgentDir, "npm/node_modules/pi-system-prompt-patcher");
    assert.ok(existsSync(patcher), "Install the system-prompt patcher before the live CLI test.");
    const agent = join(temporary, "agent");
    await mkdir(agent);
    await symlink(join(realAgentDir, "auth.json"), join(agent, "auth.json"));
    // The patcher's replacement targets can reference prompt text from APPEND_SYSTEM.md.
    if (existsSync(join(realAgentDir, "APPEND_SYSTEM.md"))) {
      await copyFile(join(realAgentDir, "APPEND_SYSTEM.md"), join(agent, "APPEND_SYSTEM.md"));
    }
    // The effective global rules describe the parent's Pi package directory. Copy them for this
    // provider and model, then point the copied targets at the selected executable's package.
    await isolatePromptPatcher({
      sourceAgentDir: realAgentDir,
      agentDir: agent,
      provider: "anthropic",
      model: "claude-fable-5-1",
      from: (await parentPackageDirectory()) ?? piRoot,
      to: piRoot,
    });
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        retry: { enabled: false, provider: { maxRetries: 0 } },
        compaction: { enabled: false, keepRecentTokens: 1 },
      }),
    );
    await writeFile(
      join(agent, "pi-anthropic-compat.json"),
      JSON.stringify({ enabled: true, keepRecentTokens: 1 }),
    );
    const sessionFile = join(temporary, "session.jsonl");
    const clientOptions = {
      cliPath: cli,
      cwd: temporary,
      provider: "anthropic",
      model: "claude-fable-5-1",
      env: {
        PI_CODING_AGENT_DIR: agent,
        PI_PACKAGE_DIR: piRoot,
        PI_TELEMETRY: "0",
      },
      args: [
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        // Keep the built-in read tool: tool declarations and a tool-call/result pair must
        // survive the summary request, signed replay, and resume.
        "--tools",
        "read",
        "--thinking",
        "low",
        "--session",
        sessionFile,
        "-e",
        packageRoot,
        "-e",
        patcher,
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
    let client = new RpcClient(clientOptions);
    t.after(async () => client.stop());
    await client.start();
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
      assert.equal(assistant.stopReason, "stop", assistant.errorMessage);
      const text = assistant.content.flatMap((item) => (item.type === "text" ? [item.text] : []));
      assert.match(text.join(""), pattern);
      assert.doesNotMatch(client.getStderr(), /Failed to load extension|not a function/);
    }

    await writeFile(join(temporary, "facts.txt"), `${FACTS}\n`);
    await turn(READ_FACTS, /OK/i);
    const before = await client.getEntries();
    assert.ok(
      before.entries.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content.some((block) => block.type === "toolCall" && block.name === "read"),
      ),
      "The model read the facts file with the built-in read tool.",
    );
    const compacted = await client.compact();
    assert.ok(compacted.summary.length > 0);
    const { entries } = await client.getEntries();
    const checkpoint = entries.findLast((entry) => entry.type === "compaction");
    assert.ok(checkpoint?.type === "compaction");
    assert.equal(object(checkpoint.details)["type"], CHECKPOINT_TYPE);
    assert.ok(checkpoint.systemMessage, "Pi 0.86 records the prompt snapshot on the entry.");
    await turn("Reply with only the port number from the project facts.", /4317/);
    await client.stop();

    client = new RpcClient(clientOptions);
    await client.start();
    await turn("Reply with only the storage engine from the project facts.", /SQLite/i);
    const resumed = await client.getEntries();
    const afterCheckpoint = resumed.entries.slice(
      resumed.entries.findIndex((entry) => entry.id === checkpoint.id) + 1,
    );
    assert.ok(
      afterCheckpoint.some((entry) => entry.type === "custom" && entry.customType === REQUEST_TYPE),
      "Requests after compaction pass through the extension's provider wrapper.",
    );
    await client.stop();
    t.diagnostic(
      `Pi ${piVersion} loaded the packaged extension: native compaction, signed replay, and resume passed.`,
    );
  },
);
