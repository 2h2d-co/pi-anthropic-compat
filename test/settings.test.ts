import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  registerSettings,
  type SettingsContext,
  type SettingsHandler,
} from "../extensions/anthropic-compat/settings.ts";
import { DEFAULT_CONFIG } from "../extensions/anthropic-compat/config.ts";
import { object } from "../extensions/anthropic-compat/json.ts";

test(
  "settings menu applies drafts, saves with Ctrl+S, and discards later edits with Escape",
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "anthropic-settings-"));
    await mkdir(join(root, "agent"));
    const original = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
    t.after(() => {
      if (original === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = original;
    });
    initTheme("dark", false);
    let current = { ...DEFAULT_CONFIG };
    let handler: SettingsHandler | undefined;
    let component: Component | undefined;
    let onSaved: (() => void) | undefined;
    const savedRendering = new Promise<undefined>((resolve) => {
      onSaved = () => resolve(undefined);
    });
    const notices: string[] = [];
    registerSettings(
      {
        registerCommand: (name, command) => {
          assert.equal(name, "anthropic-settings");
          handler = command.handler;
        },
      },
      {
        get: () => current,
        set: (next) => {
          current = next;
        },
      },
    );
    const ctx: SettingsContext = {
      cwd: root,
      isProjectTrusted: () => false,
      mode: "tui",
      ui: {
        notify: (message) => {
          notices.push(message);
        },
        custom: (factory) =>
          new Promise((resolve) => {
            component = factory(
              {
                requestRender: () => {
                  if (component?.render(120).some((line) => line.includes("Saved to"))) onSaved?.();
                },
              },
              { fg: (_color, text) => text, bold: (text) => text },
              { matches: () => false },
              resolve,
            );
          }),
      },
    };
    assert.ok(handler);
    const pending = handler("", ctx);
    assert.ok(component);
    assert.equal(typeof component.handleInput, "function");
    component.handleInput?.(" ");
    assert.equal(current.enabled, true);
    component.handleInput?.("\u001b[B");
    component.handleInput?.(" ");
    assert.equal(current.keepRecentTokens, 4096);
    component.handleInput?.("\u001b[A");
    for (const width of [40, 80, 120]) {
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
    component.handleInput?.("\u0013");
    await savedRendering;
    const saved = object(
      JSON.parse(await readFile(join(root, "agent", "pi-anthropic-compat.json"), "utf8")),
    );
    assert.equal(saved["enabled"], true);
    assert.equal(saved["keepRecentTokens"], 4096);
    component.handleInput?.(" ");
    assert.equal(current.enabled, false);
    component.handleInput?.("\u001b");
    await pending;
    assert.equal(current.enabled, true);
    assert.deepEqual(notices, []);
  },
);
