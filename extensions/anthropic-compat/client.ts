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

/** Whether a rejected response reports a strict tool limit. Reads only the error type and message. */
async function strictToolLimit(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  // oxlint-disable-next-line 2h2d/require-promise-rejection-parameter -- A body that is not JSON is not a strict tool limit, and parser errors can expose the body.
  const body: unknown = await response.json().catch(() => undefined);
  const error = isObject(body) ? body["error"] : undefined;
  if (!isObject(error)) return false;
  const message = error["message"];
  return (
    error["type"] === "invalid_request_error" &&
    typeof message === "string" &&
    STRICT_TOOL_LIMIT_MESSAGES.some((limit) => message.includes(limit))
  );
}

async function readResponse(response: Response): Promise<JsonObject> {
  if (!response.ok) {
    // Do not expose provider bodies, which may echo prompts or credentials.
    if (await strictToolLimit(response)) {
      throw new StrictToolLimitError(
        "Anthropic rejected the strict tool set (HTTP 400). History was preserved.",
      );
    }
    if (!response.bodyUsed) await response.body?.cancel();
    throw new Error(`Anthropic request failed (HTTP ${response.status}). History was preserved.`);
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

export async function compactRequest(
  request: Request,
  maxTokens: number,
  signal: AbortSignal,
  instructions?: string,
  fetcher = fetch,
): Promise<JsonObject> {
  const payload = summaryPayload(object(await request.json()), maxTokens, instructions);
  // SDK-only fields have already become HTTP headers at this boundary.
  delete payload["betas"];
  return readResponse(
    await fetcher(request.url, {
      method: "POST",
      headers: betaHeaders(request.headers),
      body: JSON.stringify(payload),
      signal,
      redirect: "error",
    }),
  );
}
