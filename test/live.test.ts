import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  getPackageDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { object, objects, type JsonObject } from "../extensions/anthropic-compat/json.ts";
import { activeCheckpoint } from "../extensions/anthropic-compat/runtime.ts";
import { messageHash } from "../extensions/anthropic-compat/tail.ts";
import { isolatePromptPatcher, parentPackageDirectory } from "./prompt-patcher.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const modelId of ["claude-fable-5-1", "claude-opus-5-5"]) {
  test(
    `live ${modelId} low-effort retained thinking with enforced positive and negative controls`,
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
        JSON.stringify({ enabled: true, keepRecentTokens: 1 }),
      );
      // The in-process runtime must use the repository dependency's metadata, not an inherited
      // global package directory. `mise run test:live` binds PI_PACKAGE_DIR accordingly.
      const packageDir = getPackageDir();
      assert.equal(
        await realpath(packageDir),
        await realpath(join(repository, "node_modules/@earendil-works/pi-coding-agent")),
        "Run the live tests through `mise run test:live` so PI_PACKAGE_DIR selects the repository Pi.",
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
      // The patcher reads its settings from PI_CODING_AGENT_DIR on every request. Give it an
      // isolated copy of the effective global rules whose targets name this package directory.
      await isolatePromptPatcher({
        sourceAgentDir: realAgentDir,
        agentDir,
        provider: "anthropic",
        model: modelId,
        from: (await parentPackageDirectory()) ?? packageDir,
        to: packageDir,
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
            assert.equal(
              object(object(body["thinking"])["block_binding"])["prefix_mismatch_behavior"],
              "error",
            );
            requests.push(body);
            if (!body["compaction"]) continuation = request.clone();
          }
          return send(request);
        },
      );
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
              max_tokens: 2048,
              output_config: { effort: "low" },
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
        thinkingLevel: "low",
        sessionManager: manager,
        settingsManager: settings,
        resourceLoader: loader,
        noTools: "all",
      });
      t.after(() => session.dispose());
      await session.bindExtensions({});
      await session.prompt(
        "Remember these six synthetic project facts: project Lantern, language TypeScript, port 4317, storage SQLite, constraint no network access, next task implement /health. Then solve this verification problem carefully: find the smallest positive integer n such that n mod 17 = 12, n mod 19 = 8, n mod 23 = 14, and n mod 29 = 7. Check all four congruences before answering. Reply with n and the four checked remainders. Do not use tools.",
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
      assert.equal(first.model, model.id, "The provider must not fall back to another model.");
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
      const replay = requests.at(-1);
      assert.ok(replay);
      const replayMessages = objects(replay["messages"]);
      assert.ok(
        messageHash(replayMessages.slice(1, 1 + saved.retained.messages.length)) ===
          messageHash(saved.retained.messages),
        "Kept messages must replay unchanged.",
      );
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
