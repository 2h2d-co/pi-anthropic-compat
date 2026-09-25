import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  settingsMenu,
  waitForSettingsIdle,
  type SettingsField,
  type SettingsMenuFactory,
} from "../settings-menu.ts";
import { SettingsStore } from "../settings-store.ts";
import {
  readSessionSettings,
  sessionSettingsEntry,
  type SettingsSessionContext,
} from "../settings-session.ts";
import { loadConfig, parseConfig, type Config } from "./config.ts";
import { eligibleModel } from "./protocol.ts";
import { object } from "./json.ts";

export const settingFields: SettingsField[] = [
  {
    id: "enabled",
    label: "Native compaction",
    choices: [false, true],
    description: "Off: Pi creates new summaries. Existing signed summaries still replay.",
  },
  {
    id: "keepRecentTokens",
    label: "Native tail tokens",
    choices: [0, 4096, 8192, 16000, 32000],
    description:
      "Retain recent messages unchanged. Zero summarizes all history; safe boundaries can retain more.",
    number: { min: 0, max: 200000, integer: true, unit: "tokens" },
  },
  {
    id: "maxSummaryTokens",
    label: "Summary output budget",
    choices: [2048, 4096, 8192, 16384],
    description:
      "Maximum summary output including internal thinking. Summary generation is billed separately.",
    number: { min: 1024, max: 32768, integer: true, unit: "tokens" },
  },
  {
    id: "timeoutSeconds",
    label: "Compaction timeout",
    choices: [60, 120, 300, 600],
    description: "Time allowed for capability discovery and summary generation.",
    number: { min: 10, max: 600, integer: true, unit: "seconds" },
  },
];
export type SettingsState = {
  get: (ctx: Pick<SettingsContext, "cwd" | "isProjectTrusted" | "sessionManager">) => Config;
  set: (config: Config) => void;
};
export type SettingsContext = Pick<
  ExtensionCommandContext,
  "cwd" | "isProjectTrusted" | "mode" | "model" | "isIdle" | "waitForIdle"
> &
  SettingsSessionContext & {
    ui: {
      custom: <T>(factory: SettingsMenuFactory<T>) => Promise<T>;
      notify: ExtensionCommandContext["ui"]["notify"];
    };
  };
export type SettingsHandler = (args: string, ctx: SettingsContext) => Promise<void>;
export const SESSION_SETTINGS_TYPE = "pi-anthropic-compat:settings";

export function loadSessionConfig(
  ctx: Pick<SettingsContext, "cwd" | "isProjectTrusted" | "sessionManager">,
): Config {
  const saved = readSessionSettings(ctx, SESSION_SETTINGS_TYPE, settingFields);
  return parseConfig(saved.values, loadConfig(ctx.cwd, ctx.isProjectTrusted()).config);
}

export function registerSettings(
  pi: {
    appendEntry: (customType: string, data: unknown) => void;
    registerCommand: (
      name: string,
      options: { description: string; handler: SettingsHandler },
    ) => void;
  },
  state: SettingsState,
): void {
  pi.registerCommand("anthropic-settings", {
    description: "Configure native Anthropic compatibility",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/anthropic-settings requires TUI mode.", "error");
        return;
      }
      const session = ctx.sessionManager.getSessionId();
      const selectedModel = ctx.model;
      const trusted = ctx.isProjectTrusted();
      const store = new SettingsStore(
        join(getAgentDir(), "pi-anthropic-compat.json"),
        trusted ? join(ctx.cwd, CONFIG_DIR_NAME, "pi-anthropic-compat.json") : undefined,
        (global, project) => ({ ...parseConfig(object(project), parseConfig(object(global))) }),
      );
      try {
        await ctx.ui.custom(
          settingsMenu({
            title: "Anthropic Settings",
            store,
            snapshot: await store.load(),
            current: { ...state.get(ctx) },
            session: readSessionSettings(ctx, SESSION_SETTINGS_TYPE, settingFields).session,
            fields: settingFields,
            status: (values) =>
              !values["enabled"]
                ? "Native compaction off: Pi creates new summaries."
                : eligibleModel(ctx.model)
                  ? "Native compaction on. Live API capability is checked when compacting."
                  : "Native compaction configured on; inactive for this model or endpoint.",
            prepare: (signal) => waitForSettingsIdle(() => ctx.waitForIdle(), signal),
            guard: () => {
              if (
                ctx.model?.id !== selectedModel?.id ||
                ctx.model?.provider !== selectedModel?.provider
              ) {
                throw new Error("The selected model changed. Reopen settings.");
              }
              if (
                session !== ctx.sessionManager.getSessionId() ||
                trusted !== ctx.isProjectTrusted()
              ) {
                throw new Error("The session or project trust changed. Reopen settings.");
              }
              if (!ctx.isIdle()) throw new Error("Pi is busy. Retry when idle.");
            },
            apply: (values, sessionState) => {
              pi.appendEntry(
                SESSION_SETTINGS_TYPE,
                sessionSettingsEntry(session, values, sessionState, {}),
              );
              state.set(parseConfig(values));
            },
          }),
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Could not open Anthropic settings.",
          "error",
        );
      }
    },
  });
}
