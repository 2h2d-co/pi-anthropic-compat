import { calculateCost, type Model, type Api, type Usage } from "@earendil-works/pi-ai";
import { object, objects, type JsonObject } from "./json.ts";

export const COMPACTION_BETA = "compact-2026-09-04";
export const CHECKPOINT_TYPE = "pi-anthropic-compat";
export const TEMPLATE_TYPE = "pi-anthropic-compat-template";
export const BOUNDARY_TYPE = "pi-anthropic-compat-boundary";

const MODELS = new Set([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-mythos-5-1",
  "claude-mythos-5",
  "claude-mythos-preview",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
]);

export function eligibleModel(model: Model<Api> | undefined): model is Model<"anthropic-messages"> {
  if (!model || model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
  const url = new URL(model.baseUrl);
  return url.origin === "https://api.anthropic.com" && MODELS.has(model.id);
}

export type Checkpoint = {
  type: typeof CHECKPOINT_TYPE;
  version: 1;
  model: string;
  block: JsonObject;
};

export function checkpoint(details: unknown): Checkpoint | undefined {
  if (details === undefined || details === null) return undefined;
  const data = object(details);
  if (data["type"] !== CHECKPOINT_TYPE) return undefined;
  if (data["version"] !== 1 || typeof data["model"] !== "string") {
    throw new Error("Unsupported Anthropic compaction checkpoint.");
  }
  const block = signedBlock(data["block"]);
  return { type: CHECKPOINT_TYPE, version: 1, model: data["model"], block };
}

export function signedBlock(value: unknown): JsonObject {
  const block = object(value);
  if (
    block["type"] !== "compaction" ||
    typeof block["content"] !== "string" ||
    !block["content"].trim() ||
    typeof block["signature"] !== "string" ||
    !block["signature"]
  ) {
    throw new Error("Anthropic did not return a nonempty signed compaction block.");
  }
  return block;
}

export function addBeta(payload: JsonObject): JsonObject {
  const betas = payload["betas"];
  if (
    betas !== undefined &&
    (!Array.isArray(betas) || !betas.every((beta) => typeof beta === "string"))
  ) {
    throw new Error("Invalid Anthropic beta configuration.");
  }
  return { ...payload, betas: [...new Set([...(betas ?? []), COMPACTION_BETA])] };
}

export function replay(payload: JsonObject, saved: Checkpoint | undefined): JsonObject {
  if (!saved) return payload;
  const messages = objects(payload["messages"]);
  for (const message of messages) {
    if (
      Array.isArray(message["content"]) &&
      objects(message["content"]).some((block) => block["type"] === "compaction")
    ) {
      throw new Error("Another extension supplied a compaction block.");
    }
  }
  const edits = payload["context_management"];
  if (edits !== undefined) {
    const strategies = objects(object(edits)["edits"]);
    if (
      strategies.some(
        (edit) => typeof edit["type"] === "string" && edit["type"].startsWith("compact_"),
      )
    ) {
      throw new Error("Threshold compaction cannot be combined with a signed summary.");
    }
  }
  return addBeta({
    ...payload,
    messages: [{ role: "assistant", content: [saved.block] }, ...messages],
  });
}

export function summaryPayload(
  payload: JsonObject,
  maxTokens: number,
  instructions?: string,
): JsonObject {
  const result = addBeta({ ...payload, stream: false, max_tokens: maxTokens });
  delete result["context_management"];
  delete result["stop_sequences"];
  delete result["tool_choice"];
  delete result["output_config"];
  delete result["thinking"];
  delete result["fallbacks"];
  const custom = instructions?.trim();
  if (custom && custom.length > 16_000)
    throw new Error("Compaction instructions exceed 16,000 characters.");
  result["compaction"] = {
    type: "summarize",
    instructions: [
      "Write a concise continuation summary. Preserve the user's goals, constraints, decisions, file paths,",
      "completed work, outstanding tasks, and facts needed to continue. Do not call tools. Respond with text only.",
      custom ?? "",
    ].join(" "),
  };
  return result;
}

function tokenCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid Anthropic token usage.");
  }
  return value;
}

export function summaryUsage(response: JsonObject, model: Model<Api>): Usage {
  const iterations = objects(object(response["usage"])["iterations"]);
  if (!iterations.some((item) => item["type"] === "compaction")) {
    throw new Error("Anthropic omitted compaction usage.");
  }
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const item of iterations) {
    usage.input += tokenCount(item["input_tokens"]);
    usage.output += tokenCount(item["output_tokens"]);
    usage.cacheRead += tokenCount(item["cache_read_input_tokens"]);
    usage.cacheWrite += tokenCount(item["cache_creation_input_tokens"]);
    if (item["cache_creation"]) {
      usage.cacheWrite1h =
        (usage.cacheWrite1h ?? 0) +
        tokenCount(object(item["cache_creation"])["ephemeral_1h_input_tokens"]);
    }
  }
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  calculateCost(model, usage);
  return usage;
}

export function parseSummary(response: JsonObject, model: Model<Api>) {
  if (response["stop_reason"] !== "compaction") {
    const stop = response["stop_reason"];
    const reason =
      typeof stop === "string" &&
      ["max_tokens", "model_context_window_exceeded", "refusal", "tool_use", "end_turn"].includes(
        stop,
      )
        ? stop
        : "invalid response";
    throw new Error(`Native compaction produced no summary (${reason}). History was preserved.`);
  }
  if (response["model"] !== model.id) throw new Error("The summary used an unexpected model.");
  const content = objects(response["content"]);
  if (content.length !== 1) throw new Error("Expected exactly one compaction block.");
  const block = signedBlock(content[0]);
  const text = block["content"];
  if (typeof text !== "string") throw new Error("Missing summary text.");
  return { summary: text, usage: summaryUsage(response, model), block };
}

export function template(payload: JsonObject): JsonObject {
  const result: JsonObject = { model: payload["model"] ?? null };
  for (const key of ["system", "tools"] as const) {
    if (payload[key] !== undefined) result[key] = payload[key];
  }
  return result;
}
