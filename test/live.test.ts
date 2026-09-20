import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { object } from "../extensions/anthropic-compat/json.ts";
import { activeCheckpoint } from "../extensions/anthropic-compat/runtime.ts";

test(
  "live Sonnet 5 compaction and replay through Pi with the installed system-prompt patcher",
  {
    skip: process.env["PI_ANTHROPIC_LIVE_TEST"] !== "1",
    timeout: 180000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "anthropic-live-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await mkdir(join(root, ".pi"));
    await writeFile(
      join(root, ".pi", "pi-anthropic-compat.json"),
      JSON.stringify({ enabled: true }),
    );
    const realAgentDir = getAgentDir();
    const patcher = join(
      realAgentDir,
      "npm",
      "node_modules",
      "pi-system-prompt-patcher",
      "extensions",
      "index.ts",
    );
    assert.ok(
      existsSync(patcher),
      "Install the system-prompt patcher before running a live Anthropic test.",
    );
    const runtime = await ModelRuntime.create({
      authPath: join(realAgentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    const model = runtime.getModel("anthropic", "claude-sonnet-5");
    assert.ok(model, "Sonnet 5 must exist in the installed Pi model catalog.");
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    settings.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: realAgentDir,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [patcher],
      extensionFactories: [
        extension,
        (pi) =>
          pi.on("before_provider_request", (event) => ({
            ...object(event.payload),
            max_tokens: 512,
          })),
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
      thinkingLevel: "off",
      sessionManager: manager,
      settingsManager: settings,
      resourceLoader: loader,
      noTools: "all",
    });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    await session.prompt(
      "Synthetic project: Lantern. Language: TypeScript. Port: 4317. Storage: SQLite. Constraint: no network access. Next task: implement /health. Reply only OK.",
    );
    const first = session.messages.at(-1);
    if (first?.role === "assistant" && first.stopReason !== "stop") {
      const error = first.errorMessage ?? "";
      const categories = [
        "max_tokens",
        "thinking",
        "tool",
        "OAuth",
        "authentication",
        "rate limit",
        "credit",
        "overloaded",
        "context",
        "model",
        "beta",
      ].filter((category) => error.toLowerCase().includes(category.toLowerCase()));
      t.diagnostic(
        JSON.stringify({
          phase: "initial response",
          stopReason: first.stopReason,
          httpStatus: error.match(/\b[45]\d\d\b/)?.[0],
          categories,
        }),
      );
    }
    assert.ok(
      first?.role === "assistant" && first.stopReason === "stop",
      "The initial synthetic turn must succeed before compaction.",
    );
    const summary = await session.compact("Preserve all six exact synthetic project facts.");
    assert.ok(activeCheckpoint(manager.getBranch()));
    assert.ok(summary.usage && summary.usage.totalTokens > 0);
    await session.prompt(
      "Return only JSON with project, language, port (number), storage, constraint, nextTask from the earlier project facts.",
    );
    const last = session.messages.at(-1);
    assert.ok(
      last?.role === "assistant" && last.stopReason === "stop",
      "Expected a successful continuation.",
    );
    const text = last.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    const json = text
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    const result = object(JSON.parse(json));
    assert.equal(result["project"], "Lantern");
    assert.equal(result["language"], "TypeScript");
    assert.equal(result["port"], 4317);
    assert.equal(result["storage"], "SQLite");
    assert.ok(
      typeof result["constraint"] === "string" && /no network access/i.test(result["constraint"]),
    );
    assert.ok(typeof result["nextTask"] === "string" && result["nextTask"].includes("/health"));
    t.diagnostic(
      "Native compaction, signed replay, and all six synthetic facts passed. No prompts, credentials, or signatures logged.",
    );
  },
);
