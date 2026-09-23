import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACTION_BETA,
  CHECKPOINT_TYPE,
  checkpoint,
  eligibleModel,
  parseSummary,
  replay,
  summaryPayload,
} from "../extensions/anthropic-compat/protocol.ts";
import { object, objects } from "../extensions/anthropic-compat/json.ts";
import { compactRequest, supportsCompaction } from "../extensions/anthropic-compat/client.ts";
import { block, model, summaryResponse } from "./fixtures.ts";
import { requireCompletedTools } from "../extensions/anthropic-compat/runtime.ts";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

test("only documented direct Anthropic models are eligible", () => {
  assert.equal(eligibleModel(model), true);
  assert.equal(eligibleModel({ ...model, id: "claude-opus-5-5" }), true);
  assert.equal(eligibleModel({ ...model, id: "claude-opus-5-5-preview" }), false);
  assert.equal(
    eligibleModel({ ...model, id: "claude-opus-5-5", baseUrl: "https://proxy.invalid" }),
    false,
  );
  assert.equal(eligibleModel({ ...model, id: "claude-opus-5-5", provider: "openrouter" }), false);
  assert.equal(eligibleModel({ ...model, id: "claude-haiku-4-5" }), false);
  assert.equal(eligibleModel({ ...model, baseUrl: "https://proxy.invalid" }), false);
  assert.equal(eligibleModel({ ...model, provider: "openrouter" }), false);
  assert.equal(eligibleModel(undefined), false);
});

test("replay preserves all opaque fields and appends rather than replaces beta headers", () => {
  const saved = checkpoint({ type: CHECKPOINT_TYPE, version: 1, model: model.id, block });
  assert.ok(saved);
  const original = {
    messages: [{ role: "user", content: "Continue" }],
    betas: ["oauth-2025-04-20"],
  };
  const result = replay(original, saved);
  assert.deepEqual(result["betas"], ["oauth-2025-04-20", COMPACTION_BETA]);
  assert.deepEqual(objects(result["messages"])[0], { role: "assistant", content: [block] });
  assert.equal(original.messages.length, 1);
  assert.throws(() => replay(result, saved), /Another extension/);
  assert.throws(
    () =>
      replay({ ...original, context_management: { edits: [{ type: "compact_20260112" }] } }, saved),
    /Threshold/,
  );
});

test("malformed native checkpoints fail closed while ordinary Pi checkpoints are ignored", () => {
  assert.equal(checkpoint({ readFiles: [] }), undefined);
  assert.throws(() => checkpoint({ type: CHECKPOINT_TYPE, version: 2 }), /Unsupported/);
  assert.throws(
    () =>
      checkpoint({
        type: CHECKPOINT_TYPE,
        version: 1,
        model: model.id,
        block: { type: "compaction", content: "text" },
      }),
    /signed/,
  );
});

test("summary requests strip incompatible controls and retain native conversation content", () => {
  const original = {
    messages: [{ role: "user", content: "Original" }],
    system: "System",
    tools: [],
    thinking: { type: "enabled", budget_tokens: 32768 },
    output_config: { format: { type: "json_schema" } },
    context_management: {},
    tool_choice: { type: "any" },
    stop_sequences: ["stop"],
    fallbacks: [],
  };
  const payload = summaryPayload(original, 4096, "Preserve filenames.");
  assert.equal(payload["stream"], false);
  assert.equal(payload["max_tokens"], 4096);
  assert.deepEqual(payload["messages"], original.messages);
  for (const key of [
    "thinking",
    "output_config",
    "context_management",
    "tool_choice",
    "stop_sequences",
    "fallbacks",
  ])
    assert.equal(payload[key], undefined);
  const instructions = object(payload["compaction"])["instructions"];
  assert.equal(typeof instructions, "string");
  assert.ok(typeof instructions === "string" && instructions.includes("Preserve filenames"));
  assert.throws(() => summaryPayload(original, 4096, "a".repeat(16001)), /exceed/);
});

test("summary accounting includes compaction iterations exactly once", () => {
  const response = summaryResponse();
  const parsed = parseSummary(response, model);
  assert.equal(parsed.usage.input, 194);
  assert.equal(parsed.usage.output, 98);
  assert.equal(parsed.usage.totalTokens, 322);
  assert.equal(parsed.usage.cacheRead, 10);
  assert.equal(parsed.usage.cacheWrite, 20);
  assert.ok(parsed.usage.cost.total > 0);
  assert.deepEqual(parsed.block, block);
  for (const reason of [
    "max_tokens",
    "refusal",
    "tool_use",
    "end_turn",
    "model_context_window_exceeded",
  ]) {
    assert.throws(
      () => parseSummary({ ...response, stop_reason: reason, content: [] }, model),
      /no summary/,
    );
  }
  assert.throws(
    () => parseSummary({ ...response, content: [{ ...block, content: null }] }, model),
    /nonempty/,
  );
  assert.throws(() => parseSummary({ ...response, model: "different" }, model), /unexpected/);
  assert.throws(() => parseSummary({ ...response, usage: {} }, model), /JSON array/);
});

test("native HTTP calls preserve authentication without exposing response errors", async () => {
  const request = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "test-only", "anthropic-beta": "existing-beta" },
    body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Synthetic" }] }),
  });
  const signal = new AbortController().signal;
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    assert.equal(outgoing.headers.get("x-api-key"), "test-only");
    assert.equal(outgoing.headers.get("anthropic-beta"), `existing-beta,${COMPACTION_BETA}`);
    calls++;
    if (outgoing.method === "GET")
      return Response.json({ capabilities: { compaction: { summarize: { supported: true } } } });
    const payload = object(await outgoing.json());
    assert.deepEqual(object(payload["compaction"])["type"], "summarize");
    assert.equal(payload["betas"], undefined);
    return Response.json(summaryResponse());
  };
  assert.equal(await supportsCompaction(request, model.id, signal, fetcher), true);
  await compactRequest(request, 4096, signal, undefined, fetcher);
  assert.equal(calls, 2);
  await assert.rejects(
    compactRequest(
      new Request(request.url, { method: "POST", body: "{}" }),
      4096,
      signal,
      undefined,
      () => Promise.resolve(new Response("private error body", { status: 529 })),
    ),
    /HTTP 529/,
  );
});

test("unanswered tools cannot be compacted and completed pairs remain valid", () => {
  const call: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    timestamp: 0,
    content: [
      { type: "toolCall", id: "fixture-call", name: "read", arguments: { path: "synthetic.txt" } },
    ],
    usage: parseSummary(summaryResponse(), model).usage,
  };
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "fixture-call",
    toolName: "read",
    content: [{ type: "text", text: "Synthetic result" }],
    isError: false,
    timestamp: 1,
  };
  assert.throws(() => requireCompletedTools([call]), /pending tool/);
  assert.doesNotThrow(() => requireCompletedTools([call, result]));
});

test("malformed successful provider responses never expose raw response bodies", async () => {
  const request = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: "{}",
  });
  await assert.rejects(
    compactRequest(request, 4096, new AbortController().signal, undefined, () =>
      Promise.resolve(new Response("private fixture response", { status: 200 })),
    ),
    { message: "Anthropic returned an invalid JSON response. History was preserved." },
  );
});
