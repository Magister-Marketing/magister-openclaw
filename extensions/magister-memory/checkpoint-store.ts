import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeReferenceText } from "./conversation-text.js";
import type { CheckpointRecord } from "./conversation-types.js";
import { atomicWriteFile, isRecord, readUtf8IfExists } from "./file-utils.js";

const START_PREFIX = "<!-- magister-checkpoint:v1:";
const END_MARKER = "<!-- /magister-checkpoint -->";
const START_PATTERN_SOURCE = String.raw`<!-- magister-checkpoint:v1:([A-Za-z0-9_-]+) -->\n`;

export async function appendCheckpoint(params: {
  workspaceDir: string;
  userTimezone?: string;
  record: CheckpointRecord;
}): Promise<{ path: string; appended: boolean }> {
  const date = formatDateInTimezone(params.record.createdAt, params.userTimezone);
  const memoryDir = join(params.workspaceDir, "memory");
  const path = join(memoryDir, `${date}.md`);
  await mkdir(memoryDir, { recursive: true });
  const existing = (await readUtf8IfExists(path)) ?? "";
  if (
    parseCheckpointRecords(existing).some(
      (record) => record.checkpointId === params.record.checkpointId,
    )
  ) {
    return { path, appended: false };
  }
  const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await atomicWriteFile(path, `${existing}${separator}${serializeCheckpoint(params.record)}\n`);
  return { path, appended: true };
}

export function serializeCheckpoint(record: CheckpointRecord): string {
  const encoded = Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
  const summary = sanitizeReferenceText(record.summary, 4_000);
  const topics = record.topics
    .map((topic) => sanitizeReferenceText(topic, 80))
    .filter(Boolean)
    .slice(0, 5);
  const topicLine = topics.length > 0 ? `\n\nTopics: ${topics.join(", ")}` : "";
  return [
    `${START_PREFIX}${encoded} -->`,
    "### Conversation checkpoint",
    "",
    `${summary}${topicLine}`,
    END_MARKER,
  ].join("\n");
}

export function parseCheckpointRecords(markdown: string): CheckpointRecord[] {
  const records: CheckpointRecord[] = [];
  const startPattern = new RegExp(START_PATTERN_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(markdown)) !== null) {
    const endIndex = markdown.indexOf(`\n${END_MARKER}`, startPattern.lastIndex);
    const nextStartIndex = markdown.indexOf(START_PREFIX, startPattern.lastIndex);
    if (nextStartIndex >= 0 && (endIndex < 0 || nextStartIndex < endIndex)) {
      startPattern.lastIndex = nextStartIndex;
      continue;
    }
    if (endIndex < 0) {
      break;
    }
    try {
      if (match[1].length > 16_000) {
        startPattern.lastIndex = endIndex + END_MARKER.length + 1;
        continue;
      }
      const decoded = Buffer.from(match[1], "base64url").toString("utf8");
      const record = parseCheckpointRecord(JSON.parse(decoded) as unknown);
      if (record) {
        records.push(record);
      }
    } catch {
      // Malformed records are untrusted input and are intentionally skipped.
    }
    startPattern.lastIndex = endIndex + END_MARKER.length + 1;
  }
  return records;
}

export async function listRecentCheckpoints(params: {
  workspaceDir: string;
  recentDays: number;
  nowMs?: number;
  userTimezone?: string;
}): Promise<CheckpointRecord[]> {
  const memoryDir = join(params.workspaceDir, "memory");
  let names: string[];
  try {
    names = await readdir(memoryDir);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const nowMs = params.nowMs ?? Date.now();
  const cutoffMs = nowMs - Math.max(1, params.recentDays) * 24 * 60 * 60 * 1000;
  const cutoffDate = formatDateInTimezone(cutoffMs, params.userTimezone);
  const candidateNames = names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && name.slice(0, 10) >= cutoffDate)
    .toSorted();
  const bySession = new Map<string, CheckpointRecord>();
  for (const name of candidateNames) {
    const markdown = await readUtf8IfExists(join(memoryDir, name));
    if (markdown === undefined) {
      continue;
    }
    for (const record of parseCheckpointRecords(markdown)) {
      if (record.createdAt < cutoffMs || record.createdAt > nowMs + 5 * 60 * 1000) {
        continue;
      }
      const current = bySession.get(record.sessionHash);
      if (
        !current ||
        record.sequence > current.sequence ||
        (record.sequence === current.sequence && record.createdAt > current.createdAt)
      ) {
        bySession.set(record.sessionHash, record);
      }
    }
  }
  return [...bySession.values()].toSorted((a, b) => b.createdAt - a.createdAt);
}

export function formatDateInTimezone(nowMs: number, timezone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      ...(timezone ? { timeZone: timezone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(nowMs));
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Invalid configured timezones fall back to UTC instead of blocking capture.
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function parseCheckpointRecord(value: unknown): CheckpointRecord | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  const checkpointId = readBoundedString(value.checkpointId, 200);
  const sessionHash = readBoundedString(value.sessionHash, 64);
  const startFingerprint = readBoundedString(value.startFingerprint, 64);
  const endFingerprint = readBoundedString(value.endFingerprint, 64);
  const summary = readBoundedString(value.summary, 4_000);
  if (
    !checkpointId ||
    !sessionHash ||
    !/^[a-f0-9]{32}$/.test(sessionHash) ||
    !startFingerprint ||
    !/^[a-f0-9]{64}$/.test(startFingerprint) ||
    !endFingerprint ||
    !/^[a-f0-9]{64}$/.test(endFingerprint) ||
    !summary ||
    typeof value.sequence !== "number" ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0
  ) {
    return undefined;
  }
  const topics = Array.isArray(value.topics)
    ? value.topics
        .map((topic) => readBoundedString(topic, 80))
        .filter((topic): topic is string => Boolean(topic))
        .slice(0, 5)
    : [];
  return {
    version: 1,
    checkpointId,
    sessionHash,
    sequence: value.sequence,
    startFingerprint,
    endFingerprint,
    createdAt: value.createdAt,
    summary,
    topics,
  };
}

function readBoundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= maxChars
    ? value.trim()
    : undefined;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
