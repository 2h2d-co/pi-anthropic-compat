import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createCodemodeExtension,
  defineTool,
  DefaultResourceLoader,
  getAgentDir,
  getPackageDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import extension from "../extensions/index.ts";
import { object, objects, type JsonObject } from "../extensions/anthropic-compat/json.ts";
import { activeCheckpoint } from "../extensions/anthropic-compat/runtime.ts";
import { fingerprint, isEffortMessage, messageHash } from "../extensions/anthropic-compat/tail.ts";
import {
  COMPACTION_CANCELLED_CHANNEL,
  THINKING_BINDING_BETA,
} from "../extensions/anthropic-compat/protocol.ts";
import { PROMPT_FIRST_TYPE } from "../extensions/anthropic-compat/prompt-order.ts";
import { describeFailure, errorLog } from "./support/error-log.ts";
import { isolatePromptPatcher } from "./support/prompt-patcher.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The prompts call it "project Lantern", so models may answer with either name. */
function assertProjectLantern(value: unknown): void {
  assert.ok(
    typeof value === "string" && /^(?:project )?Lantern$/i.test(value),
    `Expected the project Lantern, got ${JSON.stringify(value)}.`,
  );
}

async function liveSession(
  t: TestContext,
  modelId: string,
  options: {
    codemode?: "on" | "only";
    customTools?: ToolDefinition[];
    keepRecentTokens?: number;
    /** Write this `summaryInstructions` value to the configuration file. */
    summaryInstructions?: string;
    /** Collect the payloads published on the compaction-cancelled channel. */
    cancellations?: unknown[];
    /** Load this extension. Without it, Pi's own Anthropic provider serves the session. */
    compat?: boolean;
  } = {},
) {
  const compat = options.compat ?? true;
  const root = await mkdtemp(join(tmpdir(), "anthropic-live-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await mkdir(join(root, ".pi"));
  await writeFile(
    join(root, ".pi", "pi-anthropic-compat.json"),
    JSON.stringify({
      enabled: true,
      keepRecentTokens: options.keepRecentTokens ?? 1,
      summaryInstructions: options.summaryInstructions,
    }),
  );
  // The in-process runtime must use the repository dependency's metadata, not an inherited
  // package directory. `npm run test:live` removes an inherited PI_PACKAGE_DIR.
  const packageDir = getPackageDir();
  assert.equal(
    await realpath(packageDir),
    await realpath(join(repository, "node_modules/@earendil-works/pi-coding-agent")),
    "Run the live tests through `npm run test:live`, which removes an inherited PI_PACKAGE_DIR.",
  );
  const realAgentDir = getAgentDir();
  // The patcher is a pinned development dependency; only its rules come from the user's agent.
  const patcher = join(repository, "node_modules/pi-system-prompt-patcher/extensions/index.ts");
  assert.ok(existsSync(patcher), "Run npm ci to install the system-prompt patcher.");
  // The patcher reads its settings from PI_CODING_AGENT_DIR on every request. Give it an
  // isolated copy of the effective global rules.
  await isolatePromptPatcher({
    sourceAgentDir: realAgentDir,
    agentDir,
    provider: "anthropic",
    model: modelId,
  });
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  });
  const runtime = await ModelRuntime.create({
    authPath: join(realAgentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  const model = runtime.getModel("anthropic", modelId);
  assert.ok(model, `${modelId} must exist in the installed Pi model catalog.`);
  const send = globalThis.fetch;
  let continuation: Request | undefined;
  const requests: JsonObject[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        const body = object(await request.clone().json());
        // Inspect only safe metadata in assertion failures, never native content.
        assert.equal(body["model"], modelId);
        assert.equal(object(body["output_config"])["effort"], "low");
        // Thinking-prefix enforcement applies only when compaction retains recent messages.
        if (compat && (options.keepRecentTokens ?? 1) > 0) {
          assert.equal(
            object(object(body["thinking"])["block_binding"])["prefix_mismatch_behavior"],
            "error",
          );
        }
        requests.push(body);
        if (!body["compaction"]) continuation = request.clone();
      }
      return send(request);
    },
  );
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
    ...(options.codemode ? { codemode: { mode: options.codemode } } : {}),
  });
  settings.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: realAgentDir,
    settingsManager: settings,
    additionalExtensionPaths: [patcher],
    extensionFactories: [
      ...(compat ? [extension] : []),
      (pi) =>
        pi.on("before_provider_request", (event) => ({
          ...object(event.payload),
          max_tokens: 2048,
          output_config: { effort: "low" },
        })),
      ...(options.codemode ? [createCodemodeExtension()] : []),
      (pi) =>
        pi.events.on(COMPACTION_CANCELLED_CHANNEL, (data) => {
          options.cancellations?.push(data);
        }),
    ],
  });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "low",
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    ...(options.customTools ? { customTools: options.customTools } : {}),
  });
  t.after(() => session.dispose());
  const errors = errorLog(t);
  session.subscribe((event) => {
    if (event.type === "message_end") errors.response(event.message);
  });
  await session.bindExtensions({
    // Replace only notify in Pi's no-op UI, so extension notices reach the test log.
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (message, level) => {
        errors.notice(message, level);
      },
    },
    onError: (error) => {
      errors.extensionError(error.event, error.error);
    },
  });
  if (options.codemode) {
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  }
  return { session, manager, model, requests, send, continuation: () => continuation };
}

for (const modelId of [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]) {
  test(
    `live ${modelId} low-effort retained thinking with enforced positive and negative controls`,
    {
      skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
      timeout: 180000,
    },
    async (t) => {
      const {
        session,
        manager,
        model,
        requests,
        send,
        continuation: lastContinuation,
      } = await liveSession(t, modelId);
      await session.prompt(
        "Remember these six synthetic project facts: project Lantern, language TypeScript, port 4317, storage SQLite, constraint no network access, next task implement /health. Then solve this verification problem carefully: find the smallest positive integer n such that n mod 17 = 12, n mod 19 = 8, n mod 23 = 14, and n mod 29 = 7. Check all four congruences before answering. Reply with n and the four checked remainders. Do not use tools.",
      );
      const first = session.messages.at(-1);
      assert.ok(
        first?.role === "assistant" && first.stopReason === "stop",
        "The initial synthetic turn must succeed before compaction.",
      );
      assert.equal(first.model, model.id, "Pi must preserve the selected model.");
      assert.equal(first.responseModel, undefined, "Anthropic must not substitute a model.");
      assert.ok(
        first.content.some((item) => item.type === "thinking" && Boolean(item.thinkingSignature)),
        "Actual signed thinking is required. A successful response without thinking proves nothing.",
      );
      const summary = await session.compact("Preserve all six exact synthetic project facts.");
      const saved = activeCheckpoint(manager.getBranch());
      assert.ok(saved?.retained);
      assert.ok(
        saved.retained.messages.some((message) =>
          objects(message["content"]).some(
            (item) =>
              item["type"] === "thinking" &&
              typeof item["signature"] === "string" &&
              item["signature"].length > 0,
          ),
        ),
        "The retained native tail must contain the original thinking.",
      );
      assert.ok(summary.usage && summary.usage.totalTokens > 0);
      await session.prompt(
        "Return only JSON with project, language, port (number), storage, constraint, nextTask from the earlier project facts.",
      );
      const last = session.messages.at(-1);
      assert.ok(
        last?.role === "assistant" && last.stopReason === "stop",
        "Expected a successful continuation.",
      );
      assert.equal(last.responseModel, undefined, "Anthropic must not substitute a model.");
      const text = last.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      const json = text
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "");
      const result = object(JSON.parse(json));
      assertProjectLantern(result["project"]);
      assert.equal(result["language"], "TypeScript");
      assert.equal(result["port"], 4317);
      assert.equal(result["storage"], "SQLite");
      assert.ok(
        typeof result["constraint"] === "string" && /no network access/i.test(result["constraint"]),
      );
      assert.ok(typeof result["nextTask"] === "string" && result["nextTask"].includes("/health"));
      const replay = requests.at(-1);
      assert.ok(replay);
      const replayMessages = objects(replay["messages"]);
      assert.ok(
        messageHash(replayMessages.slice(1, 1 + saved.retained.messages.length)) ===
          messageHash(saved.retained.messages),
        "Kept messages must replay unchanged.",
      );
      const continuation = lastContinuation();
      assert.ok(continuation);
      const valid = object(await continuation.clone().json());
      for (const invalid of [
        {
          ...valid,
          system: [
            ...objects(valid["system"]),
            { type: "text", text: "Synthetic changed system." },
          ],
        },
        {
          ...valid,
          messages: [
            replayMessages[0],
            { role: "user", content: "Synthetic injected history." },
            ...replayMessages.slice(1),
          ],
        },
      ]) {
        const headers = new Headers(continuation.headers);
        headers.delete("content-length");
        const rejected = await send(continuation.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...invalid, stream: false }),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        assert.equal(rejected.status, 400, "Changed native history must be rejected by Anthropic.");
        const error = object(object(await rejected.json())["error"]);
        assert.equal(error["type"], "invalid_request_error");
        assert.ok(
          typeof error["message"] === "string" &&
            /thinking/i.test(error["message"]) &&
            /prefix|conversation/i.test(error["message"]),
          "The negative control must fail the thinking-prefix check, not an unrelated validation.",
        );
      }
      t.diagnostic(
        `${modelId} low effort passed native keep-tail compaction, signed-thinking replay, six-fact recovery, and two enforced rejection controls. No prompts, credentials, or signatures logged.`,
      );
    },
  );
}

test(
  "live claude-sonnet-5-5 keep-tail compaction declares the turn tools under codemode only mode",
  {
    skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
    timeout: 180000,
  },
  async (t) => {
    const lookup = defineTool({
      name: "lookup_value",
      label: "Lookup",
      description: "Look up a stored value by key.",
      parameters: Type.Object({ key: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "unused" }], details: {} };
      },
    });
    const { session, manager, requests } = await liveSession(t, "claude-sonnet-5-5", {
      codemode: "only",
      customTools: [lookup],
    });
    await session.prompt(
      "Remember these synthetic project facts: project Lantern, port 4317. Reply with only OK. Do not use tools.",
    );
    const first = session.messages.at(-1);
    assert.ok(
      first?.role === "assistant" && first.stopReason === "stop",
      "The initial synthetic turn must succeed before compaction.",
    );
    const turn = requests.at(-1);
    assert.ok(turn && !turn["compaction"]);
    // Codemode `only` mode hides the direct tool from requests; scripts reach it.
    const names = objects(turn["tools"]).map((tool) => tool["name"]);
    assert.ok(names.includes("codemode"));
    assert.equal(names.includes(lookup.name), false);

    await session.compact("Preserve the exact synthetic project facts.");
    const summary = requests.at(-1);
    assert.ok(summary?.["compaction"]);
    assert.deepEqual(summary["tools"], turn["tools"]);
    assert.ok(activeCheckpoint(manager.getBranch())?.retained);

    await session.prompt(
      "Return only JSON with project and port (number) from the earlier project facts. Do not use tools.",
    );
    const last = session.messages.at(-1);
    assert.ok(
      last?.role === "assistant" && last.stopReason === "stop",
      "Expected a successful continuation.",
    );
    const text = last.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    const result = object(JSON.parse(text));
    assertProjectLantern(result["project"]);
    assert.equal(result["port"], 4317);
    assert.deepEqual(requests.at(-1)?.["tools"], turn["tools"]);
  },
);

test(
  "live claude-sonnet-5-5 full-history compaction keeps a tool added mid-conversation callable",
  {
    skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
    timeout: 180000,
  },
  async (t) => {
    const lookup = defineTool({
      name: "lookup_value",
      label: "Lookup",
      description: "Look up a stored value by key.",
      parameters: Type.Object({ key: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "unused" }], details: {} };
      },
    });
    const recalled: string[] = [];
    const recall = defineTool({
      name: "recall_code",
      label: "Recall",
      description: "Return the synthetic verification code for a project.",
      parameters: Type.Object({ project: Type.String() }),
      async execute(_id, params) {
        recalled.push(params.project);
        return { content: [{ type: "text", text: "Verification code: 7341" }], details: {} };
      },
    });
    const summaryInstructions = (
      await readFile(join(repository, "test/fixtures/summary-instructions.txt"), "utf8")
    ).trim();
    const { session, requests } = await liveSession(t, "claude-sonnet-5-5", {
      customTools: [lookup, recall],
      keepRecentTokens: 0,
      summaryInstructions,
    });
    const initialToolNames = session.getActiveToolNames().filter((name) => name !== recall.name);
    session.setActiveToolsByName(initialToolNames);
    await session.prompt(
      "Remember these synthetic project facts: project Lantern, port 4317. Reply with only OK. Do not use tools.",
    );
    const first = requests.at(-1);
    assert.ok(first && !first["compaction"]);
    const initialTools = first["tools"];

    // Pi defines a tool added after the first request inline, in a system message,
    // and keeps the request-level tool list unchanged.
    session.setActiveToolsByName([...initialToolNames, recall.name]);
    await session.prompt("Reply with only OK. Do not use tools.");
    const added = requests.at(-1);
    assert.ok(added && !added["compaction"]);
    assert.deepEqual(added["tools"], initialTools);
    const definitions = objects(added["messages"]).flatMap((message) =>
      objects(message["content"]).flatMap((block) => {
        if (block["type"] !== "tool_addition") return [];
        const tool = object(block["tool"]);
        return tool["type"] === "tool_definition" ? [object(tool["definition"])["name"]] : [];
      }),
    );
    assert.deepEqual(definitions, [recall.name]);
    const turn = session.messages.at(-1);
    assert.ok(
      turn?.role === "assistant" && turn.stopReason === "stop",
      "Anthropic must accept the inline tool definition.",
    );

    const compacted = await session.compact("Preserve the exact synthetic project facts.");
    const summary = requests.at(-1);
    assert.ok(summary?.["compaction"]);
    const instructions = object(summary["compaction"])["instructions"];
    assert.ok(
      typeof instructions === "string" && instructions.startsWith(summaryInstructions),
      "The summary request must lead with the configured summary instructions.",
    );
    // `/compact` after a finished response: the summary request keeps the inline tool and reads
    // everything the last turn cached.
    const summaryCacheRead = compacted.usage?.cacheRead ?? 0;
    assert.ok(
      summaryCacheRead >= cachedPrefix(turn),
      `The summary request must reuse the turns' cache: read ${summaryCacheRead} of ${cachedPrefix(turn)} cached tokens.`,
    );

    await session.prompt(
      "Call recall_code once with project Lantern, then reply with only the verification code it returns.",
    );
    const last = session.messages.at(-1);
    assert.ok(
      last?.role === "assistant" && last.stopReason === "stop",
      "Expected a successful continuation.",
    );
    assert.equal(recalled.length, 1, "Expected exactly one recall_code call.");
    assertProjectLantern(recalled[0]);
    assert.match(
      last.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(""),
      /7341/,
    );
    const names = objects(requests.at(-1)?.["tools"]).map((tool) => tool["name"]);
    assert.ok(names.includes(recall.name));
    t.diagnostic(
      `claude-sonnet-5-5 accepted an inline tool definition, compacted the full history under configured summary instructions with ${summaryCacheRead} of ${cachedPrefix(turn)} cached tokens read, and called the added tool afterwards.`,
    );
  },
);

for (const keepRecentTokens of [0, 1]) {
  test(
    `live claude-sonnet-5-5 compacts after an interrupted tool call with keepRecentTokens=${keepRecentTokens}`,
    {
      skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
      timeout: 180000,
    },
    async (t) => {
      const lookup = defineTool({
        name: "lookup_value",
        label: "Lookup",
        description: "Look up a stored value by key.",
        parameters: Type.Object({ key: Type.String() }),
        async execute() {
          return { content: [{ type: "text", text: "unused" }], details: {} };
        },
      });
      const { session, manager, requests } = await liveSession(t, "claude-sonnet-5-5", {
        customTools: [lookup],
        keepRecentTokens,
      });
      await session.prompt(
        "Remember these synthetic project facts: project Lantern, port 4317. Reply with only OK. Do not use tools.",
      );
      // Interrupt the next response as soon as it starts streaming a tool call, as a user
      // pressing Escape would.
      let abort: Promise<void> | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (
          !abort &&
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "toolcall_start"
        ) {
          abort = session.abort();
        }
      });
      await session.prompt("Call lookup_value once with key port.");
      await abort;
      unsubscribe();
      const interrupted = session.messages.at(-1);
      assert.ok(
        interrupted?.role === "assistant" &&
          interrupted.stopReason === "aborted" &&
          interrupted.content.some((item) => item.type === "toolCall"),
        "The interrupted response must keep its unanswered tool call.",
      );
      await session.prompt("Ignore that request. Reply with only OK. Do not use tools.");
      await session.compact("Preserve the exact synthetic project facts.");
      assert.ok(requests.at(-1)?.["compaction"]);
      const saved = activeCheckpoint(manager.getBranch());
      assert.ok(saved);
      assert.equal(Boolean(saved.retained), keepRecentTokens > 0);

      await session.prompt(
        "Return only JSON with project and port (number) from the earlier project facts. Do not use tools.",
      );
      const last = session.messages.at(-1);
      assert.ok(
        last?.role === "assistant" && last.stopReason === "stop",
        "Expected a successful continuation.",
      );
      const text = last.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("")
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "");
      const result = object(JSON.parse(text));
      assertProjectLantern(result["project"]);
      assert.equal(result["port"], 4317);
      t.diagnostic(
        `claude-sonnet-5-5 compacted with keepRecentTokens=${keepRecentTokens} after an interrupted tool call and recovered the synthetic facts.`,
      );
    },
  );
}

test(
  "live claude-sonnet-5-5 continues after full-history compaction records a tool removal",
  {
    skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
    timeout: 180000,
  },
  async (t) => {
    const lookup = defineTool({
      name: "lookup_value",
      label: "Lookup",
      description: "Look up a stored value by key.",
      parameters: Type.Object({ key: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "unused" }], details: {} };
      },
    });
    const retired = defineTool({
      name: "retired_report",
      label: "Retired report",
      description: "Report a value. Withdrawn during the conversation.",
      parameters: Type.Object({ value: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "unused" }], details: {} };
      },
    });
    const { session, manager, requests } = await liveSession(t, "claude-sonnet-5-5", {
      customTools: [lookup, retired],
      keepRecentTokens: 0,
    });
    await session.prompt(
      "Remember these synthetic project facts: project Lantern, port 4317. Reply with only OK. Do not use tools.",
    );
    // Pi withdraws the tool with a removal in the conversation and keeps the first `tools` list.
    session.setActiveToolsByName(
      session.getActiveToolNames().filter((name) => name !== retired.name),
    );
    await session.prompt("Reply with only OK. Do not use tools.");
    await session.compact("Preserve the exact synthetic project facts.");
    assert.ok(requests.at(-1)?.["compaction"]);
    const saved = activeCheckpoint(manager.getBranch());
    assert.ok(saved);
    // Anthropic records the removal's net effect in the signed block.
    assert.deepEqual(
      objects(saved.block["tool_changes"]).map((change) => [
        change["type"],
        object(change["tool"])["name"],
      ]),
      [["tool_removal", retired.name]],
    );

    await session.prompt(
      "Return only JSON with project and port (number) from the earlier project facts. Do not use tools.",
    );
    const last = session.messages.at(-1);
    assert.ok(
      last?.role === "assistant" && last.stopReason === "stop",
      "Expected a successful continuation.",
    );
    // The replayed request declares the removed tool again so the block can remove it.
    assert.equal(
      objects(requests.at(-1)?.["tools"]).filter((tool) => tool["name"] === retired.name).length,
      1,
    );
    const text = last.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    const result = object(JSON.parse(text));
    assertProjectLantern(result["project"]);
    assert.equal(result["port"], 4317);
    t.diagnostic(
      "claude-sonnet-5-5 continued after full-history compaction recorded a tool removal in the signed block.",
    );
  },
);

test(
  "live claude-sonnet-5-5 publishes why native compaction was cancelled",
  {
    skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
    timeout: 180000,
  },
  async (t) => {
    const cancellations: unknown[] = [];
    // No recorded request leaves this much recent history, so compaction cancels before any
    // summary request.
    const { session, requests } = await liveSession(t, "claude-sonnet-5-5", {
      keepRecentTokens: 200_000,
      cancellations,
    });
    await session.prompt("Reply with only OK. Do not use tools.");
    const turn = session.messages.at(-1);
    assert.ok(turn?.role === "assistant" && turn.stopReason === "stop", "The turn must succeed.");
    await assert.rejects(session.compact(), { message: "Compaction cancelled" });
    assert.equal(
      requests.some((request) => request["compaction"]),
      false,
    );
    assert.deepEqual(cancellations, [
      {
        source: "pi-anthropic-compat",
        reason:
          "No recorded safe boundary satisfies native tail retention. History was preserved. Run more Anthropic turns or lower Native tail tokens.",
      },
    ]);
    t.diagnostic("claude-sonnet-5-5 published the reason a native compaction was cancelled.");
  },
);

/**
 * A shell command run before the first prompt comes first in Pi's transcript, ahead of the system
 * message that declares the prompt and tools. These scenarios run one, then change the tools,
 * which is the path where Pi's own Anthropic provider loses the prompt cache and earlier thinking.
 */
const SHELL_FIRST_PROMPT =
  "The shell output above names a synthetic project. Remember its name. Then solve this verification problem carefully: find the smallest positive integer n such that n mod 17 = 12, n mod 19 = 8, n mod 23 = 14, and n mod 29 = 7. Check all four congruences before answering. Reply with n and the four checked remainders. Do not use tools.";

async function runShellCommand(session: Awaited<ReturnType<typeof liveSession>>["session"]) {
  // The run ID keeps earlier test runs' caches from matching after the shell output.
  const result = await session.executeBash(
    `printf 'Synthetic shell output for run %s: project Lantern\\n' ${randomUUID()}`,
  );
  assert.equal(result.exitCode, 0);
}

function lastResponse(
  session: Awaited<ReturnType<typeof liveSession>>["session"],
  turn: string,
): AssistantMessage {
  const message = session.messages.at(-1);
  assert.ok(message?.role === "assistant", `The ${turn} turn must end with a response.`);
  assert.equal(message.stopReason, "stop", describeFailure(message));
  return message;
}

function signedThinking(message: AssistantMessage): boolean {
  return message.content.some(
    (item) => item.type === "thinking" && Boolean(item.thinkingSignature),
  );
}

/** Tokens the request read from or wrote to the prompt cache, so the cached prefix it leaves. */
function cachedPrefix(message: AssistantMessage): number {
  return message.usage.cacheRead + message.usage.cacheWrite;
}

/** A system message that carries prompt text, rather than one of Pi's effort markers. */
function promptMessages(request: JsonObject): JsonObject[] {
  return objects(request["messages"]).filter(
    (message) => message["role"] === "system" && !isEffortMessage(message),
  );
}

function inlineTools(request: JsonObject): unknown[] {
  return objects(request["messages"]).flatMap((message) =>
    objects(message["content"]).flatMap((item) => {
      if (item["type"] !== "tool_addition") return [];
      const tool = object(item["tool"]);
      return tool["type"] === "tool_definition" ? [object(tool["definition"])["name"]] : [];
    }),
  );
}

/**
 * Send a turn request again without streaming, with Anthropic's thinking-prefix check enforced.
 * Anthropic accepts it only when every replayed thinking block still follows the prefix it was
 * generated after. Only the status and error category are inspected.
 */
async function enforcedReplay(send: typeof fetch, request: Request): Promise<Response> {
  const body = object(await request.clone().json());
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set(
    "anthropic-beta",
    [headers.get("anthropic-beta"), THINKING_BINDING_BETA].filter(Boolean).join(","),
  );
  return send(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...body,
      stream: false,
      thinking: {
        ...object(body["thinking"]),
        block_binding: { prefix_mismatch_behavior: "error" },
      },
    }),
    signal: AbortSignal.timeout(60000),
    redirect: "error",
  });
}

/**
 * Run a shell command, a thinking turn, then a turn after `recall_code` was added. Pi's
 * mid-conversation tool changes define the tool inline only while `tools` stays fixed.
 */
async function shellFirstToolChange(t: TestContext, compat: boolean) {
  const recalled: string[] = [];
  const recall = defineTool({
    name: "recall_code",
    label: "Recall",
    description: "Return the synthetic verification code for a project.",
    parameters: Type.Object({ project: Type.String() }),
    async execute(_id, params) {
      recalled.push(params.project);
      return { content: [{ type: "text", text: "Verification code: 7341" }], details: {} };
    },
  });
  const live = await liveSession(t, "claude-sonnet-5-5", {
    customTools: [recall],
    keepRecentTokens: 0,
    compat,
  });
  const { session, requests } = live;
  const initialToolNames = session.getActiveToolNames().filter((name) => name !== recall.name);
  session.setActiveToolsByName(initialToolNames);
  await runShellCommand(session);
  await session.prompt(SHELL_FIRST_PROMPT);
  const first = lastResponse(session, "first");
  assert.ok(
    signedThinking(first),
    "Actual signed thinking is required. A successful response without thinking proves nothing.",
  );
  assert.ok(first.usage.cacheWrite > 0, "The first request must write the prompt cache.");
  const firstRequest = requests.at(-1);
  assert.ok(firstRequest);

  session.setActiveToolsByName([...initialToolNames, recall.name]);
  await session.prompt("Reply with only OK. Do not use tools.");
  const second = lastResponse(session, "second");
  const secondRequest = requests.at(-1);
  assert.ok(secondRequest && secondRequest !== firstRequest);
  const continuation = live.continuation();
  assert.ok(continuation);
  return { ...live, recall, recalled, first, firstRequest, second, secondRequest, continuation };
}

test(
  "live claude-sonnet-5-5 control: Pi's own provider loses the prompt cache and thinking at a tool change after a shell command before the first prompt",
  {
    skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
    timeout: 180000,
  },
  async (t) => {
    const run = await shellFirstToolChange(t, false);
    // Pi sends the prompt inside the conversation and the current tools in `tools`.
    assert.equal(promptMessages(run.firstRequest).length, 1);
    assert.notDeepEqual(run.secondRequest["tools"], run.firstRequest["tools"]);
    assert.ok(
      run.second.usage.cacheRead < cachedPrefix(run.first),
      `The control must miss the prompt cache: read ${run.second.usage.cacheRead} of ${cachedPrefix(run.first)} cached tokens.`,
    );
    const replay = await enforcedReplay(run.send, run.continuation);
    assert.equal(replay.status, 400, "Enforced replay must reject the dropped thinking.");
    const error = object(object(await replay.json())["error"]);
    assert.equal(error["type"], "invalid_request_error");
    assert.ok(
      typeof error["message"] === "string" &&
        /thinking/i.test(error["message"]) &&
        /prefix|conversation/i.test(error["message"]),
      "The rejection must come from the thinking-prefix check, not an unrelated validation.",
    );
    t.diagnostic(
      `Control without the extension: the tool change read ${run.second.usage.cacheRead} of ${cachedPrefix(run.first)} cached tokens, and enforced replay rejected the earlier thinking.`,
    );
  },
);

test(
  "live claude-sonnet-5-5 keeps the prompt cache and thinking across a tool change after a shell command before the first prompt",
  {
    skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
    timeout: 180000,
  },
  async (t) => {
    const run = await shellFirstToolChange(t, true);
    assert.equal(promptMessages(run.firstRequest).length, 0, "The prompt must lead in `system`.");
    assert.equal(
      objects(run.firstRequest["tools"]).at(-1)?.["name"],
      "__pi_deferred_placeholder__",
    );
    assert.deepEqual(run.secondRequest["tools"], run.firstRequest["tools"]);
    assert.deepEqual(inlineTools(run.secondRequest), [run.recall.name]);
    assert.ok(
      run.second.usage.cacheRead >= cachedPrefix(run.first),
      `The tool change must keep the prompt cache: read ${run.second.usage.cacheRead} of ${cachedPrefix(run.first)} cached tokens.`,
    );
    const replay = await enforcedReplay(run.send, run.continuation);
    assert.equal(replay.status, 200, "Enforced replay must accept the earlier thinking.");
    await replay.body?.cancel();
    assert.equal(
      run.manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === PROMPT_FIRST_TYPE)
        .length,
      1,
    );

    const compacted = await run.session.compact("Preserve the synthetic project name.");
    const summaryCacheRead = compacted.usage?.cacheRead ?? 0;
    assert.ok(
      summaryCacheRead >= cachedPrefix(run.second),
      `The summary request must reuse the turns' cache: read ${summaryCacheRead} of ${cachedPrefix(run.second)} cached tokens.`,
    );
    // The summary request repeats the turns, including the inline tool, so it shares their prefix.
    const summary = run.requests.at(-1);
    assert.ok(summary?.["compaction"]);
    assert.equal(
      fingerprint(summary["system"] ?? null),
      fingerprint(run.secondRequest["system"] ?? null),
      "The summary request must send the turns' system prompt.",
    );
    assert.deepEqual(summary["tools"], run.secondRequest["tools"]);
    const turns = objects(run.secondRequest["messages"]);
    assert.equal(
      messageHash(objects(summary["messages"]).slice(0, turns.length)),
      messageHash(turns),
      "The summary request must start with the last turn's messages.",
    );
    await run.session.prompt(
      "Call recall_code once with the project name from the shell output, then reply with only the verification code it returns.",
    );
    const last = lastResponse(run.session, "continuation");
    assert.equal(run.recalled.length, 1, "Expected exactly one recall_code call.");
    assertProjectLantern(run.recalled[0]);
    assert.match(
      last.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(""),
      /7341/,
    );
    t.diagnostic(
      `The tool change read ${run.second.usage.cacheRead} of ${cachedPrefix(run.first)} cached tokens, enforced replay accepted the earlier thinking, and the summary request read ${summaryCacheRead} of ${cachedPrefix(run.second)}.`,
    );
  },
);

test(
  "live claude-sonnet-5-5 keep-tail compaction retains signed thinking after a shell command before the first prompt",
  {
    skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { session, manager, requests } = await liveSession(t, "claude-sonnet-5-5", {
      keepRecentTokens: 1,
    });
    await runShellCommand(session);
    await session.prompt(SHELL_FIRST_PROMPT);
    const first = lastResponse(session, "first");
    assert.ok(
      signedThinking(first),
      "Actual signed thinking is required. A successful response without thinking proves nothing.",
    );
    const turn = requests.at(-1);
    assert.ok(turn);
    assert.equal(promptMessages(turn).length, 0, "The prompt must lead in `system`.");

    await session.compact("Preserve the synthetic project name.");
    const saved = activeCheckpoint(manager.getBranch());
    assert.ok(saved?.retained, "Keep-tail compaction must retain the recent response.");
    assert.ok(
      saved.retained.messages.some((message) =>
        objects(message["content"]).some(
          (item) =>
            item["type"] === "thinking" &&
            typeof item["signature"] === "string" &&
            item["signature"].length > 0,
        ),
      ),
      "The retained native tail must contain the original thinking.",
    );
    await session.prompt(
      "Reply with only the synthetic project name from the shell output. Do not use tools.",
    );
    const last = lastResponse(session, "continuation");
    assert.match(
      last.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(""),
      /Lantern/i,
    );
    t.diagnostic(
      "claude-sonnet-5-5 retained signed thinking through keep-tail compaction after a shell command before the first prompt.",
    );
  },
);
