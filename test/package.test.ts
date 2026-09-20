import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { object, objects } from "../extensions/anthropic-compat/json.ts";

test("npm archive matches the explicit public-file allowlist", () => {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts", "--allow-directory=all"],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const packages = objects(JSON.parse(output));
  assert.equal(packages.length, 1);
  const files = objects(object(packages[0])["files"]).map((file) => {
    const path = file["path"];
    if (typeof path !== "string") throw new Error("Invalid package file.");
    return path;
  });
  const expected = readFileSync(new URL("../.github/npm-package-files", import.meta.url), "utf8")
    .trim()
    .split("\n");
  const compare = (a: string, b: string) => a.localeCompare(b);
  assert.deepEqual(files.sort(compare), expected.sort(compare));
});
