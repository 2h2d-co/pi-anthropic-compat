import assert from "node:assert/strict";
import { resolve } from "node:path";
import { object } from "../extensions/anthropic-compat/json.ts";

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
