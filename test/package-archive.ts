import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
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
    // Relative paths resolve from the current working directory. A missing path throws ENOENT.
    const archive = await realpath(supplied);
    assert.ok((await stat(archive)).isFile(), `PI_PACKAGE_ARCHIVE ${supplied} is not a file.`);
    return archive;
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

export function archiveEntries(archive: string): string[] {
  return execFileSync("tar", ["-tzf", archive], { encoding: "utf8", stdio: "pipe" })
    .trim()
    .split("\n")
    .sort();
}
