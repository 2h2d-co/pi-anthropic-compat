import type { TestContext } from "node:test";

const CATEGORIES = [
  "max_tokens",
  "thinking",
  "tool",
  "OAuth",
  "authentication",
  "rate limit",
  "credit",
  "overloaded",
  "context",
  "model",
  "beta",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Describe a failed assistant response by stop reason, HTTP status, and error categories only.
 * Provider error text can echo prompts or credentials, so it is never printed.
 */
export function describeFailure(message: unknown): string {
  const record = isRecord(message) ? message : {};
  const error = typeof record["errorMessage"] === "string" ? record["errorMessage"] : "";
  return JSON.stringify({
    stopReason: record["stopReason"],
    httpStatus: error.match(/\b[45]\d\d\b/)?.[0],
    categories: CATEGORIES.filter((category) =>
      error.toLowerCase().includes(category.toLowerCase()),
    ),
  });
}

/**
 * Report every error a live test meets as a test diagnostic, whether or not the test fails, so a
 * one-off failure keeps its cause. Extension notices and extension errors are printed as they are:
 * the extensions never put provider bodies in them. Failed responses are summarized.
 */
export function errorLog(t: TestContext) {
  const log = {
    notice: (message: string, level: string | undefined): void => {
      if (level === "error" || level === "warning") {
        t.diagnostic(`Extension ${level}: ${message}`);
      }
    },
    extensionError: (event: string, error: string): void => {
      t.diagnostic(`Extension error in ${event}: ${error}`);
    },
    response: (message: unknown): void => {
      if (!isRecord(message) || message["role"] !== "assistant") return;
      if (["error", "aborted", "length"].includes(String(message["stopReason"]))) {
        t.diagnostic(`Failed response: ${describeFailure(message)}`);
      }
    },
    /** Read notices, extension errors, and responses from a Pi RPC client's event stream. */
    rpcEvent: (event: unknown): void => {
      if (!isRecord(event)) return;
      if (
        event["type"] === "extension_ui_request" &&
        event["method"] === "notify" &&
        typeof event["message"] === "string"
      ) {
        log.notice(
          event["message"],
          typeof event["notifyType"] === "string" ? event["notifyType"] : "info",
        );
      } else if (event["type"] === "extension_error") {
        log.extensionError(String(event["event"]), String(event["error"]));
      } else if (event["type"] === "message_end") {
        log.response(event["message"]);
      }
    },
  };
  return log;
}
