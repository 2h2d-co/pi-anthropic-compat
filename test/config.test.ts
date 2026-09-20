import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
  readConfigFile,
  saveConfig,
} from "../extensions/anthropic-compat/config.ts";
import { settingItems, settingPatch } from "../extensions/anthropic-compat/settings.ts";
import { object } from "../extensions/anthropic-compat/json.ts";

test("configuration defaults are opt-in and reject invalid ranges", () => {
  assert.equal(DEFAULT_CONFIG.enabled, false);
  for (const data of [
    { enabled: "yes" },
    { maxSummaryTokens: 0 },
    { timeoutSeconds: 601 },
    { maxSummaryTokens: 1.5 },
  ]) {
    assert.throws(() => parseConfig(data));
  }
  assert.equal(settingPatch("enabled", "on", DEFAULT_CONFIG).enabled, true);
  assert.throws(() => settingPatch("other", "on", DEFAULT_CONFIG), /Unknown/);
  assert.equal(settingItems(DEFAULT_CONFIG).length, 3);
});

test("trusted project overrides, global defaults, unknown-key preservation, and concurrent edit protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "anthropic-config-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  await mkdir(join(root, ".pi"));
  const globalFile = join(agent, "pi-anthropic-compat.json");
  const localFile = join(root, ".pi", "pi-anthropic-compat.json");
  await writeFile(
    globalFile,
    JSON.stringify({ enabled: true, timeoutSeconds: 300, futureSetting: 1 }),
  );
  await writeFile(localFile, JSON.stringify({ enabled: false }));
  assert.equal(loadConfig(root, false, agent).config.enabled, true);
  assert.equal(loadConfig(root, true, agent).config.enabled, false);
  assert.equal(loadConfig(root, true, agent).config.timeoutSeconds, 300);
  const target = readConfigFile(globalFile);
  await saveConfig(target, DEFAULT_CONFIG);
  assert.equal(object(JSON.parse(await readFile(globalFile, "utf8")))["futureSetting"], 1);
  await assert.rejects(saveConfig(target, { ...DEFAULT_CONFIG, enabled: true }), /changed on disk/);
  await writeFile(localFile, "invalid");
  assert.throws(() => loadConfig(root, true, agent));
  assert.doesNotThrow(() => loadConfig(root, false, agent));
});
