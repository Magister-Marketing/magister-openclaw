import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../utils/cjk-chars.js";
import { dropThinkingBlocks } from "../../pi-embedded-runner/thinking.js";
import type { EffectiveContextPruningSettings } from "./settings.js";
import { makeToolPrunablePredicate } from "./tools.js";

const IMAGE_CHAR_ESTIMATE = 8_000;
const PRUNED_CONTEXT_IMAGE_MARKER = "[image removed during context pruning]";

function asText(text: string): TextContent {
  return { type: "text", text };
}

function serializeMalformedTextBlock(block: unknown): string {
  try {
    const serialized = JSON.stringify(block);
    return typeof serialized === "string" ? serialized : "[malformed text block]";
  } catch {
    return "[malformed text block]";
  }
}

function coerceTextBlock(block: unknown): string | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  if ((block as { type?: unknown }).type !== "text") {
    return null;
  }
  const text = (block as { text?: unknown }).text;
  return typeof text === "string" ? text : serializeMalformedTextBlock(block);
}

function isImageBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
  const parts: string[] = [];
  for (const block of content) {
    const text = coerceTextBlock(block);
    if (text !== null) {
      parts.push(text);
    }
  }
  return parts;
}

function collectPrunableToolResultSegments(
  content: ReadonlyArray<TextContent | ImageContent>,
): string[] {
  const parts: string[] = [];
  for (const block of content) {
    const text = coerceTextBlock(block);
    if (text !== null) {
      parts.push(text);
      continue;
    }
    if (isImageBlock(block)) {
      parts.push(PRUNED_CONTEXT_IMAGE_MARKER);
    }
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) {
    return 0;
  }
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  // Joined with "\n" separators between blocks.
  len += Math.max(0, parts.length - 1);
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}

function hasImageBlocks(content: ReadonlyArray<TextContent | ImageContent>): boolean {
  for (const block of content) {
    if (isImageBlock(block)) {
      return true;
    }
  }
  return false;
}

function estimateWeightedTextChars(text: string): number {
  return estimateStringChars(text);
}

function estimateTextAndImageChars(content: ReadonlyArray<TextContent | ImageContent>): number {
  let chars = 0;
  for (const block of content) {
    const text = coerceTextBlock(block);
    if (text !== null) {
      chars += estimateWeightedTextChars(text);
      continue;
    }
    if (isImageBlock(block)) {
      chars += IMAGE_CHAR_ESTIMATE;
    }
  }
  return chars;
}

function estimateMessageChars(message: AgentMessage): number {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return estimateWeightedTextChars(content);
    }
    return estimateTextAndImageChars(content);
  }

  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (!b || typeof b !== "object") {
        continue;
      }
      if (b.type === "text" && typeof b.text === "string") {
        chars += estimateWeightedTextChars(b.text);
      }
      const blockType = (b as { type?: unknown }).type;
      if (blockType === "thinking" || blockType === "redacted_thinking") {
        const thinking = (b as { thinking?: unknown }).thinking;
        if (typeof thinking === "string") {
          chars += estimateWeightedTextChars(thinking);
        }
        const data = (b as { data?: unknown }).data;
        if (blockType === "redacted_thinking" && typeof data === "string") {
          chars += estimateWeightedTextChars(data);
        }
        const signature = (b as { thinkingSignature?: unknown }).thinkingSignature;
        if (typeof signature === "string") {
          chars += estimateWeightedTextChars(signature);
        }
      }
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    return estimateTextAndImageChars(message.content);
  }

  return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}

function findAssistantCutoffIndex(
  messages: AgentMessage[],
  keepLastAssistants: number,
): number | null {
  // keepLastAssistants <= 0 => everything is potentially prunable.
  if (keepLastAssistants <= 0) {
    return messages.length;
  }

  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") {
      continue;
    }
    remaining--;
    if (remaining === 0) {
      return i;
    }
  }

  // Not enough assistant messages to establish a protected tail.
  return null;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return null;
}

function findLastUserIndex(messages: AgentMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return null;
}

function clearToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  const parts = collectTextSegments(msg.content);
  if (
    !hasImageBlocks(msg.content) &&
    parts.length === 1 &&
    parts[0] === settings.hardClear.placeholder
  ) {
    return null;
  }
  return { ...msg, content: [asText(settings.hardClear.placeholder)] };
}

function softTrimToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  const hasImages = hasImageBlocks(msg.content);
  const parts = hasImages
    ? collectPrunableToolResultSegments(msg.content)
    : collectTextSegments(msg.content);
  const rawLen = estimateJoinedTextLength(parts);
  if (rawLen <= settings.softTrim.maxChars) {
    if (!hasImages) {
      return null;
    }
    return { ...msg, content: [asText(parts.join("\n"))] };
  }

  const headChars = Math.max(0, settings.softTrim.headChars);
  const tailChars = Math.max(0, settings.softTrim.tailChars);
  if (headChars + tailChars >= rawLen) {
    if (!hasImages) {
      return null;
    }
    return { ...msg, content: [asText(parts.join("\n"))] };
  }

  const head = takeHeadFromJoinedText(parts, headChars);
  const tail = takeTailFromJoinedText(parts, tailChars);
  const trimmed = `${head}
...
${tail}`;

  const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return { ...msg, content: [asText(trimmed + note)] };
}

export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ctx: Pick<ExtensionContext, "model">;
  isToolPrunable?: (toolName: string) => boolean;
  contextWindowTokensOverride?: number;
  dropThinkingBlocksForEstimate?: boolean;
}): AgentMessage[] {
  const { messages, settings, ctx } = params;
  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return messages;
  }

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (charWindow <= 0) {
    return messages;
  }

  const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoffIndex === null) {
    return messages;
  }

  // Bootstrap safety: never prune anything before the first user message. This protects initial
  // "identity" reads (SOUL.md, USER.md, etc.) which typically happen before the first inbound user
  // message exists in the session transcript.
  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

  const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);
  const estimatedMessages = params.dropThinkingBlocksForEstimate
    ? dropThinkingBlocks(messages)
    : messages;

  const totalCharsBefore = estimateContextChars(estimatedMessages);
  let totalChars = totalCharsBefore;
  let next: AgentMessage[] | null = null;

  const replaceAt = (i: number, updated: ToolResultMessage) => {
    const before = estimateMessageChars((next ?? messages)[i]);
    if (!next) {
      next = messages.slice();
    }
    next[i] = updated as unknown as AgentMessage;
    totalChars += estimateMessageChars(updated as unknown as AgentMessage) - before;
  };

  // Completed turns: a tool result from before the latest user message has already fed the
  // reply that closed its turn, so it is pruned on every request, whatever the ratios say. In a
  // workflow run each step is one user message, so this clears a step's fetched pages the moment
  // the next step starts; the step's own reply stays.
  if (settings.completedTurns !== "keep") {
    const lastUserIndex = findLastUserIndex(messages);
    const completedEnd = lastUserIndex === null ? pruneStartIndex : lastUserIndex;
    for (let i = pruneStartIndex; i < completedEnd; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== "toolResult" || !isToolPrunable(msg.toolName)) {
        continue;
      }
      const current = msg as unknown as ToolResultMessage;
      const updated =
        settings.completedTurns === "clear"
          ? clearToolResultMessage({ msg: current, settings })
          : softTrimToolResultMessage({ msg: current, settings });
      if (updated) {
        replaceAt(i, updated);
      }
    }
  }

  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) {
    return next ?? messages;
  }

  const prunableToolIndexes: number[] = [];

  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    if (!isToolPrunable(msg.toolName)) {
      continue;
    }
    prunableToolIndexes.push(i);

    const updated = softTrimToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
    });
    if (!updated) {
      continue;
    }
    replaceAt(i, updated);
  }

  const outputAfterSoftTrim = next ?? messages;
  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    return outputAfterSoftTrim;
  }
  if (!settings.hardClear.enabled) {
    return outputAfterSoftTrim;
  }

  let prunableToolChars = 0;
  for (const i of prunableToolIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    return outputAfterSoftTrim;
  }

  // In cache-ttl mode the cache has already expired, so clearing one more old result per
  // request costs nothing extra. In always mode the cache is warm, and a prefix that changes
  // near its start on every request re-sends the whole context at the uncached price: measured
  // on a workflow run, the cached share fell from 93% to 48% and the run cost more than with no
  // pruning. So once the threshold is crossed, always mode clears every prunable result before
  // the protected tail; the set only ever grows at its end, and the prefix stays cached.
  const clearEverything = settings.mode === "always";
  for (const i of prunableToolIndexes) {
    if (!clearEverything && ratio < settings.hardClearRatio) {
      break;
    }
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    const cleared = clearToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
    });
    if (!cleared) {
      continue;
    }
    replaceAt(i, cleared);
    ratio = totalChars / charWindow;
  }

  return next ?? messages;
}
