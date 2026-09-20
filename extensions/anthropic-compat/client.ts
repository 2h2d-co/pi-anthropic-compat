import { object, type JsonObject } from "./json.ts";
import { COMPACTION_BETA, summaryPayload } from "./protocol.ts";

export function betaHeaders(original: Headers): Headers {
  const headers = new Headers(original);
  const values = (headers.get("anthropic-beta") ?? "").split(",").filter(Boolean);
  headers.set("anthropic-beta", [...new Set([...values, COMPACTION_BETA])].join(","));
  headers.delete("content-length");
  return headers;
}

async function readResponse(response: Response): Promise<JsonObject> {
  if (!response.ok) {
    // Do not expose provider bodies, which may echo prompts or credentials.
    await response.body?.cancel();
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
