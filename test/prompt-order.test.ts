import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, SystemMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  PROMPT_FIRST_TYPE,
  promptFirst,
  promptFirstRecorded,
} from "../extensions/anthropic-compat/prompt-order.ts";

const prompt: SystemMessage = { role: "system", content: "Synthetic prompt.", timestamp: 2 };
const shell: UserMessage = { role: "user", content: "Synthetic shell output.", timestamp: 1 };
const user: UserMessage = { role: "user", content: "Synthetic prompt text.", timestamp: 3 };

function response(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 4,
  };
}

test("the prompt moves ahead of the shell output recorded before the first run", () => {
  assert.deepEqual(promptFirst([shell, prompt, user], false), [prompt, shell, user]);
});

test("a transcript that starts with its prompt, or has none, stays unchanged", () => {
  assert.equal(promptFirst([prompt, shell, user], false), undefined);
  assert.equal(promptFirst([shell, user], false), undefined);
  assert.equal(promptFirst([], false), undefined);
});

test("earlier responses keep their order unless the branch recorded the move", () => {
  const answered: Message[] = [shell, prompt, user, response("stop")];
  assert.equal(promptFirst(answered, false), undefined);
  assert.deepEqual(promptFirst(answered, true), [prompt, shell, user, response("stop")]);
});

test("failed and interrupted responses were never sent, so the prompt still moves", () => {
  for (const stopReason of ["error", "aborted"] as const) {
    assert.deepEqual(promptFirst([shell, prompt, user, response(stopReason)], false), [
      prompt,
      shell,
      user,
      response(stopReason),
    ]);
  }
});

test("the prompt never moves ahead of a response", () => {
  assert.equal(promptFirst([shell, response("stop"), prompt, user], true), undefined);
});

test("the branch records the move with a custom entry", () => {
  const entry = (customType: string): SessionEntry => ({
    type: "custom",
    customType,
    data: { version: 1 },
    id: customType,
    parentId: null,
    timestamp: "2026-10-25T00:00:00.000Z",
  });
  assert.equal(promptFirstRecorded([entry("other")]), false);
  assert.equal(promptFirstRecorded([entry("other"), entry(PROMPT_FIRST_TYPE)]), true);
});
