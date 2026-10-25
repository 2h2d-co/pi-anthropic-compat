import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACTION_BETA,
  CHECKPOINT_TYPE,
  checkpoint,
  eligibleModel,
  parseSummary,
  referencedTools,
  replay,
  summaryPayload,
  toolDefinitions,
} from "../extensions/anthropic-compat/protocol.ts";
import { object, objects } from "../extensions/anthropic-compat/json.ts";
import {
  AnthropicRequestError,
  MAX_RETRIES,
  MAX_SERVER_DELAY_MS,
  STRICT_TOOL_LIMIT_MESSAGES,
  StrictToolLimitError,
  compactRequest,
  supportsCompaction,
  type RetryNotice,
} from "../extensions/anthropic-compat/client.ts";
import { block, model, summaryResponse } from "./support/fixtures.ts";
import { requireCompletedTools } from "../extensions/anthropic-compat/runtime.ts";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

test("only documented direct Anthropic models are eligible", () => {
  assert.equal(eligibleModel(model), true);
  assert.equal(eligibleModel({ ...model, id: "claude-opus-5-5" }), true);
  assert.equal(eligibleModel({ ...model, id: "claude-opus-5-5-preview" }), false);
  assert.equal(eligibleModel({ ...model, id: "claude-sonnet-5-5" }), true);
  assert.equal(eligibleModel({ ...model, id: "claude-sonnet-5-5-preview" }), false);
  assert.equal(
    eligibleModel({ ...model, id: "claude-opus-5-5", baseUrl: "https://proxy.invalid" }),
    false,
  );
  assert.equal(eligibleModel({ ...model, id: "claude-opus-5-5", provider: "openrouter" }), false);
  assert.equal(eligibleModel({ ...model, id: "claude-haiku-4-5" }), false);
  assert.equal(eligibleModel({ ...model, id: "claude-haiku-5-5" }), true);
  assert.equal(eligibleModel({ ...model, id: "claude-haiku-5-5-preview" }), false);
  assert.equal(eligibleModel({ ...model, id: "claude-haiku-5-5", provider: "openrouter" }), false);
  assert.equal(
    eligibleModel({ ...model, id: "claude-haiku-5-5", baseUrl: "https://proxy.invalid" }),
    false,
  );
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

test("replay declares tools the block's tool changes name and Pi no longer declares", () => {
  const removal = { type: "tool_removal", tool: { type: "tool_reference", name: "retired" } };
  const changed = {
    ...block,
    tool_changes: [
      removal,
      { type: "tool_addition", tool: { type: "tool_reference", name: "Read" } },
      {
        type: "tool_addition",
        tool: { type: "tool_definition", definition: { name: "inline", input_schema: {} } },
      },
    ],
  };
  assert.deepEqual(referencedTools(changed), ["retired", "Read"]);
  assert.deepEqual(referencedTools(block), []);
  const retired = {
    name: "retired",
    description: "Withdrawn tool.",
    input_schema: { type: "object" },
    cache_control: { type: "ephemeral" },
  };
  const saved = checkpoint({
    type: CHECKPOINT_TYPE,
    version: 1,
    model: model.id,
    block: changed,
    tools: [retired],
  });
  assert.ok(saved);
  const tools = [{ name: "Read", input_schema: {}, cache_control: { type: "ephemeral" } }];
  const result = replay({ tools, messages: [{ role: "user", content: "Continue" }] }, saved);
  // Pi's own tools and cache marker stay; the restated tool carries no cache marker.
  assert.deepEqual(result["tools"], [
    ...tools,
    { name: "retired", description: "Withdrawn tool.", input_schema: { type: "object" } },
  ]);
  assert.deepEqual(objects(result["messages"])[0], { role: "assistant", content: [changed] });
  // A request that already declares the tool is unchanged.
  const declared = replay({ tools: [...tools, retired], messages: [] }, saved);
  assert.deepEqual(declared["tools"], [...tools, retired]);
  // Without a recorded definition, replay stops before transmission.
  const unrecorded = checkpoint({
    type: CHECKPOINT_TYPE,
    version: 1,
    model: model.id,
    block: changed,
  });
  assert.ok(unrecorded);
  assert.throws(() => replay({ tools, messages: [] }, unrecorded), /retired, whose definition/);
});

test("tool definitions come from the request tools and inline definitions", () => {
  const payload = {
    tools: [{ name: "first", input_schema: {} }, { name: "other" }],
    messages: [
      {
        role: "system",
        content: [
          {
            type: "tool_addition",
            tool: { type: "tool_definition", definition: { name: "added", input_schema: {} } },
          },
          { type: "tool_removal", tool: { type: "tool_reference", name: "first" } },
        ],
      },
    ],
  };
  assert.deepEqual(toolDefinitions(payload, ["added", "first", "missing"]), [
    { name: "added", input_schema: {} },
    { name: "first", input_schema: {} },
  ]);
  assert.deepEqual(toolDefinitions(payload, []), []);
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

test("summary requests mark the last cacheable block when no message carries a breakpoint", () => {
  const marker = { type: "ephemeral", ttl: "1h" };
  const reply = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "fixture" },
      { type: "text", text: "Recorded." },
    ],
  };
  const effort = { role: "system", content: [], output_config: { effort: "low" } };
  const payload = summaryPayload(
    {
      system: [{ type: "text", text: "System", cache_control: marker }],
      tools: [{ name: "read", cache_control: marker }],
      messages: [{ role: "user", content: [{ type: "text", text: "Prompt" }] }, reply, effort],
    },
    4096,
  );
  // The effort marker has no block, and thinking cannot carry a breakpoint, so the text does.
  assert.deepEqual(objects(payload["messages"])[1], {
    ...reply,
    content: [reply.content[0], { ...reply.content[1], cache_control: marker }],
  });
  assert.deepEqual(objects(payload["messages"])[2], effort);
});

test("summary requests keep Pi's message breakpoint, the breakpoint limit, and disabled caching", () => {
  const marker = { type: "ephemeral" };
  const reply = { role: "assistant", content: [{ type: "text", text: "Recorded." }] };
  const marked = {
    system: [{ type: "text", text: "System", cache_control: marker }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Prompt", cache_control: marker }] },
      reply,
    ],
  };
  assert.deepEqual(summaryPayload(marked, 4096)["messages"], marked.messages);
  const full = {
    system: [1, 2, 3].map((index) => ({ type: "text", text: `S${index}`, cache_control: marker })),
    tools: [{ name: "read", cache_control: marker }],
    messages: [reply],
  };
  assert.deepEqual(summaryPayload(full, 4096)["messages"], [reply]);
  const uncached = { system: [{ type: "text", text: "System" }], messages: [reply] };
  assert.deepEqual(summaryPayload(uncached, 4096)["messages"], [reply]);
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
      { baseDelayMs: 1 },
    ),
    { message: "Anthropic request failed (HTTP 529). History was preserved." },
  );
});

const unavailable = () =>
  Response.json(
    {
      type: "error",
      error: {
        type: "overloaded_error",
        message: "private provider text",
        details: { error_code: "compaction_unavailable" },
      },
    },
    { status: 529 },
  );

function summaryCall(fetcher: typeof fetch, options: Parameters<typeof compactRequest>[5]) {
  return compactRequest(
    new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    4096,
    new AbortController().signal,
    undefined,
    fetcher,
    options,
  );
}

test("transient compaction failures are retried with backoff and announced", async () => {
  const bodies: string[] = [];
  const notices: RetryNotice[] = [];
  let calls = 0;
  const result = await summaryCall(
    async (input, init) => {
      bodies.push(await new Request(input, init).text());
      calls++;
      return calls < 3 ? unavailable() : Response.json(summaryResponse());
    },
    { baseDelayMs: 1, onRetry: (notice) => notices.push(notice) },
  );
  assert.equal(result["stop_reason"], "compaction");
  assert.equal(calls, 3);
  // Every attempt sends the identical summary request.
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(notices, [
    {
      attempt: 1,
      maxRetries: MAX_RETRIES,
      delayMs: 1,
      reason: "HTTP 529 overloaded_error, compaction_unavailable",
    },
    {
      attempt: 2,
      maxRetries: MAX_RETRIES,
      delayMs: 2,
      reason: "HTTP 529 overloaded_error, compaction_unavailable",
    },
  ]);
});

test("compaction retries stop at Pi's default budget and name only the error identifiers", async () => {
  let calls = 0;
  await assert.rejects(
    summaryCall(
      () => {
        calls++;
        return Promise.resolve(unavailable());
      },
      { baseDelayMs: 1 },
    ),
    (error) => {
      assert.ok(error instanceof AnthropicRequestError);
      assert.equal(
        error.message,
        "Anthropic request failed (HTTP 529 overloaded_error, compaction_unavailable). History was preserved.",
      );
      return true;
    },
  );
  assert.equal(calls, 1 + MAX_RETRIES);
  // Values that are not plain identifiers may carry provider text and are left out.
  await assert.rejects(
    summaryCall(
      () =>
        Promise.resolve(
          Response.json(
            { error: { type: "Overloaded: private text", details: { error_code: "a b" } } },
            { status: 500 },
          ),
        ),
      { baseDelayMs: 1 },
    ),
    { message: "Anthropic request failed (HTTP 500). History was preserved." },
  );
});

test("compaction retries follow retry-after within Pi's limit and only for HTTP 529", async () => {
  const notices: RetryNotice[] = [];
  let calls = 0;
  await summaryCall(
    () => {
      calls++;
      if (calls > 1) return Promise.resolve(Response.json(summaryResponse()));
      const response = unavailable();
      response.headers.set("retry-after", "0");
      return Promise.resolve(response);
    },
    { baseDelayMs: 50000, onRetry: (notice) => notices.push(notice) },
  );
  assert.equal(notices[0]?.delayMs, 0);
  for (const [status, retryAfter] of [
    [529, String(MAX_SERVER_DELAY_MS / 1000 + 1)],
    [500, null],
    [429, null],
  ] as const) {
    let attempts = 0;
    await assert.rejects(
      summaryCall(
        () => {
          attempts++;
          return Promise.resolve(
            new Response("{}", {
              status,
              headers: retryAfter === null ? {} : { "retry-after": retryAfter },
            }),
          );
        },
        { baseDelayMs: 1 },
      ),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(attempts, 1, `HTTP ${status} must not be retried`);
  }
});

test("aborting compaction cancels a pending retry", async () => {
  const controller = new AbortController();
  const pending = compactRequest(
    new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    4096,
    controller.signal,
    undefined,
    () => Promise.resolve(unavailable()),
    { baseDelayMs: 60000, onRetry: () => controller.abort() },
  );
  await assert.rejects(pending, { name: "AbortError" });
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
  // Pi never sends errored or aborted responses, so their tool calls never get a result.
  const later: AssistantMessage = {
    ...call,
    content: [{ type: "toolCall", id: "later-call", name: "read", arguments: {} }],
  };
  for (const stopReason of ["aborted", "error"] as const) {
    assert.doesNotThrow(() => requireCompletedTools([{ ...call, stopReason }]));
    assert.throws(() => requireCompletedTools([{ ...call, stopReason }, later]), /pending tool/);
  }
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

test("strict tool limit rejections are recognized without exposing the provider message", async () => {
  const send = (status: number, body: string) =>
    compactRequest(
      new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
      4096,
      new AbortController().signal,
      undefined,
      () => Promise.resolve(new Response(body, { status })),
    );
  const rejection = (type: string, message: string) =>
    JSON.stringify({ type: "error", error: { type, message: `${message} private detail` } });
  for (const limit of STRICT_TOOL_LIMIT_MESSAGES) {
    await assert.rejects(send(400, rejection("invalid_request_error", limit)), (error) => {
      assert.ok(error instanceof StrictToolLimitError);
      assert.equal(
        error.message,
        "Anthropic rejected the strict tool set (HTTP 400). History was preserved.",
      );
      return true;
    });
  }
  for (const [status, body, detail] of [
    [400, rejection("invalid_request_error", "prompt is too long"), " invalid_request_error"],
    [400, rejection("api_error", STRICT_TOOL_LIMIT_MESSAGES[1]), " api_error"],
    [400, "private non-JSON body", ""],
    [
      413,
      rejection("invalid_request_error", STRICT_TOOL_LIMIT_MESSAGES[0]),
      " invalid_request_error",
    ],
  ] as const) {
    await assert.rejects(send(status, body), (error) => {
      assert.ok(error instanceof Error && !(error instanceof StrictToolLimitError));
      assert.equal(
        error.message,
        `Anthropic request failed (HTTP ${status}${detail}). History was preserved.`,
      );
      return true;
    });
  }
});
