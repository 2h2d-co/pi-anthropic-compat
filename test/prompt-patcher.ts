import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { object } from "../extensions/anthropic-compat/json.ts";

export const PATCHER_SETTINGS_FILE = "pi-system-prompt-patcher.json";
export const ISOLATED_REPLACEMENT_FILE = "pi-system-prompt-patcher-replacements.json";
// The Mise live task captures the parent's Pi package root here before binding PI_PACKAGE_DIR
// to the repository dependency. Global prompt-patcher rules describe that parent runtime.
export const PARENT_PACKAGE_DIR_VARIABLE = "PI_ANTHROPIC_PARENT_PACKAGE_DIR";

// Change only package-directory references in match targets, never replacement text.
export function retargetPackageDirectory(value: unknown, from: string, to: string) {
  assert.ok(Array.isArray(value), "Prompt-patcher replacements must be an array.");
  const source = `${resolve(from)}/`;
  const destination = `${resolve(to)}/`;
  return value.map((item: unknown) => {
    const rule = object(item);
    const target = rule["target"];
    assert.ok(typeof target === "string" && target.length > 0, "A match target is required.");
    assert.ok(typeof rule["replacement"] === "string", "Replacement text is required.");
    return { ...rule, target: target.replaceAll(source, destination) };
  });
}

// Mirrors pi-system-prompt-patcher: a model file overrides the provider file.
export function selectReplacementFile(
  settings: unknown,
  provider: string,
  model: string,
): string | undefined {
  const providerSettings = object(object(settings)["providers"])[provider];
  if (providerSettings === undefined) return undefined;
  const entry = object(providerSettings);
  const models = entry["models"] === undefined ? {} : object(entry["models"]);
  const configured = models[model] ?? entry["replacementFile"];
  if (configured === undefined) return undefined;
  assert.ok(
    typeof configured === "string" && configured.length > 0,
    "A replacement file path must be a non-empty string.",
  );
  return configured;
}

// Mirrors pi-system-prompt-patcher: relative paths resolve from the settings directory and
// `~` refers to the home directory. Absolute paths are used as written.
export function resolveReplacementFile(configured: string, settingsPath: string): string {
  if (configured === "~") return homedir();
  if (/^~[\\/]/.test(configured)) return resolve(homedir(), configured.slice(2));
  return resolve(dirname(settingsPath), configured);
}

/**
 * Copies the effective replacement rules for one provider and model into an isolated agent
 * directory, retargets package-directory references in their match targets, and writes settings
 * that make the actual patcher read the copy. The source settings and rule files stay unchanged.
 * Returns the isolated rule path, or undefined when nothing applies to that provider and model.
 */
export async function isolatePromptPatcher(options: {
  sourceAgentDir: string;
  agentDir: string;
  provider: string;
  model: string;
  from: string;
  to: string;
}): Promise<string | undefined> {
  const sourceSettings = join(options.sourceAgentDir, PATCHER_SETTINGS_FILE);
  if (!existsSync(sourceSettings)) return undefined;
  const settings: unknown = JSON.parse(await readFile(sourceSettings, "utf8"));
  const configured = selectReplacementFile(settings, options.provider, options.model);
  if (configured === undefined) {
    await writeFile(
      join(options.agentDir, PATCHER_SETTINGS_FILE),
      JSON.stringify({ providers: {} }),
    );
    return undefined;
  }
  const rules: unknown = JSON.parse(
    await readFile(resolveReplacementFile(configured, sourceSettings), "utf8"),
  );
  const replacementPath = join(options.agentDir, ISOLATED_REPLACEMENT_FILE);
  await writeFile(
    replacementPath,
    JSON.stringify(retargetPackageDirectory(rules, options.from, options.to)),
  );
  await writeFile(
    join(options.agentDir, PATCHER_SETTINGS_FILE),
    JSON.stringify({
      providers: { [options.provider]: { models: { [options.model]: ISOLATED_REPLACEMENT_FILE } } },
    }),
  );
  return replacementPath;
}

/**
 * The package directory that global prompt-patcher rules describe. The Mise live task records
 * parent's PI_PACKAGE_DIR, expanded like Pi's runtime. An empty capture supplies no known
 * source, so targets remain unchanged and the patcher detects any mismatch. A direct invocation
 * without a capture uses the in-process package directory as its source.
 */
export async function parentPackageDirectory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const captured = env[PARENT_PACKAGE_DIR_VARIABLE];
  if (captured === "") return undefined;
  const directory = captured === undefined ? getPackageDir() : resolve(expandTilde(captured));
  const manifest = join(directory, "package.json");
  assert.ok(existsSync(manifest), `${directory} is not a Pi package directory.`);
  assert.equal(
    object(JSON.parse(await readFile(manifest, "utf8")))["name"],
    "@earendil-works/pi-coding-agent",
    `${directory} is not a Pi package directory.`,
  );
  return directory;
}

// Mirrors Pi's PI_PACKAGE_DIR normalization for `~` and `~/`.
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
