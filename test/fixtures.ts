import type { Model } from "@earendil-works/pi-ai";
import type { JsonObject } from "../extensions/anthropic-compat/json.ts";

export const model: Model<"anthropic-messages"> = {
  id: "claude-sonnet-5",
  name: "Sonnet test fixture",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  contextWindow: 200000,
  maxTokens: 64000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

export const block: JsonObject = {
  type: "compaction",
  content: "The synthetic project is Lantern.",
  signature: "test-signature",
  encrypted_content: "test-opaque-content",
};

export function summaryResponse(modelId = model.id): JsonObject {
  return {
    model: modelId,
    stop_reason: "compaction",
    content: [block],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        {
          type: "compaction",
          input_tokens: 194,
          output_tokens: 98,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 20,
        },
      ],
    },
  };
}

export function textResponse(inputTokens = 100, modelId = model.id, thinking = false): Response {
  const events: JsonObject[] = [
    {
      type: "message_start",
      message: {
        id: "test-response",
        model: modelId,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    },
    ...(thinking
      ? [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "thinking",
              thinking: "",
              signature: "fixture-thinking-signature",
            },
          },
          { type: "content_block_stop", index: 0 },
        ]
      : []),
    {
      type: "content_block_start",
      index: thinking ? 1 : 0,
      content_block: { type: "text", text: "Recorded the synthetic project." },
    },
    { type: "content_block_stop", index: thinking ? 1 : 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: inputTokens, output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events
      .map((event) => {
        const type = event["type"];
        if (typeof type !== "string") throw new Error("Invalid event fixture.");
        return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}
