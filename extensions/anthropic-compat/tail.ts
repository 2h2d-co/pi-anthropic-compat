import { createHash } from "node:crypto";
import {
  buildContextEntries,
  estimateTokens,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isObject, object, objects, type Json, type JsonObject } from "./json.ts";

export const REQUEST_TYPE = "pi-anthropic-compat-request";

export type RetainedHistory = {
  template: JsonObject;
  messages: JsonObject[];
  leading?: JsonObject;
};

function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sorted(item)]),
  );
}

function withoutCache(value: JsonObject): JsonObject {
  const result = { ...value };
  delete result["cache_control"];
  return result;
}

function normalizeBlock(block: JsonObject): JsonObject {
  const result = withoutCache(block);
  // Never normalize tool inputs or arbitrary nested data as provider metadata.
  if (result["type"] === "tool_result" && Array.isArray(result["content"])) {
    result["content"] = objects(result["content"]).map(normalizeBlock);
  }
  return result;
}

function normalizeMessages(messages: JsonObject[]): JsonObject[] {
  return messages.map((message) => {
    const content = message["content"];
    return {
      ...message,
      content:
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : objects(content).map(normalizeBlock),
    };
  });
}

export function fingerprint(value: Json): string {
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}

export function messageHash(messages: JsonObject[]): string {
  return fingerprint(normalizeMessages(messages));
}

export function bindingTemplate(payload: JsonObject): JsonObject {
  const system = payload["system"];
  return {
    model: payload["model"] ?? null,
    system:
      typeof system === "string"
        ? [{ type: "text", text: system }]
        : system === undefined
          ? []
          : objects(system).map(normalizeBlock),
    tools: payload["tools"] === undefined ? [] : objects(payload["tools"]).map(withoutCache),
  };
}

export function requestBoundary(payload: JsonObject, anchor: string): JsonObject {
  const messages = objects(payload["messages"]);
  return {
    version: 1,
    anchor,
    model: payload["model"] ?? null,
    count: messages.length,
    hash: messageHash(messages),
    templateHash: fingerprint(bindingTemplate(payload)),
  };
}

export function isEffortMessage(message: JsonObject | undefined): boolean {
  return (
    message !== undefined &&
    message["role"] === "system" &&
    Array.isArray(message["content"]) &&
    message["content"].length === 0 &&
    Object.keys(message).every((key) => ["role", "content", "output_config"].includes(key)) &&
    isObject(message["output_config"]) &&
    Object.keys(message["output_config"]).length === 1 &&
    typeof object(message["output_config"])["effort"] === "string"
  );
}

/** The serializer's final effort instruction belongs to the next response, not history. */
export function historyMessages(payload: JsonObject, managedEffort: boolean): JsonObject[] {
  const messages = objects(payload["messages"]);
  return managedEffort && isEffortMessage(messages.at(-1)) ? messages.slice(0, -1) : messages;
}

export function selectTail(
  branch: readonly SessionEntry[],
  leaf: string | null,
  payload: JsonObject,
  keepRecentTokens: number,
  managedEffort: boolean,
) {
  const entries = buildContextEntries([...branch], leaf);
  const messages = historyMessages(payload, managedEffort);
  const template = bindingTemplate(payload);
  const templateHash = fingerprint(template);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== REQUEST_TYPE) continue;
    const data = object(entry.data);
    const count = data["count"];
    if (
      data["version"] !== 1 ||
      data["model"] !== payload["model"] ||
      data["templateHash"] !== templateHash ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count >= messages.length
    )
      continue;
    const anchorIndex = entries.findIndex((candidate) => candidate.id === data["anchor"]);
    if (anchorIndex < 0 || anchorIndex >= index) continue;
    const keptEntries = entries
      .slice(anchorIndex + 1)
      .filter((candidate) => sessionEntryToContextMessages(candidate).length > 0);
    const first = keptEntries[0];
    if (first?.type !== "message" || first.message.role !== "assistant") continue;
    if (first.message.stopReason !== "stop" && first.message.stopReason !== "toolUse") continue;
    const tokens = keptEntries.reduce(
      (total, candidate) =>
        total +
        sessionEntryToContextMessages(candidate).reduce((sum, msg) => sum + estimateTokens(msg), 0),
      0,
    );
    if (tokens < keepRecentTokens) continue;
    const prefix = messages.slice(0, count);
    const tail = messages.slice(count);
    if (messageHash(prefix) !== data["hash"]) continue;
    if (tail[0]?.["role"] !== "assistant" || prefix.at(-1)?.["role"] === "assistant") continue;
    return { prefix, tail, firstKeptEntryId: first.id, keptEntries, template, tokens };
  }
  throw new Error(
    "No recorded safe boundary satisfies native tail retention. History was preserved. Run more Anthropic turns or lower Native tail tokens.",
  );
}

export function retainedHistory(value: unknown): RetainedHistory {
  const data = object(value);
  const messages = objects(data["messages"]);
  if (messages.length === 0) throw new Error("Native retained history is empty.");
  const template = object(data["template"]);
  const leading = data["leading"] === undefined ? undefined : object(data["leading"]);
  if (leading && !isEffortMessage(leading)) throw new Error("Invalid retained-history boundary.");
  return { messages, template, ...(leading ? { leading } : {}) };
}

/** Verify Pi can reconstruct this suffix before accepting a billed summary. */
export function prepareRetained(
  tail: JsonObject[],
  tailPayload: JsonObject,
  template: JsonObject,
  lastSummarized: JsonObject | undefined,
  managedEffort: boolean,
): RetainedHistory {
  if (fingerprint(bindingTemplate(tailPayload)) !== fingerprint(template)) {
    throw new Error("System or tools change when retaining the tail. History was preserved.");
  }
  const serialized = historyMessages(tailPayload, managedEffort);
  if (messageHash(serialized) === messageHash(tail)) return { template, messages: tail };
  if (
    managedEffort &&
    isEffortMessage(lastSummarized) &&
    lastSummarized &&
    messageHash(serialized) === messageHash([lastSummarized, ...tail])
  ) {
    return { template, messages: tail, leading: lastSummarized };
  }
  throw new Error("Pi cannot reconstruct the native tail unchanged. History was preserved.");
}

export function replayRetained(payload: JsonObject, retained: RetainedHistory): JsonObject {
  if (fingerprint(bindingTemplate(payload)) !== fingerprint(retained.template)) {
    throw new Error("Native retained history requires unchanged model, system, and tools.");
  }
  const messages = objects(payload["messages"]);
  const expected = retained.leading ? [retained.leading, ...retained.messages] : retained.messages;
  if (messageHash(messages.slice(0, expected.length)) !== messageHash(expected)) {
    throw new Error("Native retained history changed. Replay was cancelled.");
  }
  // The redundant effort marker was already inside the signed prefix.
  return {
    ...payload,
    messages: [...retained.messages, ...messages.slice(expected.length)],
  };
}
