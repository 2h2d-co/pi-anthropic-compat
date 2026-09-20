import {
  getSettingsListTheme,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SettingsList,
  Text,
  type Component,
  type SettingItem,
  type TUI,
} from "@earendil-works/pi-tui";
import { loadConfig, parseConfig, saveConfig, type Config } from "./config.ts";

export function settingItems(config: Config): SettingItem[] {
  return [
    {
      id: "enabled",
      label: "Native compaction",
      description:
        "Use signed Anthropic summaries for /compact and Pi auto-compaction. Existing summaries still replay when off.",
      currentValue: config.enabled ? "on" : "off",
      values: ["off", "on"],
    },
    {
      id: "maxSummaryTokens",
      label: "Summary output budget",
      description: "Maximum output tokens for the separate summary request.",
      currentValue: String(config.maxSummaryTokens),
      values: ["2048", "4096", "8192", "16384"],
    },
    {
      id: "timeoutSeconds",
      label: "Compaction timeout",
      description: "Seconds allowed for capability discovery and summary generation.",
      currentValue: String(config.timeoutSeconds),
      values: ["60", "120", "300", "600"],
    },
  ];
}

export function settingPatch(id: string, value: string, current: Config): Config {
  if (id === "enabled" && (value === "on" || value === "off")) {
    return { ...current, enabled: value === "on" };
  }
  if (id === "maxSummaryTokens" || id === "timeoutSeconds") {
    return parseConfig({ [id]: Number(value) }, current);
  }
  throw new Error("Unknown Anthropic setting.");
}

export type SettingsState = {
  get: (ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">) => Config;
  set: (config: Config) => void;
};

export type SettingsFactory<T> = (
  tui: Pick<TUI, "requestRender">,
  theme: Pick<Theme, "fg" | "bold">,
  keybindings: Pick<KeybindingsManager, "matches">,
  done: (value: T) => void,
) => Component;

export type SettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "mode"> & {
  ui: {
    custom: <T>(factory: SettingsFactory<T>) => Promise<T>;
    notify: ExtensionContext["ui"]["notify"];
  };
};

export type SettingsHandler = (args: string, ctx: SettingsContext) => Promise<void>;

export function registerSettings(
  pi: {
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
      let config = state.get(ctx);
      let saved = { ...config };
      let target = loadConfig(ctx.cwd, ctx.isProjectTrusted()).target;
      await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
        let busy = false;
        let notice = `Session changes apply immediately. Ctrl+S saves to ${target.file}.`;
        const list = new SettingsList(
          settingItems(config),
          8,
          getSettingsListTheme(),
          (id, value) => {
            config = settingPatch(id, value, config);
            state.set(config);
            notice = "Unsaved session changes.";
          },
          () => {
            state.set(saved);
            done(undefined);
          },
          { enableSearch: true },
        );
        const save = async (close: boolean) => {
          busy = true;
          notice = "Saving…";
          tui.requestRender();
          try {
            target = await saveConfig(target, config);
            saved = { ...config };
            notice = `Saved to ${target.file}.`;
            if (close) done(undefined);
          } catch (error) {
            notice = error instanceof Error ? error.message : "Could not save settings.";
            ctx.ui.notify(notice, "error");
          } finally {
            busy = false;
            tui.requestRender();
          }
        };
        const saveFailed = (error: unknown): void => {
          busy = false;
          ctx.ui.notify(
            error instanceof Error ? error.message : "Could not finish saving settings.",
            "error",
          );
        };
        const component: Component = {
          render: (width) => [
            ...new Text(
              theme.fg("accent", theme.bold("Anthropic Settings (pi-anthropic-compat)")),
              1,
              1,
            ).render(width),
            ...new Text(theme.fg("dim", notice), 1, 0).render(width),
            ...list.render(width),
            ...new Text(
              theme.fg(
                "dim",
                "↑↓ navigate · Type to filter · Space change · Ctrl+S save · Enter save and close · Esc discard",
              ),
              1,
              1,
            ).render(width),
          ],
          invalidate: () => list.invalidate(),
          handleInput: (data) => {
            if (busy) return;
            if (matchesKey(data, Key.ctrl("s"))) {
              save(false).catch(saveFailed);
              return;
            }
            if (matchesKey(data, Key.enter)) {
              save(true).catch(saveFailed);
              return;
            }
            if (matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel")) {
              state.set(saved);
              done(undefined);
              return;
            }
            list.handleInput(data);
            tui.requestRender();
          },
        };
        return component;
      });
    },
  });
}
