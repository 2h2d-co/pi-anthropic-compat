import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { objects } from "../extensions/anthropic-compat/json.ts";

// An explicitly supplied candidate must never fall back to packing the worktree.
export async function packageArchive(
  root: string,
  temporary: string,
  supplied: string | undefined,
): Promise<string> {
  if (supplied !== undefined) {
    assert.ok(supplied.length > 0, "PI_PACKAGE_ARCHIVE must not be empty.");
    return realpath(supplied);
  }
  const packed = objects(
    JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--allow-directory=all",
          "--pack-destination",
          temporary,
        ],
        { cwd: root, encoding: "utf8" },
      ),
    ),
  );
  const filename = packed[0]?.["filename"];
  assert.ok(packed.length === 1 && typeof filename === "string");
  return join(temporary, filename);
}
