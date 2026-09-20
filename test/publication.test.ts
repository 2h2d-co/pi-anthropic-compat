import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isIdenticalPublication } from "../scripts/check-published-release.ts";

const archive = Buffer.from("synthetic release archive");
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;

test("publication lookup accepts an exact archive match", () => {
  assert.equal(isIdenticalPublication(JSON.stringify(integrity), 0, archive), true);
});

test("publication lookup permits staging an absent version", () => {
  assert.equal(
    isIdenticalPublication(JSON.stringify({ error: { code: "E404" } }), 1, archive),
    false,
  );
});

test("publication lookup rejects a different published archive", () => {
  assert.throws(
    () => isIdenticalPublication(JSON.stringify(integrity), 0, Buffer.from("different")),
    /integrity does not match/,
  );
});

test("publication lookup rejects authentication and network failures", () => {
  for (const code of ["E401", "E403", "ETIMEDOUT"]) {
    assert.throws(
      () => isIdenticalPublication(JSON.stringify({ error: { code } }), 1, archive),
      /lookup failed/,
    );
  }
});

test("publication lookup rejects incomplete or malformed metadata", () => {
  for (const output of ["", "{", "null", "{}", "[]", '""']) {
    assert.throws(() => isIdenticalPublication(output, 0, archive));
  }
});

test("publication lookup rejects a terminated process even with an E404 body", () => {
  assert.throws(
    () => isIdenticalPublication(JSON.stringify({ error: { code: "E404" } }), null, archive),
    /lookup failed/,
  );
});
