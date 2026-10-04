import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { object } from "../extensions/anthropic-compat/json.ts";

export const PATCHER_SETTINGS_FILE = "pi-system-prompt-patcher.json";
export const ISOLATED_REPLACEMENT_FILE = "pi-system-prompt-patcher-replacements.json";

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
 * directory unchanged, and writes settings that make the actual patcher read the copy. Rules that
 * name Pi's package directory use the patcher's `{piPackageDir}` placeholder, so they match the
 * Pi under test without rewriting. The source settings and rule files stay unchanged.
 * Returns the isolated rule path, or undefined when nothing applies to that provider and model.
 */
export async function isolatePromptPatcher(options: {
  sourceAgentDir: string;
  agentDir: string;
  provider: string;
  model: string;
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
  const replacementPath = join(options.agentDir, ISOLATED_REPLACEMENT_FILE);
  await copyFile(resolveReplacementFile(configured, sourceSettings), replacementPath);
  await writeFile(
    join(options.agentDir, PATCHER_SETTINGS_FILE),
    JSON.stringify({
      providers: { [options.provider]: { models: { [options.model]: ISOLATED_REPLACEMENT_FILE } } },
    }),
  );
  return replacementPath;
}
