import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the release-gating Anthropic tests through the repository's Pi dependency. Pi finds its
// own package directory, so an inherited PI_PACKAGE_DIR is removed rather than replaced.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env: NodeJS.ProcessEnv = { ...process.env };
delete env["PI_PACKAGE_DIR"];

function runTests(files: string[], testEnv: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: root,
    env: testEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The packaged settings tests run offline first, so a terminal failure stops the gate before any
// billed request.
runTests(["test/settings-cli.test.ts"], env);
runTests(["test/live.test.ts", "test/cli.live.test.ts"], { ...env, PI_ANTHROPIC_LIVE_TEST: "1" });
