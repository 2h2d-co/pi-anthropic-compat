import type { Message } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Marks a branch whose Anthropic requests lead with the system prompt although the transcript
 * starts with user messages. Later requests and summaries keep that order.
 */
export const PROMPT_FIRST_TYPE = "pi-anthropic-compat-prompt-first";

export function promptFirstRecorded(branch: readonly SessionEntry[]): boolean {
  return branch.some((entry) => entry.type === "custom" && entry.customType === PROMPT_FIRST_TYPE);
}

/** Pi sends every assistant response except failed and interrupted ones. */
function sentResponse(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}

/**
 * The transcript with its first system message moved ahead of the user messages before it, or
 * `undefined` when nothing moves.
 *
 * Pi writes the system message that declares the prompt and the initial tools when the first
 * agent run starts. A shell command run before the first prompt is already in the transcript,
 * so it comes first. Pi's Anthropic serializer then finds no leading prompt: it sends the prompt
 * as a mid-conversation system message and the current tool list in `tools` on every request. A
 * later tool change rewrites `tools`, which invalidates the whole prompt cache and the signed
 * thinking bound to it. With the prompt first, Pi keeps `tools` fixed and defines later tools
 * inline.
 *
 * Responses bind their thinking to the order they were answered in. A transcript with a sent
 * response moves its prompt only when `recorded` says its earlier requests already did.
 */
export function promptFirst(
  messages: readonly Message[],
  recorded: boolean,
): Message[] | undefined {
  const index = messages.findIndex((message) => message.role === "system");
  const prompt = messages[index];
  if (index <= 0 || !prompt) return undefined;
  const leading = messages.slice(0, index);
  if (leading.some((message) => message.role !== "user")) return undefined;
  if (!recorded && messages.some(sentResponse)) return undefined;
  return [prompt, ...leading, ...messages.slice(index + 1)];
}
