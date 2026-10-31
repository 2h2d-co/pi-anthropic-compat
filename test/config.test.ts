import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../extensions/anthropic-compat/config.ts";
import { settingFields } from "../extensions/anthropic-compat/settings.ts";

test("configuration defaults are opt-in and reject invalid ranges", () => {
  assert.equal(DEFAULT_CONFIG.enabled, false);
  for (const data of [
    { enabled: "yes" },
    { maxSummaryTokens: 0 },
    { timeoutSeconds: 601 },
    { maxSummaryTokens: 1.5 },
    { keepRecentTokens: -1 },
    { keepRecentTokens: 200001 },
    { keepRecentTokens: 1.5 },
  ]) {
    assert.throws(() => parseConfig(data));
  }
  assert.equal(parseConfig({ enabled: true }).enabled, true);
  assert.equal(DEFAULT_CONFIG.keepRecentTokens, 0);
  assert.equal(parseConfig({ keepRecentTokens: 16000 }).keepRecentTokens, 16000);
  assert.equal(parseConfig({ keepRecentTokens: 200000 }).keepRecentTokens, 200000);
  assert.equal(settingFields.length, 4);
});

test("summaryInstructions accepts trimmed text or null and rejects other values", () => {
  assert.equal(DEFAULT_CONFIG.summaryInstructions, null);
  assert.equal(
    parseConfig({ summaryInstructions: "  Keep it.\n" }).summaryInstructions,
    "Keep it.",
  );
  const base = parseConfig({ summaryInstructions: "Keep it." });
  assert.equal(parseConfig({ summaryInstructions: null }, base).summaryInstructions, null);
  assert.equal(parseConfig({}, base).summaryInstructions, "Keep it.");
  assert.equal(
    parseConfig({ summaryInstructions: "a".repeat(16000) }).summaryInstructions?.length,
    16000,
  );
  for (const summaryInstructions of ["", " \n", 1, false, ["Keep it."], "a".repeat(16001)]) {
    assert.throws(() => parseConfig({ summaryInstructions }), /summaryInstructions/);
  }
});

test("trusted project overrides, global defaults, and invalid project isolation", async () => {
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
  await writeFile(localFile, "invalid");
  assert.throws(() => loadConfig(root, true, agent));
  assert.doesNotThrow(() => loadConfig(root, false, agent));
});
