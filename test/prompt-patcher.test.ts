import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  getPackageDir,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  ISOLATED_REPLACEMENT_FILE,
  isolatePromptPatcher,
  PATCHER_SETTINGS_FILE,
  resolveReplacementFile,
  selectReplacementFile,
} from "./prompt-patcher.ts";

type PatcherHandler = (
  event: { payload: unknown },
  ctx: {
    model: { provider: string; id: string };
    hasUI: boolean;
    abort: () => void;
    ui: { notify: (message: string, level: "error") => void };
  },
) => Promise<unknown>;

const PROVIDER = "anthropic";
const MODEL = "claude-fable-5-1";
// The pinned development dependency is the patcher both live tests load.
const pinnedPatcher = fileURLToPath(
  new URL("../node_modules/pi-system-prompt-patcher/extensions/index.ts", import.meta.url),
);

test("selects the model file over the provider file like the patcher", () => {
  const settings = {
    providers: {
      anthropic: {
        replacementFile: "provider.json",
        models: { [MODEL]: "/absolute/model.json" },
      },
      other: { models: { "only-model": "~/other.json" } },
    },
  };
  assert.equal(selectReplacementFile(settings, PROVIDER, MODEL), "/absolute/model.json");
  assert.equal(selectReplacementFile(settings, PROVIDER, "claude-sonnet-5"), "provider.json");
  assert.equal(selectReplacementFile(settings, "other", "only-model"), "~/other.json");
  assert.equal(selectReplacementFile(settings, "other", "unlisted"), undefined);
  assert.equal(selectReplacementFile(settings, "unknown", MODEL), undefined);
  assert.throws(
    () =>
      selectReplacementFile({ providers: { anthropic: { replacementFile: "" } } }, PROVIDER, MODEL),
    /non-empty string/,
  );
  assert.throws(() => selectReplacementFile({}, PROVIDER, MODEL), /Expected a JSON object/);
});

test("resolves relative, absolute, and home-relative replacement files like the patcher", () => {
  const settingsPath = resolve("synthetic/agent", PATCHER_SETTINGS_FILE);
  assert.equal(
    resolveReplacementFile("rules/anthropic.json", settingsPath),
    resolve("synthetic/agent/rules/anthropic.json"),
  );
  assert.equal(
    resolveReplacementFile("../shared/anthropic.json", settingsPath),
    resolve("synthetic/shared/anthropic.json"),
  );
  assert.equal(
    resolveReplacementFile("/absolute/anthropic.json", settingsPath),
    "/absolute/anthropic.json",
  );
  assert.equal(
    resolveReplacementFile("~/rules/anthropic.json", settingsPath),
    join(homedir(), "rules/anthropic.json"),
  );
  assert.equal(resolveReplacementFile("~", settingsPath), homedir());
});

for (const [reference, describeSettings] of [
  [
    "relative",
    (_source: string, _rules: string) => ({
      providers: { anthropic: { replacementFile: "rules/anthropic.json" } },
    }),
  ],
  [
    "absolute",
    (_source: string, rules: string) => ({ providers: { anthropic: { replacementFile: rules } } }),
  ],
  [
    "home-relative",
    (_source: string, _rules: string) => ({
      providers: { anthropic: { replacementFile: "~/rules/anthropic.json" } },
    }),
  ],
  [
    "model override",
    (source: string, rules: string) => ({
      providers: {
        anthropic: {
          replacementFile: join(source, "provider-must-not-apply.json"),
          models: { [MODEL]: rules },
        },
      },
    }),
  ],
] as const) {
  test(`isolates ${reference} rules unchanged for the patcher to read`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "anthropic-patcher-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    // Home-relative references resolve through HOME, so the synthetic home lives in the
    // temporary directory. Nothing under the real home directory is read or written.
    const home = join(temporary, "home");
    const source = join(home, "agent");
    const agent = join(temporary, "isolated");
    // The pinned patcher runs in this process, so the placeholder resolves to the repository Pi.
    const piPackageDir = resolve(getPackageDir());
    await mkdir(join(source, "rules"), { recursive: true });
    await mkdir(join(home, "rules"), { recursive: true });
    await mkdir(agent);
    const rules =
      reference === "home-relative"
        ? join(home, "rules/anthropic.json")
        : join(source, "rules/anthropic.json");
    const ruleText = JSON.stringify([
      {
        target: "Main documentation: {piPackageDir}/README.md",
        replacement: "Docs moved to /opt/docs/{piVersion}/",
      },
      { target: "Unrelated instruction", replacement: "Updated instruction" },
    ]);
    const settingsText = JSON.stringify(describeSettings(source, rules));
    await writeFile(rules, ruleText);
    await writeFile(join(source, PATCHER_SETTINGS_FILE), settingsText);
    await writeFile(join(source, "provider-must-not-apply.json"), JSON.stringify([]));
    withEnvironment(t, { HOME: home, PI_CODING_AGENT_DIR: agent });

    const isolated = await isolatePromptPatcher({
      sourceAgentDir: source,
      agentDir: agent,
      provider: PROVIDER,
      model: MODEL,
    });
    assert.equal(isolated, join(agent, ISOLATED_REPLACEMENT_FILE));
    assert.deepEqual(JSON.parse(await readFile(join(agent, PATCHER_SETTINGS_FILE), "utf8")), {
      providers: { anthropic: { models: { [MODEL]: ISOLATED_REPLACEMENT_FILE } } },
    });
    // The source configuration and rules are untouched.
    assert.equal(await readFile(rules, "utf8"), ruleText);
    assert.equal(await readFile(join(source, PATCHER_SETTINGS_FILE), "utf8"), settingsText);
    assert.equal(await readFile(isolated, "utf8"), ruleText);

    await t.test("the pinned patcher reads the isolated rules", async () => {
      const handler = await loadPinnedPatcher(temporary);
      const payload = {
        system: `Main documentation: ${piPackageDir}/README.md\nUnrelated instruction`,
        messages: [{ role: "user", content: "unchanged" }],
      };
      const applied = requestContext();
      assert.deepEqual(await handler({ payload }, applied.ctx), {
        ...payload,
        system: `Docs moved to /opt/docs/${VERSION}/\nUpdated instruction`,
      });
      assert.deepEqual(applied.errors, []);
      assert.equal(applied.aborts.count, 0);
    });
  });
}

test("isolation preserves missing settings and a configured provider's no-op behavior", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "anthropic-patcher-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, "source");
  const agent = join(temporary, "isolated");
  await mkdir(source);
  await mkdir(agent);
  const options = {
    sourceAgentDir: source,
    agentDir: agent,
    provider: PROVIDER,
    model: MODEL,
  };
  assert.equal(await isolatePromptPatcher(options), undefined);
  assert.equal(existsSync(join(agent, PATCHER_SETTINGS_FILE)), false);
  await writeFile(
    join(source, PATCHER_SETTINGS_FILE),
    JSON.stringify({ providers: { other: { replacementFile: "other.json" } } }),
  );
  assert.equal(await isolatePromptPatcher(options), undefined);
  assert.deepEqual(JSON.parse(await readFile(join(agent, PATCHER_SETTINGS_FILE), "utf8")), {
    providers: {},
  });
  assert.equal(existsSync(join(agent, ISOLATED_REPLACEMENT_FILE)), false);
});

// Load the patcher's TypeScript through Pi so host imports use the same aliases as a real session.
async function loadPinnedPatcher(temporary: string): Promise<PatcherHandler> {
  const loader = new DefaultResourceLoader({
    cwd: temporary,
    agentDir: join(temporary, "loader-agent"),
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [pinnedPatcher],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((candidate) => candidate.path === pinnedPatcher);
  assert.ok(extension, "Pi loads the pinned patcher.");
  const [handler] = extension.handlers.get("before_provider_request") ?? [];
  assert.ok(handler, "The patcher registers a before_provider_request handler.");
  return handler;
}

function requestContext() {
  const errors: string[] = [];
  const aborts = { count: 0 };
  return {
    errors,
    aborts,
    ctx: {
      model: { provider: PROVIDER, id: MODEL },
      hasUI: true,
      abort() {
        aborts.count += 1;
      },
      ui: {
        notify(message: string) {
          errors.push(message);
        },
      },
    },
  };
}

function withEnvironment(t: TestContext, values: Record<string, string>): void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
