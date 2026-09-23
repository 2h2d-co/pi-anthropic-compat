import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { retargetPackageDirectory } from "./prompt-patcher.ts";

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
