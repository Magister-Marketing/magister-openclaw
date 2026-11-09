import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../utils/cjk-chars.js";
import { dropThinkingBlocks } from "../../pi-embedded-runner/thinking.js";
import type { EffectiveContextPruningSettings } from "./settings.js";
import { makeToolPrunablePredicate } from "./tools.js";

const IMAGE_CHAR_ESTIMATE = 8_000;
const PRUNED_CONTEXT_IMAGE_MARKER = "[image removed during context pruning]";
/** A tool-call string argument longer than this is cleared once its turn has closed. */
const CLEARED_ARG_MIN_CHARS = 2_000;

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

/**
 * Whether a message closes its turn with a reply: an assistant message with text that neither
 * failed nor was stopped. A turn that ended any other way (Stop pressed mid-turn, a model error,
 * an approval card with nothing said after it) has no reply holding what its tools found.
 */
function isClosingReply(message: AgentMessage | undefined): boolean {
  if (
    message?.role !== "assistant" ||
    message.stopReason === "aborted" ||
    message.stopReason === "error"
  ) {
    return false;
  }
  return message.content.some(
    (block) => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
  );
}

/**
 * The end of the completed turns: the latest user message whose turn before it closed with a
 * reply, or `start` when none did. A user message that arrives while a turn is still open
 * continues that turn instead: a subagent result steered in after a tool result, an approval
 * decision after a turn that ended on its card, or "give me what you have" after Stop.
 */
function findCompletedTurnsEnd(messages: AgentMessage[], start: number): number {
  let end = start;
  let lastWork: AgentMessage | undefined;
  for (let i = start; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role === "user") {
      if (isClosingReply(lastWork)) {
        end = i;
      }
    } else if (msg?.role === "assistant" || msg?.role === "toolResult") {
      lastWork = msg;
    }
  }
  return end;
}

/** Ids of the `read` calls in messages[start, end) whose path starts with one of the prefixes. */
function readCallIdsUnder(
  messages: AgentMessage[],
  start: number,
  end: number,
  prefixes: readonly string[],
): Set<string> {
  const ids = new Set<string>();
  if (prefixes.length === 0) {
    return ids;
  }
  for (let i = start; i < end; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant") {
      continue;
    }
    for (const block of msg.content) {
      if (block?.type !== "toolCall" || block.name !== "read") {
        continue;
      }
      const path = block.arguments?.path ?? block.arguments?.file_path;
      if (typeof path === "string" && prefixes.some((prefix) => path.startsWith(prefix))) {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

function clearToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
  placeholder?: string;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  const placeholder = params.placeholder ?? settings.hardClear.placeholder;
  const parts = collectTextSegments(msg.content);
  if (!hasImageBlocks(msg.content) && parts.length === 1 && parts[0] === placeholder) {
    return null;
  }
  return { ...msg, content: [asText(placeholder)] };
}

/**
 * The assistant message with the long string arguments of the named tools' calls replaced by a
 * short note, or null when nothing was long. A `write` call carries the whole file as `content`:
 * the call ran and the file is on disk, so the argument is only weight in every later request.
 */
function clearLongToolCallArgs(
  message: AgentMessage,
  toolNames: ReadonlySet<string>,
): AgentMessage | null {
  if (message.role !== "assistant") {
    return null;
  }
  let changed = false;
  const content = message.content.map((block) => {
    if (
      block?.type !== "toolCall" ||
      !toolNames.has(block.name) ||
      !block.arguments ||
      typeof block.arguments !== "object"
    ) {
      return block;
    }
    const original: Record<string, unknown> = block.arguments;
    let args: Record<string, unknown> | null = null;
    for (const [key, value] of Object.entries(original)) {
      if (typeof value !== "string" || value.length <= CLEARED_ARG_MIN_CHARS) {
        continue;
      }
      args ??= { ...original };
      args[key] =
        `[${value.length} characters cleared from context: this call already ran. ` +
        "Read the file it wrote if you need the content.]";
    }
    if (!args) {
      return block;
    }
    changed = true;
    return { ...block, arguments: args };
  });
  return changed ? ({ ...message, content } as AgentMessage) : null;
}

/**
 * The prompt size the provider reported for the request this assistant message answered: system
 * prompt, tools and every message, as it was actually sent. Null for a failed or stopped request
 * and for a provider that reported nothing.
 */
function reportedPromptTokens(message: AgentMessage | undefined): number | null {
  if (
    message?.role !== "assistant" ||
    message.stopReason === "aborted" ||
    message.stopReason === "error"
  ) {
    return null;
  }
  const usage = message.usage;
  if (!usage) {
    return null;
  }
  const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return Number.isFinite(total) && total > 0 ? total : null;
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

/**
 * Where the open turn's batches end, oldest first. `always` mode prunes the turn in progress in
 * batches: a request whose prompt would pass the trigger prunes every result older than the
 * protected tail at once, and that set then stays exactly as it is until the next batch. Between
 * batches the prompt only grows at its end, so a provider's prompt cache keeps hitting; pruning
 * one more result per request instead rewrites a message the provider has already seen on every
 * request, and each rewrite re-bills most of the prompt at the uncached price (measured on a
 * workflow run: 11 such requests were 43% of its cost).
 *
 * Nothing is remembered between requests, so the batches are derived from the transcript: every
 * earlier request of the turn is replayed in order, each judged by the prompt size the provider
 * reported for the request before it plus what was appended since. The transcript only grows, so
 * replaying it always finds the same batches, and the same request is always sent the same way.
 */
function resolveBatchEnds(params: {
  messages: AgentMessage[];
  regionStart: number;
  triggerTokens: number;
  settings: EffectiveContextPruningSettings;
  isEligible: (index: number) => boolean;
  trimmedAt: (index: number) => AgentMessage;
  clearedAt: (index: number) => AgentMessage;
}): number[] {
  const { messages, regionStart, settings } = params;
  const minFreedChars = settings.batch.minFreedTokens * CHARS_PER_TOKEN_ESTIMATE;
  const ends: number[] = [];
  const assistants: number[] = [];

  // `boundary` is the request whose input is messages[0, boundary).
  const consider = (boundary: number) => {
    const previous = assistants.at(-1);
    if (previous === undefined) {
      // The turn's first request: it has fetched nothing of its own yet.
      return;
    }
    const reported = reportedPromptTokens(messages[previous]);
    if (reported === null) {
      return;
    }
    let appendedChars = 0;
    for (let i = previous; i < boundary; i++) {
      appendedChars += estimateMessageChars(messages[i]);
    }
    if (reported + appendedChars / CHARS_PER_TOKEN_ESTIMATE <= params.triggerTokens) {
      return;
    }

    // The batch ends at the keepLastAssistants-th last assistant before this request; undefined
    // while the turn has fewer.
    const keep = settings.keepLastAssistants;
    const end = keep <= 0 ? boundary : assistants.at(-keep);
    const previousEnd = ends.at(-1) ?? regionStart;
    if (end === undefined || end <= previousEnd) {
      return;
    }

    // What this batch frees: its own results are trimmed, and the batch before it, trimmed until
    // now, is cleared.
    let freedChars = 0;
    for (let i = previousEnd; i < end; i++) {
      if (params.isEligible(i)) {
        freedChars += estimateMessageChars(messages[i]) - estimateMessageChars(params.trimmedAt(i));
      }
    }
    if (settings.hardClear.enabled && ends.length > 0) {
      const beforePrevious = ends.length > 1 ? ends[ends.length - 2] : regionStart;
      for (let i = beforePrevious; i < previousEnd; i++) {
        if (params.isEligible(i)) {
          freedChars +=
            estimateMessageChars(params.trimmedAt(i)) - estimateMessageChars(params.clearedAt(i));
        }
      }
    }
    if (freedChars < minFreedChars) {
      // Not worth a full-price request: let the prompt grow until a batch frees enough.
      return;
    }
    ends.push(end);
  };

  for (let i = regionStart; i < messages.length; i++) {
    if (messages[i]?.role === "assistant") {
      consider(i);
      assistants.push(i);
    }
  }
  consider(messages.length);
  return ends;
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

  const replaceAt = (i: number, updated: AgentMessage) => {
    const before = estimateMessageChars((next ?? messages)[i]);
    if (!next) {
      next = messages.slice();
    }
    next[i] = updated;
    totalChars += estimateMessageChars(updated) - before;
  };

  // Completed turns: a tool result from a turn that closed with a reply has already fed that
  // reply, so it is pruned on every request, whatever the ratios say. In a workflow run each step
  // is one user message, so this clears a step's fetched pages the moment the next step starts;
  // the step's own reply stays. A turn that ended without a reply keeps its results until a
  // later turn replies. Reads under completedTurnsKeepReads (skills) stay too: the agent reuses
  // them every turn, and clearing them made it read the same skills again on later chat turns.
  // They stay through the open turn as well, whatever its batches prune.
  const completedEnd =
    settings.completedTurns === "keep"
      ? pruneStartIndex
      : findCompletedTurnsEnd(messages, pruneStartIndex);
  const keptReads = readCallIdsUnder(
    messages,
    pruneStartIndex,
    messages.length,
    settings.completedTurnsKeepReads,
  );
  if (settings.completedTurns !== "keep") {
    const clearArgsOf = new Set(settings.completedTurnsClearArgs);
    for (let i = pruneStartIndex; i < completedEnd; i++) {
      const msg = messages[i];
      if (msg?.role === "assistant" && clearArgsOf.size > 0) {
        const updated = clearLongToolCallArgs(msg, clearArgsOf);
        if (updated) {
          replaceAt(i, updated);
        }
        continue;
      }
      if (!msg || msg.role !== "toolResult" || !isToolPrunable(msg.toolName)) {
        continue;
      }
      if (keptReads.has(msg.toolCallId)) {
        continue;
      }
      const current = msg as unknown as ToolResultMessage;
      const updated =
        settings.completedTurns === "clear"
          ? clearToolResultMessage({ msg: current, settings })
          : softTrimToolResultMessage({ msg: current, settings });
      if (updated) {
        replaceAt(i, updated as unknown as AgentMessage);
      }
    }
  }

  if (settings.mode === "always") {
    // The turn still in progress. With completedTurns "keep" no turn is ever finished for this
    // rule, so the whole session is one region.
    const afterCompletedTurns: AgentMessage[] = next ?? messages;
    const isEligible = (i: number): boolean => {
      const msg = afterCompletedTurns[i];
      return (
        msg?.role === "toolResult" && isToolPrunable(msg.toolName) && !keptReads.has(msg.toolCallId)
      );
    };
    const triggerTokens =
      settings.batch.triggerTokens ?? Math.floor(contextWindowTokens * settings.softTrimRatio);
    const placeholder = settings.batch.placeholder ?? settings.hardClear.placeholder;
    // Each result is rewritten at most once per form, however many batches are weighed.
    const memo = (change: (msg: ToolResultMessage) => ToolResultMessage | null) => {
      const done = new Map<number, AgentMessage>();
      return (i: number): AgentMessage => {
        let result = done.get(i);
        if (!result) {
          const msg = afterCompletedTurns[i];
          result = (change(msg as unknown as ToolResultMessage) ?? msg) as AgentMessage;
          done.set(i, result);
        }
        return result;
      };
    };
    const trimmedAt = memo((msg) => softTrimToolResultMessage({ msg, settings }));
    const clearedAt = memo((msg) => clearToolResultMessage({ msg, settings, placeholder }));
    const ends = resolveBatchEnds({
      messages: afterCompletedTurns,
      regionStart: completedEnd,
      triggerTokens,
      settings,
      isEligible,
      trimmedAt,
      clearedAt,
    });
    const lastEnd = ends.at(-1);
    if (lastEnd === undefined) {
      return afterCompletedTurns;
    }
    // The newest batch keeps a head and tail of each result; a later batch clears it.
    const trimFrom = ends.length > 1 ? ends[ends.length - 2] : completedEnd;
    for (let i = completedEnd; i < lastEnd; i++) {
      if (!isEligible(i)) {
        continue;
      }
      const updated = i < trimFrom && settings.hardClear.enabled ? clearedAt(i) : trimmedAt(i);
      if (updated !== afterCompletedTurns[i]) {
        replaceAt(i, updated);
      }
    }
    return next ?? messages;
  }

  // cache-ttl: the provider's cache has already expired, so pruning by ratio on this request
  // invalidates nothing.
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
    replaceAt(i, updated as unknown as AgentMessage);
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

  for (const i of prunableToolIndexes) {
    if (ratio < settings.hardClearRatio) {
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
    replaceAt(i, cleared as unknown as AgentMessage);
    ratio = totalChars / charWindow;
  }

  return next ?? messages;
}
