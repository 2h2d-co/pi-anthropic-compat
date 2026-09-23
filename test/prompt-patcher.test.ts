import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import {
  ISOLATED_REPLACEMENT_FILE,
  isolatePromptPatcher,
  PARENT_PACKAGE_DIR_VARIABLE,
  PATCHER_SETTINGS_FILE,
  parentPackageDirectory,
  resolveReplacementFile,
  retargetPackageDirectory,
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
) => unknown;

type PatcherExtension = (pi: {
  on: (event: "before_provider_request", handler: PatcherHandler) => void;
}) => void;

const PROVIDER = "anthropic";
const MODEL = "claude-fable-5-1";
// The installed patcher is the one both live tests load. Resolve it before any test changes
// PI_CODING_AGENT_DIR.
const installedPatcher = join(
  getAgentDir(),
  "npm/node_modules/pi-system-prompt-patcher/extensions/index.ts",
);
const requiresPatcher = {
  skip: existsSync(installedPatcher)
    ? false
    : "Install pi-system-prompt-patcher under Pi's global npm directory.",
};

test("retargets package paths without changing replacement text or source rules", () => {
  const from = resolve("synthetic/original-pi");
  const to = resolve("synthetic/selected-pi");
  const rules = Object.freeze([
    Object.freeze({ target: `${from}/`, replacement: "replacement directory" }),
    Object.freeze({
      target: `Read ${from}/docs and ${from}/README.md`,
      replacement: `${from}/must-remain-unchanged`,
    }),
    Object.freeze({ target: `${from}-other/docs`, replacement: "" }),
    Object.freeze({ target: "Unrelated instruction", replacement: "Updated instruction" }),
  ]);
  const original = JSON.stringify(rules);
  assert.deepEqual(retargetPackageDirectory(rules, from, to), [
    { target: `${to}/`, replacement: "replacement directory" },
    {
      target: `Read ${to}/docs and ${to}/README.md`,
      replacement: `${from}/must-remain-unchanged`,
    },
    { target: `${from}-other/docs`, replacement: "" },
    { target: "Unrelated instruction", replacement: "Updated instruction" },
  ]);
  assert.equal(JSON.stringify(rules), original);
});

test("keeps rules unchanged when package directories already match", () => {
  const root = resolve("synthetic/pi");
  const rules = [{ target: `${root}/docs`, replacement: "Documentation" }];
  assert.deepEqual(retargetPackageDirectory(rules, `${root}/`, root), rules);
});

test("rejects invalid prompt-patcher rules instead of dropping them", () => {
  for (const [rules, message] of [
    [{}, /Prompt-patcher replacements must be an array/],
    [[null], /Expected a JSON object/],
    [[{ target: "", replacement: "text" }], /A match target is required/],
    [[{ target: 1, replacement: "text" }], /A match target is required/],
    [[{ target: "text" }], /Replacement text is required/],
    [[{ target: "text", replacement: null }], /Replacement text is required/],
  ] as const) {
    assert.throws(() => retargetPackageDirectory(rules, "original", "selected"), message);
  }
});

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
  test(`isolates ${reference} rules for the selected package`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "anthropic-patcher-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    // Home-relative references resolve through HOME, so the synthetic home lives in the
    // temporary directory. Nothing under the real home directory is read or written.
    const home = join(temporary, "home");
    const source = join(home, "agent");
    const agent = join(temporary, "isolated");
    const from = join(temporary, "original-pi");
    const to = join(temporary, "selected-pi");
    await mkdir(join(source, "rules"), { recursive: true });
    await mkdir(join(home, "rules"), { recursive: true });
    await mkdir(agent);
    const rules =
      reference === "home-relative"
        ? join(home, "rules/anthropic.json")
        : join(source, "rules/anthropic.json");
    const ruleText = JSON.stringify([
      {
        target: `Main documentation: ${from}/README.md`,
        replacement: `Docs moved from ${from}/`,
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
      from,
      to,
    });
    assert.equal(isolated, join(agent, ISOLATED_REPLACEMENT_FILE));
    assert.deepEqual(JSON.parse(await readFile(join(agent, PATCHER_SETTINGS_FILE), "utf8")), {
      providers: { anthropic: { models: { [MODEL]: ISOLATED_REPLACEMENT_FILE } } },
    });
    // The source configuration and rules are untouched.
    assert.equal(await readFile(rules, "utf8"), ruleText);
    assert.equal(await readFile(join(source, PATCHER_SETTINGS_FILE), "utf8"), settingsText);
    assert.deepEqual(JSON.parse(await readFile(isolated, "utf8")), [
      {
        target: `Main documentation: ${to}/README.md`,
        replacement: `Docs moved from ${from}/`,
      },
      { target: "Unrelated instruction", replacement: "Updated instruction" },
    ]);

    await t.test("the installed patcher reads the isolated rules", requiresPatcher, async (t) => {
      const handler = await loadInstalledPatcher(temporary);
      const payload = {
        system: `Main documentation: ${to}/README.md\nUnrelated instruction`,
        messages: [{ role: "user", content: "unchanged" }],
      };
      const applied = requestContext();
      assert.deepEqual(handler({ payload }, applied.ctx), {
        ...payload,
        system: `Docs moved from ${from}/\nUpdated instruction`,
      });
      assert.deepEqual(applied.errors, []);
      assert.equal(applied.aborts.count, 0);

      // Regression: settings copied unchanged next to a retargeted copy leave that copy unread. The
      // patcher resolves the configured reference itself, so it either reads the original rules,
      // which name the original package directory, or finds no file at all.
      const copied = join(temporary, "copied");
      await mkdir(copied);
      await writeFile(join(copied, PATCHER_SETTINGS_FILE), settingsText);
      await writeFile(join(copied, ISOLATED_REPLACEMENT_FILE), await readFile(isolated, "utf8"));
      process.env["PI_CODING_AGENT_DIR"] = copied;
      // The patcher also logs the expected failure; keep the test output clean.
      t.mock.method(console, "error", () => undefined);
      const unchanged = requestContext();
      assert.equal(handler({ payload }, unchanged.ctx), undefined);
      assert.equal(unchanged.errors.length, 1);
      assert.match(unchanged.errors[0] ?? "", /target was not found|failed to read/);
      assert.equal(unchanged.aborts.count, reference === "relative" ? 0 : 1);
    });
  });
}

test("reads the captured parent package directory and verifies it is a Pi package", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "anthropic-parent-pi-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const home = join(temporary, "home");
  const pi = join(home, ".pi/pi-coding-agent");
  await mkdir(pi, { recursive: true });
  await writeFile(
    join(pi, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.0" }),
  );
  withEnvironment(t, { HOME: home });
  assert.equal(await parentPackageDirectory({ [PARENT_PACKAGE_DIR_VARIABLE]: pi }), pi);
  assert.equal(
    await parentPackageDirectory({ [PARENT_PACKAGE_DIR_VARIABLE]: "~/.pi/pi-coding-agent" }),
    pi,
  );
  // An empty capture supplies no known source package path.
  assert.equal(await parentPackageDirectory({ [PARENT_PACKAGE_DIR_VARIABLE]: "" }), undefined);
  // Without a capture the in-process package directory is the parent's.
  assert.equal(await parentPackageDirectory({}), getPackageDir());
  const other = join(temporary, "other");
  await mkdir(other);
  await assert.rejects(
    parentPackageDirectory({ [PARENT_PACKAGE_DIR_VARIABLE]: other }),
    /is not a Pi package directory/,
  );
  await writeFile(join(other, "package.json"), JSON.stringify({ name: "another-package" }));
  await assert.rejects(
    parentPackageDirectory({ [PARENT_PACKAGE_DIR_VARIABLE]: other }),
    /is not a Pi package directory/,
  );
  await assert.rejects(
    parentPackageDirectory({ [PARENT_PACKAGE_DIR_VARIABLE]: join(temporary, "missing") }),
    /is not a Pi package directory/,
  );
});

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
    from: "a",
    to: "b",
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

// Node does not strip types under node_modules, so import an exact copy of the installed source.
// The patcher imports only Node built-ins.
async function loadInstalledPatcher(temporary: string): Promise<PatcherHandler> {
  const copy = join(temporary, "pi-system-prompt-patcher.ts");
  await copyFile(installedPatcher, copy);
  const module: unknown = await import(pathToFileURL(copy).href);
  const extension = object(module)["default"];
  assert.ok(isPatcherExtension(extension), "The patcher exports a default factory.");
  let handler: PatcherHandler | undefined;
  extension({
    on(_event, candidate) {
      handler = candidate;
    },
  });
  assert.ok(handler, "The patcher registers a before_provider_request handler.");
  return handler;
}

function isPatcherExtension(value: unknown): value is PatcherExtension {
  return typeof value === "function";
}

// A module namespace is not a JSON object; read the default export without asserting a type.
function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "Expected a module namespace.");
  return Object.fromEntries(Object.entries(value));
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
