import assert from "node:assert/strict";
import childProcess, { type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const candidate = "synthetic release archive";
const digest = createHash("sha256").update(candidate).digest("hex");
const files = readFileSync(join(root, ".github/npm-package-files"), "utf8")
  .trim()
  .split("\n")
  .map((path) => ({ path, mode: 0o644 }));

for (const [liveStatus, description] of [
  [0, "validates before signing"],
  [1, "stops on live failure"],
  ["spawn-error", "stops when the live process cannot start"],
] as const) {
  test(`release ${description}`, async (t) => {
    const previousArgv = process.argv;
    const previousNpm = process.env["npm_execpath"];
    const calls: string[] = [];
    const archives: string[] = [];
    const spawnError = Object.assign(new Error("spawn mise ENOENT"), { code: "ENOENT" });
    let signed = false;
    process.argv = [process.execPath, join(root, "scripts/release.ts"), "0.0.3"];
    process.env["npm_execpath"] = "synthetic-npm";
    // Intercept every child command. No real Git, npm, Mise, or provider calls occur.
    const mocked = t.mock.method(
      childProcess,
      "spawnSync",
      (command: string, args: string[] = [], options: SpawnSyncOptions = {}) => {
        const operation = [command === process.execPath ? "npm" : command, ...args].join(" ");
        calls.push(operation);
        let stdout = "";
        let status: number | null = 0;
        let error: Error | undefined;
        if (command === "git") {
          const verb = args[0];
          if (verb === "branch") stdout = "main";
          else if (verb === "status" || verb === "fetch" || verb === "add") stdout = "";
          else if (verb === "rev-parse" && args.includes("--verify")) status = 1;
          else if (verb === "rev-parse") stdout = signed ? "release-commit" : "initial-commit";
          else if (verb === "diff") stdout = "package-lock.json\npackage.json";
          else if (verb === "checkout-index") stdout = "";
          else if (verb === "commit") signed = true;
          else if (verb === "-c" || verb === "tag") stdout = "";
          else if (verb === "cat-file") stdout = "commit";
          else if (verb === "log") {
            stdout = args.includes("--pretty=%s") ? "release: v0.0.3" : digest;
          } else throw new Error(`Unexpected Git command: ${operation}`);
        } else if (command === process.execPath) {
          const verb = args[1];
          assert.equal(args[0], "synthetic-npm");
          assert.equal(typeof options.cwd, "string");
          const cwd = String(options.cwd);
          if (verb === "ci") {
            writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
          } else if (verb === "pack") {
            const output = args[args.indexOf("--pack-destination") + 1];
            assert.ok(output);
            const filename = "pi-anthropic-compat-0.0.3.tgz";
            const archive = join(output, filename);
            writeFileSync(archive, candidate);
            archives.push(archive);
            stdout = JSON.stringify([
              { name: "pi-anthropic-compat", version: "0.0.3", filename, files },
            ]);
          } else assert.equal(verb, "version");
        } else if (command === "mise") {
          assert.deepEqual(args, ["run", "test:live"]);
          assert.equal(options.cwd, root);
          assert.equal(options.env?.["PI_PACKAGE_ARCHIVE"], archives[0]);
          assert.equal(
            readFileSync(String(options.env?.["PI_PACKAGE_ARCHIVE"]), "utf8"),
            candidate,
          );
          if (liveStatus === "spawn-error") {
            error = spawnError;
            status = null;
          } else {
            status = liveStatus;
          }
        } else throw new Error(`Unexpected child command: ${operation}`);
        return {
          pid: 0,
          output: [null, stdout, ""],
          stdout,
          stderr: "",
          status,
          signal: null,
          error,
        };
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      mocked.mock.restore();
      syncBuiltinESMExports();
      process.argv = previousArgv;
      if (previousNpm === undefined) delete process.env["npm_execpath"];
      else process.env["npm_execpath"] = previousNpm;
    });

    const script = new URL(`../scripts/release.ts?liveStatus=${liveStatus}`, import.meta.url);
    if (liveStatus === 0) await import(script.href);
    else if (liveStatus === "spawn-error") {
      await assert.rejects(import(script.href), (error: unknown) => error === spawnError);
    } else await assert.rejects(import(script.href), /mise run test:live exited with 1/);

    assert.equal(calls.filter((call) => call === "mise run test:live").length, 1);
    assert.equal(signed, liveStatus === 0);
    assert.equal(calls.includes("git tag v0.0.3"), liveStatus === 0);
    assert.equal(archives.length, liveStatus === 0 ? 2 : 1);
    assert.ok(
      archives.every((archive) => !existsSync(archive)),
      "Temporary candidates are cleaned up.",
    );
    if (liveStatus === 0) {
      const liveIndex = calls.indexOf("mise run test:live");
      const commitIndex = calls.findIndex((call) => call.startsWith("git commit "));
      const rebuildIndex = calls.findLastIndex((call) => call.startsWith("git checkout-index "));
      assert.ok(liveIndex < commitIndex && commitIndex < rebuildIndex);
    }
  });
}
