import assert from "node:assert/strict";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { atLeastVersion, requirePiVersion } from "../extensions/anthropic-compat/pi-version.ts";

test("requires Pi 0.99.1 or later at load time", () => {
  for (const version of ["0.99.1", "0.99.2", "0.100.0", "1.0.0"]) {
    assert.equal(atLeastVersion(version, "0.99.1"), true, version);
  }
  for (const version of ["0.99.0", "0.99.1-rc.1", "0.87.1", "", "latest", undefined]) {
    assert.equal(atLeastVersion(version, "0.99.1"), false, String(version));
  }
  assert.doesNotThrow(() => requirePiVersion("pi-anthropic-compat", VERSION));
  assert.throws(() => requirePiVersion("pi-anthropic-compat", "0.99.0"), {
    message:
      "pi-anthropic-compat requires Pi 0.99.1 or later, but the running Pi reports Pi 0.99.0. " +
      "Exit Pi and start Pi 0.99.1 or later. /reload cannot upgrade the running runtime.",
  });
});
