import assert from "node:assert/strict";
import test from "node:test";
import { describeFailure, errorLog } from "./error-log.ts";

test("failed responses are summarized without provider error text", () => {
  const summary = describeFailure({
    role: "assistant",
    stopReason: "error",
    errorMessage: '529 {"type":"overloaded_error","message":"Overloaded","echo":"SECRET-PROMPT"}',
  });
  assert.deepEqual(JSON.parse(summary), {
    stopReason: "error",
    httpStatus: "529",
    categories: ["overloaded"],
  });
  assert.doesNotMatch(summary, /SECRET-PROMPT/);
});

test("the live-test error log reports every error and warning it receives", (t) => {
  const reported: string[] = [];
  t.mock.method(t, "diagnostic", (message: string) => {
    reported.push(message);
  });
  const log = errorLog(t);
  log.notice("Compaction stopped: Anthropic request failed (HTTP 529).", "error");
  log.notice("Summarized the full history.", "warning");
  log.notice("Settings saved.", "info");
  log.rpcEvent({
    type: "extension_ui_request",
    method: "notify",
    message: "Native compaction failed.",
    notifyType: "error",
  });
  log.rpcEvent({ type: "extension_error", event: "session_before_compact", error: "Boom" });
  log.rpcEvent({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "500 SECRET" },
  });
  log.rpcEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  assert.deepEqual(reported, [
    "Extension error: Compaction stopped: Anthropic request failed (HTTP 529).",
    "Extension warning: Summarized the full history.",
    "Extension error: Native compaction failed.",
    "Extension error in session_before_compact: Boom",
    'Failed response: {"stopReason":"error","httpStatus":"500","categories":[]}',
  ]);
});
