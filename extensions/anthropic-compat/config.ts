import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { object, type JsonObject } from "./json.ts";

export type Config = {
  enabled: boolean;
  keepRecentTokens: number;
  maxSummaryTokens: number;
  timeoutSeconds: number;
  /** Replaces the default summary guidance. `null` keeps the default. */
  summaryInstructions: string | null;
};

/** Anthropic's limit on compaction instructions is 16,384 characters; this leaves room for the rest. */
export const MAX_INSTRUCTIONS_LENGTH = 16_000;

export const DEFAULT_CONFIG: Config = {
  enabled: false,
  keepRecentTokens: 0,
  maxSummaryTokens: 4096,
  timeoutSeconds: 120,
  summaryInstructions: null,
};

export type ConfigFile = { file: string; text: string | undefined; data: JsonObject };

export function readConfigFile(file: string): ConfigFile {
  if (!existsSync(file)) return { file, text: undefined, data: {} };
  const text = readFileSync(file, "utf8");
  return { file, text, data: object(JSON.parse(text)) };
}

export function parseConfig(data: JsonObject, base: Config = DEFAULT_CONFIG): Config {
  const result = { ...base };
  if (data["enabled"] !== undefined) {
    if (typeof data["enabled"] !== "boolean") throw new Error("enabled must be a boolean.");
    result.enabled = data["enabled"];
  }
  for (const [key, minimum, maximum] of [
    ["keepRecentTokens", 0, 200000],
    ["maxSummaryTokens", 1024, 32768],
    ["timeoutSeconds", 10, 600],
  ] as const) {
    const value = data[key];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
    }
    result[key] = value;
  }
  const instructions = data["summaryInstructions"];
  if (instructions !== undefined) {
    const text = typeof instructions === "string" ? instructions.trim() : undefined;
    if (instructions !== null && !text) {
      throw new Error("summaryInstructions must be a nonempty string or null.");
    }
    if (text && text.length > MAX_INSTRUCTIONS_LENGTH) {
      throw new Error("summaryInstructions exceeds 16,000 characters.");
    }
    result.summaryInstructions = text ?? null;
  }
  return result;
}

export function loadConfig(cwd: string, trusted: boolean, agentDir = getAgentDir()) {
  const global = readConfigFile(join(agentDir, "pi-anthropic-compat.json"));
  const globalConfig = parseConfig(global.data);
  const projectFile = join(cwd, CONFIG_DIR_NAME, "pi-anthropic-compat.json");
  const target = trusted && existsSync(projectFile) ? readConfigFile(projectFile) : global;
  return { config: parseConfig(target.data, globalConfig), target };
}
