import { setTimeout } from "node:timers/promises";
import { isObject, object, type JsonObject } from "./json.ts";
import { COMPACTION_BETA, summaryPayload } from "./protocol.ts";

export function betaHeaders(original: Headers): Headers {
  const headers = new Headers(original);
  const values = (headers.get("anthropic-beta") ?? "").split(",").filter(Boolean);
  headers.set("anthropic-beta", [...new Set([...values, COMPACTION_BETA])].join(","));
  headers.delete("content-length");
  return headers;
}

/**
 * Error messages Anthropic returns when the strict tool set exceeds its limits. Pi retries a
 * rejected turn once with `strict: "prefer"` tools non-strict when one of them appears.
 */
export const STRICT_TOOL_LIMIT_MESSAGES = [
  "The compiled grammar is too large",
  "Too many strict tools (",
  "Schemas contains too many parameters with union types (",
] as const;

/** Anthropic rejected the request's strict tool set. */
export class StrictToolLimitError extends Error {}

/** Anthropic's error object from a rejected response, or undefined for any other body. */
async function errorObject(response: Response): Promise<Record<string, unknown> | undefined> {
  // oxlint-disable-next-line 2h2d/require-promise-rejection-parameter -- A body that is not JSON has no error object, and parser errors can expose the body.
  const body: unknown = await response.json().catch(() => undefined);
  const error = isObject(body) ? body["error"] : undefined;
  return isObject(error) ? error : undefined;
}

/** Whether a rejected response reports a strict tool limit. Reads only the error type and message. */
function strictToolLimit(status: number, error: Record<string, unknown> | undefined): boolean {
  if (status !== 400 || !error) return false;
  const message = error["message"];
  return (
    error["type"] === "invalid_request_error" &&
    typeof message === "string" &&
    STRICT_TOOL_LIMIT_MESSAGES.some((limit) => message.includes(limit))
  );
}

/** An error identifier such as `overloaded_error`. Anything else may be provider text. */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

/** A rejected Anthropic request. The message names only the status, error type, and error code. */
export class AnthropicRequestError extends Error {
  readonly status: number;
  /** The status, error type, and error code, such as `HTTP 529 overloaded_error, compaction_unavailable`. */
  readonly summary: string;
  /** The server-requested delay before a retry, from `retry-after`. */
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    error: Record<string, unknown> | undefined,
    retryAfter: string | null,
  ) {
    const details = [
      identifier(error?.["type"]),
      identifier(isObject(error?.["details"]) ? error["details"]["error_code"] : undefined),
    ].filter((value) => value !== undefined);
    const summary = `HTTP ${status}${details.length > 0 ? ` ${details.join(", ")}` : ""}`;
    super(`Anthropic request failed (${summary}). History was preserved.`);
    this.status = status;
    this.summary = summary;
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    this.retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }
}

async function readResponse(response: Response): Promise<JsonObject> {
  if (!response.ok) {
    // Do not expose provider bodies, which may echo prompts or credentials.
    const error = await errorObject(response);
    if (strictToolLimit(response.status, error)) {
      throw new StrictToolLimitError(
        "Anthropic rejected the strict tool set (HTTP 400). History was preserved.",
      );
    }
    throw new AnthropicRequestError(response.status, error, response.headers.get("retry-after"));
  }
  try {
    return object(await response.json());
    // oxlint-disable-next-line eslint/preserve-caught-error -- JSON parser errors can expose raw provider response bodies.
  } catch {
    throw new Error("Anthropic returned an invalid JSON response. History was preserved.");
  }
}

export async function supportsCompaction(
  request: Request,
  model: string,
  signal: AbortSignal,
  fetcher = fetch,
): Promise<boolean> {
  const url = new URL(`/v1/models/${encodeURIComponent(model)}`, request.url);
  const response = await fetcher(url, {
    headers: betaHeaders(request.headers),
    signal,
    redirect: "error",
  });
  const data = await readResponse(response);
  const capability = object(object(data["capabilities"])["compaction"]);
  const supported = object(capability["summarize"])["supported"];
  if (typeof supported !== "boolean")
    throw new Error("Anthropic did not report compaction support.");
  return supported;
}

/** A summary request retry, announced before its delay. */
export interface RetryNotice {
  /** The retry about to run, starting at 1. */
  attempt: number;
  maxRetries: number;
  delayMs: number;
  /** The failure that caused the retry. It names only the status, error type, and code. */
  reason: string;
}

export interface RetryOptions {
  onRetry?: (notice: RetryNotice) => void;
  /** The first retry's delay. Each later retry doubles it. */
  baseDelayMs?: number;
}

/**
 * Pi's default compaction retry budget (`retry.maxRetries`, `retry.baseDelayMs`) and its default
 * limit on a server-requested delay (`retry.provider.maxRetryDelayMs`).
 */
export const MAX_RETRIES = 3;
export const BASE_DELAY_MS = 2000;
export const MAX_SERVER_DELAY_MS = 60000;

/**
 * HTTP 529 is Anthropic's transient `overloaded_error`. For compaction it carries the error code
 * `compaction_unavailable`. Anthropic documents both as retryable.
 */
function retryable(error: unknown): error is AnthropicRequestError {
  return error instanceof AnthropicRequestError && error.status === 529;
}

export async function compactRequest(
  request: Request,
  maxTokens: number,
  signal: AbortSignal,
  instructions?: string,
  fetcher = fetch,
  options: RetryOptions = {},
): Promise<JsonObject> {
  const payload = summaryPayload(object(await request.json()), maxTokens, instructions);
  // SDK-only fields have already become HTTP headers at this boundary.
  delete payload["betas"];
  const body = JSON.stringify(payload);
  const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await readResponse(
        await fetcher(request.url, {
          method: "POST",
          headers: betaHeaders(request.headers),
          body,
          signal,
          redirect: "error",
        }),
      );
    } catch (error) {
      if (!retryable(error) || attempt > MAX_RETRIES) throw error;
      const delayMs = error.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1);
      if (delayMs > MAX_SERVER_DELAY_MS) throw error;
      options.onRetry?.({ attempt, maxRetries: MAX_RETRIES, delayMs, reason: error.summary });
      await setTimeout(delayMs, undefined, { signal });
    }
  }
}
