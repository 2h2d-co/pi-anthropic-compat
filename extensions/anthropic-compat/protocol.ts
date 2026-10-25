import { calculateCost, type Model, type Api, type Usage } from "@earendil-works/pi-ai";
import { object, objects, type JsonObject } from "./json.ts";
import { retainedHistory, replayRetained, type RetainedHistory } from "./tail.ts";

export const COMPACTION_BETA = "compact-2026-09-04";
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";
export const CHECKPOINT_TYPE = "pi-anthropic-compat";
export const TEMPLATE_TYPE = "pi-anthropic-compat-template";
export const BOUNDARY_TYPE = "pi-anthropic-compat-boundary";

/**
 * Shared `pi.events` channel that names why an extension cancelled a compaction. Pi reports only
 * "Compaction cancelled", so an extension that requested the compaction, such as
 * pi-compact-assistant, reads the reason here. The payload is `{ source, reason }`, where `reason`
 * is a complete sentence without provider error text.
 */
export const COMPACTION_CANCELLED_CHANNEL = "compaction:cancelled";

const MODELS = new Set([
  "claude-haiku-5-5",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-mythos-5-1",
  "claude-mythos-5",
  "claude-mythos-preview",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5-5",
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
  retained?: RetainedHistory;
  /** Definitions of the tools the block's `tool_changes` name, from the summary request. */
  tools?: JsonObject[];
};

export function checkpoint(details: unknown): Checkpoint | undefined {
  if (details === undefined || details === null) return undefined;
  const data = object(details);
  if (data["type"] !== CHECKPOINT_TYPE) return undefined;
  if (data["version"] !== 1 || typeof data["model"] !== "string") {
    throw new Error("Unsupported Anthropic compaction checkpoint.");
  }
  const block = signedBlock(data["block"]);
  return {
    type: CHECKPOINT_TYPE,
    version: 1,
    model: data["model"],
    block,
    ...(data["retained"] === undefined ? {} : { retained: retainedHistory(data["retained"]) }),
    // Checkpoints written before 0.0.15 have no tool definitions.
    ...(Array.isArray(data["tools"]) ? { tools: objects(data["tools"]) } : {}),
  };
}

function toolName(tool: JsonObject): string | undefined {
  return typeof tool["name"] === "string" ? tool["name"] : undefined;
}

/**
 * Tools the block's `tool_changes` name by reference. With the inline-tools beta, Anthropic
 * records the net tool changes of the summarized turns in the block, relative to the summary
 * request's `tools`. A reference must name a tool declared in a later request's `tools`.
 */
export function referencedTools(block: JsonObject): string[] {
  const changes = block["tool_changes"];
  if (!Array.isArray(changes)) return [];
  const names = objects(changes).flatMap((change) => {
    const tool = object(change["tool"]);
    const name = tool["type"] === "tool_reference" ? toolName(tool) : undefined;
    return name === undefined ? [] : [name];
  });
  return [...new Set(names)];
}

/** Definitions of the tools a request's messages add inline, in order. */
function inlineDefinitions(payload: JsonObject): JsonObject[] {
  const messages = payload["messages"];
  return (Array.isArray(messages) ? objects(messages) : []).flatMap((message) => {
    const content = message["content"];
    if (!Array.isArray(content)) return [];
    return objects(content).flatMap((block) => {
      if (block["type"] !== "tool_addition") return [];
      const tool = object(block["tool"]);
      return tool["type"] === "tool_definition" ? [object(tool["definition"])] : [];
    });
  });
}

/**
 * Definitions of the named tools, from a request's `tools` and the tools its messages define
 * inline. A later definition of a name replaces an earlier one.
 */
export function toolDefinitions(payload: JsonObject, names: readonly string[]): JsonObject[] {
  if (names.length === 0) return [];
  const found = new Map<string, JsonObject>();
  const record = (definition: JsonObject) => {
    const name = toolName(definition);
    if (name !== undefined && names.includes(name)) found.set(name, definition);
  };
  const tools = payload["tools"];
  if (Array.isArray(tools)) objects(tools).forEach(record);
  inlineDefinitions(payload).forEach(record);
  return names.flatMap((name) => {
    const definition = found.get(name);
    return definition ? [definition] : [];
  });
}

/**
 * Declare every tool the block names that the request's `tools` lacks. Pi declares the tools that
 * are current after compaction, so a tool the summarized turns removed is missing, and Anthropic
 * rejects the block's removal of it. Declared again, the block removes it, so the model is offered
 * exactly Pi's current tools.
 */
function declareReferencedTools(payload: JsonObject, saved: Checkpoint): JsonObject {
  const tools = payload["tools"] === undefined ? [] : objects(payload["tools"]);
  const declared = new Set(tools.flatMap((tool) => toolName(tool) ?? []));
  const missing = referencedTools(saved.block).filter((name) => !declared.has(name));
  if (missing.length === 0) return payload;
  const definitions = saved.tools ?? [];
  const added = missing.map((name) => {
    const definition = definitions.find((tool) => toolName(tool) === name);
    if (!definition) {
      throw new Error(
        `The compaction summary refers to the tool ${name}, whose definition was not recorded.`,
      );
    }
    // The summary request may have marked this tool as a cache breakpoint. Anthropic limits a
    // request to four, and Pi places its own.
    const result = { ...definition };
    delete result["cache_control"];
    return result;
  });
  return { ...payload, tools: [...tools, ...added] };
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

export function addBeta(payload: JsonObject, beta = COMPACTION_BETA): JsonObject {
  const betas = payload["betas"];
  if (
    betas !== undefined &&
    (!Array.isArray(betas) || !betas.every((beta) => typeof beta === "string"))
  ) {
    throw new Error("Invalid Anthropic beta configuration.");
  }
  return { ...payload, betas: [...new Set([...(betas ?? []), beta])] };
}

export function enforceThinking(payload: JsonObject): JsonObject {
  if (payload["thinking"] === undefined) return payload;
  const thinking = object(payload["thinking"]);
  if (thinking["type"] !== "adaptive" && thinking["type"] !== "enabled") return payload;
  return addBeta(
    {
      ...payload,
      thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: "error" } },
    },
    THINKING_BINDING_BETA,
  );
}

export function replay(payload: JsonObject, saved: Checkpoint | undefined): JsonObject {
  if (!saved) return payload;
  if (saved.retained) payload = enforceThinking(replayRetained(payload, saved.retained));
  payload = declareReferencedTools(payload, saved);
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
  // Keep the selected effort instead of silently upgrading a low-effort summary
  // to the API's high default. Remove structured output and task budgets.
  if (payload["output_config"] !== undefined) {
    const effort = object(payload["output_config"])["effort"];
    if (typeof effort === "string") result["output_config"] = { effort };
  }
  if (payload["thinking"] !== undefined) {
    const thinking = object(payload["thinking"]);
    if (thinking["type"] === "adaptive") result["thinking"] = thinking;
  }
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
  for (const key of ["system", "tools", "thinking", "output_config"] as const) {
    if (payload[key] !== undefined) result[key] = payload[key];
  }
  // Pi keeps `tools` fixed for models that accept tool changes mid-conversation and defines
  // later tools inline. Their names complete the set of tools the request sent.
  const inline = [...new Set(inlineDefinitions(payload).flatMap((tool) => toolName(tool) ?? []))];
  if (inline.length > 0) result["inlineTools"] = inline;
  return result;
}
