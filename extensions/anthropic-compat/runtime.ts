import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Api, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { compactRequest, supportsCompaction } from "./client.ts";
import { loadConfig, type Config } from "./config.ts";
import { object, type JsonObject } from "./json.ts";
import {
  BOUNDARY_TYPE,
  CHECKPOINT_TYPE,
  TEMPLATE_TYPE,
  checkpoint,
  eligibleModel,
  parseSummary,
  replay,
  template,
} from "./protocol.ts";
import { registerSettings } from "./settings.ts";

function anthropicModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

export function requireCompletedTools(messages: readonly Message[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const item of message.content) {
        if (item.type === "toolCall") pending.add(item.id);
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  if (pending.size > 0) throw new Error("Resolve pending tool calls before native compaction.");
}

export function activeCheckpoint(entries: readonly SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "compaction") return checkpoint(entry.details);
  }
  return undefined;
}

export function activeTemplate(
  entries: readonly SessionEntry[],
  model: string,
): JsonObject | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== TEMPLATE_TYPE) continue;
    const data = object(entry.data);
    if (data["model"] === model) return data;
  }
  return undefined;
}

export function registerCompatibility(pi: ExtensionAPI, fetcher = fetch): void {
  let context: ExtensionContext | undefined;
  let config: Config | undefined;
  let transform: SimpleStreamOptions["onPayload"];
  let transformModel: string | undefined;

  const configuration = (ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Config => {
    config ??= loadConfig(ctx.cwd, ctx.isProjectTrusted()).config;
    return config;
  };
  const reset = () => {
    context = undefined;
    config = undefined;
    transform = undefined;
    transformModel = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    reset();
    context = ctx;
  });
  pi.on("session_shutdown", reset);
  pi.on("session_tree", (_event, ctx) => {
    reset();
    context = ctx;
  });
  pi.on("model_select", (_event, ctx) => {
    context = ctx;
    transform = undefined;
    transformModel = undefined;
  });
  pi.on("context", (event, ctx) => {
    context = ctx;
    if (!eligibleModel(ctx.model) || !activeCheckpoint(ctx.sessionManager.getBranch())) return;
    return { messages: event.messages.filter((message) => message.role !== "compactionSummary") };
  });

  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: (model, messages, options) => {
      if (!anthropicModel(model)) throw new Error("Expected Anthropic Messages API.");
      return streamSimple(model, messages, {
        ...options,
        onPayload: async (payload, selected) => {
          const updated = await options?.onPayload?.(payload, selected);
          const transformed = object(updated === undefined ? payload : updated);
          const ctx = context;
          if (!ctx || !eligibleModel(model)) return transformed;
          // One-off summaries and other extensions' nested calls are not agent turns.
          if (options?.sessionId !== ctx.sessionManager.getSessionId()) return transformed;
          transform = options?.onPayload;
          transformModel = model.id;
          const branch = ctx.sessionManager.getBranch();
          const nextTemplate = template(transformed);
          if (JSON.stringify(activeTemplate(branch, model.id)) !== JSON.stringify(nextTemplate)) {
            pi.appendEntry(TEMPLATE_TYPE, nextTemplate);
          }
          return replay(transformed, activeCheckpoint(branch));
        },
      });
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    context = ctx;
    if (!eligibleModel(ctx.model)) return;
    try {
      if (!configuration(ctx).enabled) return;
      const model = ctx.model;
      const leaf = ctx.sessionManager.getLeafId();
      const session = ctx.sessionManager.getSessionId();
      const branch = ctx.sessionManager.getBranch();
      const saved = activeCheckpoint(branch);
      const savedTemplate = activeTemplate(branch, model.id);
      const currentTransform = transformModel === model.id ? transform : undefined;
      if (!savedTemplate) {
        throw new Error(
          "Run an Anthropic turn before compacting so final system instructions and tools can be captured.",
        );
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error("Anthropic authentication is unavailable.");
      const requestModel = { ...model, baseUrl: auth.baseUrl ?? model.baseUrl };
      if (!eligibleModel(requestModel))
        throw new Error("Native compaction requires the direct Claude API.");
      const signal = AbortSignal.any([
        event.signal,
        AbortSignal.timeout(configuration(ctx).timeoutSeconds * 1000),
      ]);
      signal.throwIfAborted();
      const active = buildSessionContext(branch, leaf).messages;
      const messages = convertToLlm(
        saved ? active.filter((message) => message.role !== "compactionSummary") : active,
      );
      requireCompletedTools(messages);
      const tools = pi.getAllTools().filter((tool) => pi.getActiveTools().includes(tool.name));
      let prepared: Request | undefined;
      // Reuse Pi's exact serializer and auth construction without making a model call.
      await streamSimple(
        requestModel,
        {
          systemPrompt: ctx.getSystemPrompt(),
          messages,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
        {
          ...auth,
          signal,
          maxRetries: 0,
          maxTokens: Math.min(configuration(ctx).maxSummaryTokens, model.maxTokens),
          onPayload: async (payload, selected) => {
            const updated = await currentTransform?.(payload, selected);
            const result = object(updated === undefined ? payload : updated);
            if (!currentTransform) {
              for (const key of ["system", "tools"] as const) {
                if (savedTemplate[key] === undefined) delete result[key];
                else result[key] = savedTemplate[key];
              }
            }
            return replay(result, saved);
          },
          fetch: (input, init) => {
            prepared = new Request(input, init);
            return Promise.reject(
              new Error("Native compaction request prepared without transmission."),
            );
          },
        },
      ).result();
      signal.throwIfAborted();
      if (!prepared) throw new Error("Could not serialize the Anthropic compaction request.");
      if (object(await prepared.clone().json())["model"] !== model.id) {
        throw new Error("A provider transform changed the summary model. History was preserved.");
      }
      if (!(await supportsCompaction(prepared, model.id, signal, fetcher))) {
        ctx.ui.notify(
          "This model does not support native compaction. Pi compaction remains available.",
          "warning",
        );
        return;
      }
      const raw = await compactRequest(
        prepared,
        Math.min(configuration(ctx).maxSummaryTokens, model.maxTokens),
        signal,
        event.customInstructions,
        fetcher,
      );
      const result = parseSummary(raw, model);
      signal.throwIfAborted();
      if (
        ctx.sessionManager.getSessionId() !== session ||
        ctx.sessionManager.getLeafId() !== leaf ||
        ctx.model?.id !== model.id
      ) {
        throw new Error("The session changed during compaction. The summary was not applied.");
      }
      // This non-message entry is a valid empty retained-tail boundary. Full history
      // stays in Pi's append-only tree, but no summarized turn is sent twice.
      pi.appendEntry(BOUNDARY_TYPE, { version: 1 });
      const boundary = ctx.sessionManager.getLeafId();
      if (!boundary) throw new Error("Could not record the compaction boundary.");
      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: boundary,
          tokensBefore: event.preparation.tokensBefore,
          usage: result.usage,
          details: {
            type: CHECKPOINT_TYPE,
            version: 1,
            model: model.id,
            block: result.block,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Native compaction failed.";
      // No automatic switch to a text-summary algorithm after a native failure.
      ctx.ui.notify(message, "error");
      return { cancel: true };
    }
  });

  registerSettings(pi, {
    get: configuration,
    set: (next) => {
      config = next;
    },
  });
}
