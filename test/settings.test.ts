import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  registerSettings,
  settingFields,
  type SettingsContext,
  type SettingsHandler,
} from "../extensions/anthropic-compat/settings.ts";
import { DEFAULT_CONFIG } from "../extensions/anthropic-compat/config.ts";

test("Anthropic menu changes apply only after save and preserve provider defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "anthropic-settings-"));
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
  await mkdir(join(root, "agent"));
  t.after(async () => {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previous;
    await rm(root, { recursive: true, force: true });
  });
  initTheme("dark", false);
  let current = { ...DEFAULT_CONFIG };
  let handler: SettingsHandler | undefined;
  let component: Component | undefined;
  let saved: () => void = () => {};
  const applied = new Promise<void>((resolve) => {
    saved = resolve;
  });
  registerSettings(
    {
      registerCommand: (_name, command) => {
        handler = command.handler;
      },
    },
    {
      set: (next) => {
        current = next;
        saved();
      },
    },
  );
  let opened: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const ctx: SettingsContext = {
    cwd: root,
    mode: "tui",
    model: undefined,
    isProjectTrusted: () => false,
    isIdle: () => true,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "synthetic" },
    ui: {
      notify: (message) => assert.fail(message),
      custom: (factory) =>
        new Promise((resolve) => {
          component = factory(
            {
              requestRender: () => {
                component?.render(120);
              },
            },
            { fg: (_color, text) => text, bold: (text) => text },
            getKeybindings(),
            resolve,
          );
          component.render(120);
          opened();
        }),
    },
  };
  assert.ok(handler);
  const pending = handler("", ctx);
  await ready;
  assert.ok(component);
  component.handleInput?.("Native compaction");
  component.handleInput?.("\r");
  assert.equal(current.enabled, false);
  component.handleInput?.("\u0013");
  await applied;
  assert.equal(current.enabled, true);
  const data: unknown = JSON.parse(
    await readFile(join(root, "agent", "pi-anthropic-compat.json"), "utf8"),
  );
  assert.deepEqual(data, { enabled: true });
  component.handleInput?.("\r");
  component.handleInput?.("\u001b");
  await pending;
  assert.equal(current.enabled, true);
  assert.equal(settingFields.length, 4);
  assert.equal(settingFields.find((field) => field.id === "maxSummaryTokens")?.number?.max, 32768);
});
