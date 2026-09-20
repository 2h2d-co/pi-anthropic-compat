import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Only an absent version or an exact archive match permits publication to continue. */
export function isIdenticalPublication(
  output: string,
  exitCode: number | null,
  archive: Uint8Array,
): boolean {
  let metadata: unknown;
  try {
    metadata = JSON.parse(output);
  } catch (error) {
    throw new Error("npm returned invalid publication metadata.", { cause: error });
  }
  if (exitCode !== 0) {
    if (
      exitCode !== null &&
      isRecord(metadata) &&
      isRecord(metadata["error"]) &&
      metadata["error"]["code"] === "E404"
    ) {
      return false;
    }
    throw new Error("npm publication lookup failed.");
  }
  const expected = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (metadata !== expected) {
    throw new Error("Published package integrity does not match the signed release archive.");
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.env["PACKAGE_NAME"];
  const version = process.env["PACKAGE_VERSION"];
  const archive = process.env["archive"];
  const output = process.env["GITHUB_OUTPUT"];
  if (!name || !version || !archive || !output) {
    throw new Error("Package identity, archive, and GitHub output path are required.");
  }
  const result = spawnSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw new Error("npm publication lookup could not complete.");
  const published = isIdenticalPublication(result.stdout, result.status, readFileSync(archive));
  appendFileSync(output, `published=${published}\n`);
  console.log(published ? "Identical package already published." : "Package is not yet published.");
}
