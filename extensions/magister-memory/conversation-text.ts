import { createHash } from "node:crypto";
import type { TranscriptEntry } from "./conversation-types.js";
import { isRecord } from "./file-utils.js";

const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);
const ACKNOWLEDGEMENT_ONLY =
  /^(?:ok(?:ay)?|thanks?|thank you|got it|sounds good|cool|great|nice|perfect|yep|yes|no|sure|hi|hello|hey)[.!\s]*$/i;
const DURABLE_SIGNAL =
  /\b(?:remember|from now on|next time|always|never|prefer|preference|make sure|we decided|the decision|our audience|target audience|brand voice|my name is|call me|we use|our project|our company|correction|actually|i meant|to clarify|that's not|that is not)\b/i;

function readTextValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.value === "string") {
    return value.value;
  }
  return "";
}

function extractTextBlock(block: unknown): string {
  if (!isRecord(block) || typeof block.type !== "string" || !TEXT_BLOCK_TYPES.has(block.type)) {
    return "";
  }
  return readTextValue(block.text);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(extractTextBlock).filter(Boolean).join("\n");
  }
  return extractTextBlock(content);
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function fingerprintTranscriptEntry(role: string, text: string): string {
  return createHash("sha256").update(role).update("\0").update(text).digest("hex");
}

export function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function extractTranscriptEntries(messages: unknown[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const text = compactWhitespace(extractMessageText(message.content));
    if (!text) {
      continue;
    }
    entries.push({
      role: message.role,
      text,
      fingerprint: fingerprintTranscriptEntry(message.role, text),
    });
  }
  return entries;
}

export function extractConversationDelta(
  entries: TranscriptEntry[],
  lastFingerprint?: string,
  lastMessageCount?: number,
): TranscriptEntry[] {
  if (entries.length === 0) {
    return [];
  }
  if (!lastFingerprint) {
    return boundEntriesFromEnd(entries, 24_000);
  }
  if (
    lastMessageCount !== undefined &&
    lastMessageCount > 0 &&
    lastMessageCount <= entries.length &&
    entries[lastMessageCount - 1]?.fingerprint === lastFingerprint
  ) {
    return entries.slice(lastMessageCount);
  }
  if (lastMessageCount !== undefined) {
    const lastUser = entries.findLastIndex((entry) => entry.role === "user");
    return entries.slice(lastUser >= 0 ? lastUser : Math.max(0, entries.length - 2));
  }
  const lastUser = entries.findLastIndex((entry) => entry.role === "user");
  return entries.slice(lastUser >= 0 ? lastUser : Math.max(0, entries.length - 2));
}

export function isMeaningfulConversation(
  entries: TranscriptEntry[],
  options: { hasToolWork?: boolean } = {},
): boolean {
  const userText = entries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.text)
    .join(" ")
    .trim();
  if (!userText) {
    return false;
  }
  if (DURABLE_SIGNAL.test(userText) || options.hasToolWork) {
    return true;
  }
  if (ACKNOWLEDGEMENT_ONLY.test(userText)) {
    return false;
  }
  const assistantChars = entries
    .filter((entry) => entry.role === "assistant")
    .reduce((total, entry) => total + entry.text.length, 0);
  const userTurns = entries.filter((entry) => entry.role === "user").length;
  return userText.length >= 32 || assistantChars >= 80 || userTurns >= 2;
}

export function containsToolWorkInLatestTurn(messages: unknown[]): boolean {
  const latestUserIndex = messages.findLastIndex(
    (message) => isRecord(message) && message.role === "user",
  );
  const turn = messages.slice(
    latestUserIndex >= 0 ? latestUserIndex : Math.max(0, messages.length - 4),
  );
  return turn.some((message) => valueContainsToolWork(message));
}

export function countUserTurns(entries: TranscriptEntry[]): number {
  return entries.filter((entry) => entry.role === "user").length;
}

export function transcriptCharCount(entries: TranscriptEntry[]): number {
  return entries.reduce((total, entry) => total + entry.text.length, 0);
}

export function boundEntriesFromEnd(
  entries: TranscriptEntry[],
  maxChars: number,
): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];
  let chars = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const remaining = maxChars - chars;
    if (remaining <= 0) {
      break;
    }
    if (entry.text.length <= remaining) {
      result.unshift(entry);
      chars += entry.text.length;
      continue;
    }
    const text = entry.text.slice(-remaining);
    result.unshift({
      ...entry,
      text,
      fingerprint: fingerprintTranscriptEntry(entry.role, text),
    });
    break;
  }
  return result;
}

export function sanitizeReferenceText(value: string, maxChars: number): string {
  return stripControlCharacters(
    compactWhitespace(value).replaceAll("<!--", "‹!--").replaceAll("-->", "--›"),
  )
    .slice(0, maxChars)
    .trim();
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    ) {
      continue;
    }
    result += character;
  }
  return result;
}

function valueContainsToolWork(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(valueContainsToolWork);
  }
  const record = value as Record<string, unknown>;
  if (
    record.role === "tool" ||
    record.type === "tool_call" ||
    record.type === "tool_result" ||
    record.type === "function_call" ||
    Array.isArray(record.tool_calls)
  ) {
    return true;
  }
  return valueContainsToolWork(record.content);
}
