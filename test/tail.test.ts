import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  messageHash,
  prepareRetained,
  replayRetained,
  bindingTemplate,
  fingerprint,
} from "../extensions/anthropic-compat/tail.ts";
import {
  enforceThinking,
  summaryPayload,
  THINKING_BINDING_BETA,
} from "../extensions/anthropic-compat/protocol.ts";
import { object } from "../extensions/anthropic-compat/json.ts";

test("request fingerprints use locale-independent key ordering", () => {
  const expected = createHash("sha256").update('{"Z":3,"z":1,"ä":2}').digest("hex");
  assert.equal(fingerprint({ z: 1, ä: 2, Z: 3 }), expected);
});

test("history matching ignores cache placement and JSON key order, but not tool arguments or thinking", () => {
  assert.equal(
    messageHash([{ role: "user", content: "hello" }]),
    messageHash([
      {
        content: [{ cache_control: { type: "ephemeral" }, text: "hello", type: "text" }],
        role: "user",
      },
    ]),
  );
  const tool = (value: string) => [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "one", input: { cache_control: value } }],
    },
  ];
  assert.notEqual(messageHash(tool("first")), messageHash(tool("changed")));
  assert.notEqual(
    messageHash([
      { role: "assistant", content: [{ type: "thinking", signature: "original", thinking: "" }] },
    ]),
    messageHash([
      { role: "assistant", content: [{ type: "thinking", signature: "changed", thinking: "" }] },
    ]),
  );
});

test("retained replay rejects changed content, missing thinking, system, tools, and model", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "fixture" },
      { type: "text", text: "exact" },
    ],
  };
  const payload = { model: "fixture", system: "fixed", tools: [], messages: [message] };
  const saved = prepareRetained([message], payload, bindingTemplate(payload), undefined, false);
  assert.deepEqual(replayRetained(payload, saved), payload);
  for (const changed of [
    { ...payload, messages: [{ role: "assistant", content: [{ type: "text", text: "exact" }] }] },
    { ...payload, messages: [{ role: "assistant", content: "changed" }] },
    { ...payload, system: "different" },
    { ...payload, tools: [{ name: "new" }] },
    { ...payload, model: "different" },
  ])
    assert.throws(() => replayRetained(changed, saved), /changed|unchanged/);
  assert.throws(
    () =>
      prepareRetained(
        [message],
        { ...payload, messages: [] },
        bindingTemplate(payload),
        undefined,
        false,
      ),
    /cannot reconstruct/,
  );
});

test("native summary preserves adaptive low effort and strict thinking without structured output", () => {
  const input = {
    messages: [],
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: "low", format: { type: "json_schema" } },
  };
  const enforced = enforceThinking(input);
  assert.deepEqual(enforced["betas"], [THINKING_BINDING_BETA]);
  const summary = summaryPayload(enforced, 4096);
  assert.deepEqual(summary["output_config"], { effort: "low" });
  assert.equal(
    object(object(summary["thinking"])["block_binding"])["prefix_mismatch_behavior"],
    "error",
  );
});
