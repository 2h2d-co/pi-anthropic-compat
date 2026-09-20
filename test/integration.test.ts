import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  registerCompatibility,
  activeCheckpoint,
  activeTemplate,
} from "../extensions/anthropic-compat/runtime.ts";
import { object, objects, type JsonObject } from "../extensions/anthropic-compat/json.ts";
import { block, model, summaryResponse, textResponse } from "./fixtures.ts";

async function setup(
  t: TestContext,
  options: {
    automatic?: boolean;
    fail?: boolean;
    enabled?: boolean;
    persistent?: boolean;
    keepRecentTokens?: number;
    managed?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "anthropic-integration-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "pi-anthropic-compat.json"),
    JSON.stringify({
      enabled: options.enabled ?? true,
      keepRecentTokens: options.keepRecentTokens ?? 0,
    }),
  );
  const original = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(() => {
    if (original === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = original;
  });
  const requests: JsonObject[] = [];
  let ordinary = 0;
  let contextWindow = model.contextWindow;
  let onSummary: (() => void) | undefined;
  let system = "Patched synthetic system.";
  const selected = options.managed ? { ...model, id: "claude-fable-5-1" } : model;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, "https://api.anthropic.com");
    if (request.method === "GET") {
      return Response.json({ capabilities: { compaction: { summarize: { supported: true } } } });
    }
    const body = object(await request.json());
    requests.push(body);
    if (body["compaction"]) {
      onSummary?.();
      if (options.fail)
        return Response.json({
          ...summaryResponse(selected.id),
          content: [],
          stop_reason: "max_tokens",
        });
      return Response.json(summaryResponse(selected.id));
    }
    ordinary++;
    return textResponse(
      options.automatic && ordinary === 1 ? contextWindow - 1024 : 100,
      selected.id,
      options.managed,
    );
  };
  t.mock.method(globalThis, "fetch", fetcher);
  const manager = options.persistent
    ? SessionManager.create(root, join(root, "sessions"))
    : SessionManager.inMemory(root);
  const create = async (sessionManager = manager) => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    await runtime.setRuntimeApiKey("anthropic", "test-only");
    const settings = SettingsManager.inMemory({
      compaction: {
        enabled: options.automatic ?? false,
        keepRecentTokens: 1,
        reserveTokens: 16384,
      },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => "Synthetic system before patch.",
      extensionFactories: [
        (pi) => registerCompatibility(pi, fetcher),
        // A later-loaded system-prompt transformer must remain effective.
        (pi) =>
          pi.on("before_provider_request", (event) => ({
            ...object(event.payload),
            system: [{ type: "text", text: system }],
          })),
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      model: selected,
      thinkingLevel: options.managed ? "low" : "off",
      sessionManager,
      settingsManager: settings,
      resourceLoader: loader,
      noTools: "all",
    });
    await session.bindExtensions({});
    contextWindow = session.model?.contextWindow ?? model.contextWindow;
    t.after(() => session.dispose());
    return session;
  };
  const session = await create();
  return {
    session,
    manager,
    requests,
    create,
    setSystem: (value: string) => {
      system = value;
    },
    interrupt: (callback: () => void) => {
      onSummary = callback;
    },
  };
}

test("real Pi session compacts, replays exactly one native block, and retains original history", async (t) => {
  const { session, manager, requests } = await setup(t);
  await session.prompt("Remember the synthetic project Lantern.");
  assert.ok(activeTemplate(manager.getBranch(), model.id));
  const oldMessages = manager.getEntries().filter((entry) => entry.type === "message").length;
  const result = await session.compact("Preserve the project name.");
  assert.equal(result.summary, block["content"]);
  assert.equal(result.usage?.input, 194);
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0]?.role, "compactionSummary");
  assert.equal(
    manager.getEntries().filter((entry) => entry.type === "message").length,
    oldMessages,
  );
  const summaryRequest = requests.find((request) => request["compaction"]);
  assert.ok(summaryRequest);
  assert.deepEqual(summaryRequest["system"], [{ type: "text", text: "Patched synthetic system." }]);
  assert.match(JSON.stringify(summaryRequest["messages"]), /Lantern/);
  await session.prompt("Continue.");
  const latest = requests.at(-1);
  assert.ok(latest);
  const messages = objects(latest["messages"]);
  assert.deepEqual(messages[0], { role: "assistant", content: [block] });
  assert.equal(JSON.stringify(messages).includes("Remember the synthetic project"), false);
  assert.equal(
    JSON.stringify(messages).includes("The conversation history before this point"),
    false,
  );
  await session.compact();
  const repeated = requests.at(-1);
  assert.ok(repeated);
  assert.deepEqual(objects(repeated["messages"])[0], { role: "assistant", content: [block] });
});

test("native replay and manual compaction survive extension reload and branch navigation", async (t) => {
  const { session, manager, requests, create } = await setup(t, { persistent: true });
  await session.prompt("Original branch facts.");
  const before = manager.getLeafId();
  assert.ok(before);
  await session.compact();
  await session.prompt("A new turn before restart.");
  const file = manager.getSessionFile();
  assert.ok(file);
  session.dispose();
  const restored = SessionManager.open(file);
  const resumed = await create(restored);
  await resumed.compact();
  await resumed.prompt("Resumed.");
  const replayed = requests.at(-1);
  assert.ok(replayed);
  assert.deepEqual(objects(replayed["messages"])[0], { role: "assistant", content: [block] });
  await resumed.compact();
  await resumed.navigateTree(before, { summarize: false });
  assert.equal(activeCheckpoint(restored.getBranch()), undefined);
  await resumed.prompt("Different branch.");
  assert.equal(JSON.stringify(requests.at(-1)).includes("test-signature"), false);
});

test("aborted native compaction preserves the original session", async (t) => {
  const { session, manager, interrupt } = await setup(t);
  await session.prompt("Keep facts after abort.");
  const leaf = manager.getLeafId();
  interrupt(() => session.abortCompaction());
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(activeCheckpoint(manager.getBranch()), undefined);
});

test("concurrent session changes invalidate an in-flight summary without overwriting them", async (t) => {
  const { session, manager, interrupt } = await setup(t);
  await session.prompt("Keep original branch.");
  interrupt(() => {
    manager.appendCustomEntry("concurrent-fixture", { preserved: true });
  });
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafEntry()?.type, "custom");
  assert.equal(activeCheckpoint(manager.getBranch()), undefined);
});

test("native failure cancels compaction without losing history or falling back", async (t) => {
  const { session, manager, requests } = await setup(t, { fail: true });
  await session.prompt("Keep these facts.");
  const leaf = manager.getLeafId();
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(activeCheckpoint(manager.getBranch()), undefined);
  assert.equal(requests.length, 2);
});

test("Pi automatic threshold invokes native compaction", async (t) => {
  const { session, manager, requests } = await setup(t, { automatic: true });
  const reasons: string[] = [];
  session.subscribe((event) => {
    if (event.type === "compaction_start") reasons.push(event.reason);
  });
  await session.prompt("Automatic compaction fixture.");
  assert.ok(activeCheckpoint(manager.getBranch()));
  assert.equal(requests.filter((request) => request["compaction"]).length, 1);
  assert.deepEqual(reasons, ["threshold"]);
});

test("disabled feature leaves ordinary requests unchanged", async (t) => {
  const { session, requests } = await setup(t, { enabled: false });
  await session.prompt("No compaction.");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.["compaction"], undefined);
});

test("keep-tail compaction preserves thinking, survives cold resume, and compacts repeatedly", async (t) => {
  const { session, manager, requests, create } = await setup(t, {
    keepRecentTokens: 1,
    managed: true,
    persistent: true,
  });
  await session.prompt("Older facts.");
  await session.prompt("Recent facts.");
  const before = manager.getLeafId();
  const original = [...session.messages];
  await session.compact();
  const saved = activeCheckpoint(manager.getBranch());
  assert.ok(saved?.retained);
  assert.equal(saved.retained.messages[0]?.["role"], "assistant");
  assert.ok(saved.retained.leading);
  assert.equal(session.messages.length, 2);
  assert.deepEqual(session.messages[1], original.at(-1));
  const summary = requests.at(-1);
  assert.ok(summary);
  // The last response is kept, not summarized.
  assert.equal(objects(summary["messages"]).at(-1)?.["role"], "system");
  assert.equal(
    object(object(summary["thinking"])["block_binding"])["prefix_mismatch_behavior"],
    "error",
  );
  const file = manager.getSessionFile();
  assert.ok(file);
  session.dispose();
  const restored = SessionManager.open(file);
  const resumed = await create(restored);
  await resumed.prompt("Continue after restart.");
  const request = requests.at(-1);
  assert.ok(request);
  const replayed = objects(request["messages"]);
  assert.deepEqual(replayed[0], { role: "assistant", content: [block] });
  assert.deepEqual(replayed.slice(1, 1 + saved.retained.messages.length), saved.retained.messages);
  assert.equal(
    object(object(request["thinking"])["block_binding"])["prefix_mismatch_behavior"],
    "error",
  );
  await resumed.compact();
  assert.ok(activeCheckpoint(restored.getBranch())?.retained);
  assert.ok(before);
  await resumed.navigateTree(before, { summarize: false });
  assert.equal(activeCheckpoint(restored.getBranch()), undefined);
  await resumed.prompt("Original history branch.");
  assert.equal(JSON.stringify(requests.at(-1)).includes("test-signature"), false);
});

test("tail retention cancels without a qualifying recorded boundary and never falls back to full history", async (t) => {
  const { session, manager, requests } = await setup(t, { keepRecentTokens: 200000 });
  await session.prompt("A short conversation.");
  const leaf = manager.getLeafId();
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(requests.length, 1);
});

test("changed system instructions reject native tail selection and replay before transmission", async (t) => {
  const { session, manager, requests, setSystem } = await setup(t, { keepRecentTokens: 1 });
  await session.prompt("Original system.");
  const leaf = manager.getLeafId();
  setSystem("Changed system.");
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(requests.length, 1);
  setSystem("Patched synthetic system.");
  await session.compact();
  setSystem("Changed again.");
  await session.prompt("Must not transmit.");
  assert.equal(requests.length, 2);
  const last = session.messages.at(-1);
  assert.ok(last?.role === "assistant" && last.stopReason === "error");
});

test("automatic compaction can retain the last native response", async (t) => {
  const { session, manager } = await setup(t, {
    keepRecentTokens: 1,
    automatic: true,
    managed: true,
  });
  await session.prompt("Automatic retained thinking.");
  assert.ok(activeCheckpoint(manager.getBranch())?.retained);
  assert.equal(session.messages.length, 2);
});

test("retention rounds up to an earlier safe request when the latest response is too small", async (t) => {
  const { session, manager, requests } = await setup(t, { keepRecentTokens: 16 });
  await session.prompt("Old facts.");
  await session.prompt("Recent exact instruction with enough text to retain across compaction.");
  const original = [...session.messages];
  await session.compact();
  assert.deepEqual(session.messages.slice(1), original.slice(1));
  assert.equal(activeCheckpoint(manager.getBranch())?.retained?.messages.length, 3);
  const request = requests.at(-1);
  assert.ok(request);
  assert.equal(objects(request["messages"]).length, 1);
  assert.equal(JSON.stringify(request["messages"]).includes("Recent exact instruction"), false);
});

test("system changes while summarization runs invalidate the result before it is applied", async (t) => {
  const { session, manager, requests, setSystem, interrupt } = await setup(t, {
    keepRecentTokens: 1,
  });
  await session.prompt("Original instructions.");
  const leaf = manager.getLeafId();
  interrupt(() => setSystem("Changed during the summary."));
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(activeCheckpoint(manager.getBranch()), undefined);
  assert.equal(requests.length, 2);
});

test("forked sessions replay the exact retained thinking without modifying the original file", async (t) => {
  const { session, manager, requests, create } = await setup(t, {
    keepRecentTokens: 1,
    managed: true,
    persistent: true,
  });
  await session.prompt("Forkable native history.");
  await session.compact();
  const saved = activeCheckpoint(manager.getBranch());
  assert.ok(saved?.retained);
  const file = manager.getSessionFile();
  const leaf = manager.getLeafId();
  assert.ok(file && leaf);
  session.dispose();
  const original = await readFile(file, "utf8");
  const forkManager = SessionManager.open(file);
  const forkFile = forkManager.createBranchedSession(leaf);
  assert.ok(forkFile && forkFile !== file);
  const fork = await create(forkManager);
  await fork.prompt("Continue on the fork.");
  const payload = requests.at(-1);
  assert.ok(payload);
  assert.deepEqual(
    objects(payload["messages"]).slice(1, 1 + saved.retained.messages.length),
    saved.retained.messages,
  );
  assert.equal(await readFile(file, "utf8"), original);
});
