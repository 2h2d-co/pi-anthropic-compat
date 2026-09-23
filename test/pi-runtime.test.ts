import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

test("in-process Pi uses the repository dependency's package resources", async () => {
  assert.equal(
    await realpath(getPackageDir()),
    await realpath(
      fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url)),
    ),
  );
});
