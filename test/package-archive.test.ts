import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { packageArchive } from "./package-archive.ts";

test("uses the supplied candidate without packing the working directory", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "anthropic-archive-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const candidate = join(temporary, "candidate.tgz");
  await writeFile(candidate, "synthetic candidate");
  // This directory has no package.json, so an accidental npm pack would fail.
  assert.equal(await packageArchive(temporary, temporary, candidate), await realpath(candidate));
  assert.equal(await readFile(candidate, "utf8"), "synthetic candidate");
  assert.deepEqual(await readdir(temporary), ["candidate.tgz"]);
});

test("resolves a relative candidate path from the working directory", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "anthropic-archive-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const candidate = join(temporary, "candidate.tgz");
  await writeFile(candidate, "synthetic candidate");
  const supplied = relative(process.cwd(), candidate);
  assert.equal(await packageArchive(temporary, temporary, supplied), await realpath(candidate));
  assert.equal(await readFile(candidate, "utf8"), "synthetic candidate");
  assert.deepEqual(await readdir(temporary), ["candidate.tgz"]);
});

test("an invalid supplied candidate never falls back to npm pack", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "anthropic-archive-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await assert.rejects(packageArchive(temporary, temporary, ""), /must not be empty/);
  await assert.rejects(packageArchive(temporary, temporary, join(temporary, "missing.tgz")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(temporary), []);
});

test("standalone validation packs locally when no candidate is supplied", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "anthropic-archive-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ name: "synthetic-live-test", version: "1.0.0" }),
  );
  const archive = await packageArchive(temporary, temporary, undefined);
  assert.equal(archive, join(temporary, "synthetic-live-test-1.0.0.tgz"));
  assert.ok((await readFile(archive)).length > 0);
});
