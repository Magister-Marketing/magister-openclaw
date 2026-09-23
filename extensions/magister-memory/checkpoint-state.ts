import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckpointInFlight,
  CheckpointSummary,
  ConversationSessionState,
  TranscriptEntry,
} from "./conversation-types.js";
import { atomicWriteFile, isRecord, readJsonIfExists } from "./file-utils.js";

const STATE_VERSION = 1;

export function checkpointStateRoot(workspaceDir: string): string {
  return join(workspaceDir, ".magister", "state", "conversation-checkpoints");
}

export function createConversationSessionState(params: {
  sessionHash: string;
  agentId: string;
}): ConversationSessionState {
  const nowMs = Date.now();
  return {
    version: STATE_VERSION,
    sessionHash: params.sessionHash,
    agentId: params.agentId,
    pending: [],
    pendingUserTurns: 0,
    lastActivityAt: 0,
    updatedAt: nowMs,
    sequence: 0,
    retryCount: 0,
    recallFrozen: false,
  };
}

export async function readConversationSessionState(params: {
  workspaceDir: string;
  sessionHash: string;
  agentId: string;
}): Promise<ConversationSessionState> {
  const parsed = await readJsonIfExists(sessionStatePath(params.workspaceDir, params.sessionHash));
  return parseSessionState(parsed, params) ?? createConversationSessionState(params);
}

export async function writeConversationSessionState(
  workspaceDir: string,
  state: ConversationSessionState,
): Promise<void> {
  state.updatedAt = Date.now();
  await atomicWriteFile(
    sessionStatePath(workspaceDir, state.sessionHash),
    `${JSON.stringify(state)}\n`,
  );
}

export async function removeConversationSessionState(
  workspaceDir: string,
  sessionHash: string,
): Promise<void> {
  try {
    await unlink(sessionStatePath(workspaceDir, sessionHash));
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

export async function listConversationSessionStates(
  workspaceDir: string,
): Promise<ConversationSessionState[]> {
  const directory = join(checkpointStateRoot(workspaceDir), "sessions");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const states = await Promise.all(
    names
      .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
      .map(async (name) => {
        const parsed = await readJsonIfExists(join(directory, name));
        const sessionHash = name.slice(0, -5);
        return parseSessionState(parsed, { sessionHash, agentId: "main" });
      }),
  );
  return states.filter((state): state is ConversationSessionState => Boolean(state));
}

export async function writeShadowCheckpoint(params: {
  workspaceDir: string;
  checkpointId: string;
  sessionHash: string;
  sequence: number;
  createdAt: number;
  summary: CheckpointSummary;
}): Promise<void> {
  const directory = join(checkpointStateRoot(params.workspaceDir), "shadow");
  await mkdir(directory, { recursive: true });
  await atomicWriteFile(
    join(directory, `${params.checkpointId}.json`),
    `${JSON.stringify({ version: STATE_VERSION, ...params, workspaceDir: undefined })}\n`,
  );
}

export function selectConversationSessionStatesForPruning(params: {
  states: ConversationSessionState[];
  nowMs: number;
  retentionMs: number;
  maxStates: number;
}): string[] {
  const removable = params.states.filter(isQuiescentSessionState);
  const selected = new Set<string>();
  const cutoffMs = params.nowMs - Math.max(0, params.retentionMs);
  for (const state of removable) {
    if (state.endedAt !== undefined || state.updatedAt < cutoffMs) {
      selected.add(state.sessionHash);
    }
  }

  let remaining = params.states.length - selected.size;
  const maxStates = Math.max(1, Math.floor(params.maxStates));
  if (remaining > maxStates) {
    const oldest = removable
      .filter((state) => !selected.has(state.sessionHash))
      .toSorted(
        (left, right) =>
          left.updatedAt - right.updatedAt || left.sessionHash.localeCompare(right.sessionHash),
      );
    for (const state of oldest) {
      if (remaining <= maxStates) {
        break;
      }
      selected.add(state.sessionHash);
      remaining -= 1;
    }
  }
  return [...selected];
}

export async function pruneShadowCheckpoints(params: {
  workspaceDir: string;
  nowMs: number;
  retentionMs: number;
  maxFiles: number;
}): Promise<number> {
  const directory = join(checkpointStateRoot(params.workspaceDir), "shadow");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      const parsed = await readJsonIfExists(path);
      const createdAt = isRecord(parsed) ? readNonNegativeNumber(parsed.createdAt) : undefined;
      const modifiedAt = createdAt ?? (await stat(path)).mtimeMs;
      return { name, path, modifiedAt };
    }),
  );
  const selected = new Set<string>();
  const cutoffMs = params.nowMs - Math.max(0, params.retentionMs);
  for (const file of files) {
    if (file.modifiedAt < cutoffMs) {
      selected.add(file.name);
    }
  }
  let remaining = files.length - selected.size;
  const maxFiles = Math.max(1, Math.floor(params.maxFiles));
  if (remaining > maxFiles) {
    for (const file of files
      .filter((candidate) => !selected.has(candidate.name))
      .toSorted(
        (left, right) => left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name),
      )) {
      if (remaining <= maxFiles) {
        break;
      }
      selected.add(file.name);
      remaining -= 1;
    }
  }
  await Promise.all(
    files
      .filter((file) => selected.has(file.name))
      .map((file) =>
        unlink(file.path).catch((error) => {
          if (!isNodeErrorWithCode(error, "ENOENT")) {
            throw error;
          }
        }),
      ),
  );
  return selected.size;
}

function sessionStatePath(workspaceDir: string, sessionHash: string): string {
  return join(checkpointStateRoot(workspaceDir), "sessions", `${sessionHash}.json`);
}

function parseSessionState(
  value: unknown,
  fallback: { sessionHash: string; agentId: string },
): ConversationSessionState | undefined {
  if (!isRecord(value) || value.version !== STATE_VERSION) {
    return undefined;
  }
  const sessionHash = readString(value.sessionHash) ?? fallback.sessionHash;
  if (!/^[a-f0-9]{32}$/.test(sessionHash)) {
    return undefined;
  }
  const pending = parseTranscriptEntries(value.pending);
  const inFlight = parseInFlight(value.inFlight);
  return {
    version: STATE_VERSION,
    sessionHash,
    agentId: readString(value.agentId) ?? fallback.agentId,
    ...(readString(value.lastMessageFingerprint)
      ? { lastMessageFingerprint: readString(value.lastMessageFingerprint) }
      : {}),
    ...(readNonNegativeInteger(value.lastMessageCount) !== undefined
      ? { lastMessageCount: readNonNegativeInteger(value.lastMessageCount) }
      : {}),
    pending,
    pendingUserTurns: readNonNegativeInteger(value.pendingUserTurns) ?? countUsers(pending),
    lastActivityAt: readNonNegativeNumber(value.lastActivityAt) ?? 0,
    updatedAt:
      readNonNegativeNumber(value.updatedAt) ?? readNonNegativeNumber(value.lastActivityAt) ?? 0,
    ...(readNonNegativeNumber(value.endedAt) !== undefined
      ? { endedAt: readNonNegativeNumber(value.endedAt) }
      : {}),
    sequence: readNonNegativeInteger(value.sequence) ?? 0,
    retryCount: readNonNegativeInteger(value.retryCount) ?? 0,
    ...(readNonNegativeNumber(value.retryAt) !== undefined
      ? { retryAt: readNonNegativeNumber(value.retryAt) }
      : {}),
    ...(readString(value.previousSummary)
      ? { previousSummary: readString(value.previousSummary) }
      : {}),
    ...(inFlight ? { inFlight } : {}),
    recallFrozen: value.recallFrozen === true,
    ...(typeof value.frozenRecall === "string" ? { frozenRecall: value.frozenRecall } : {}),
  };
}

function parseInFlight(value: unknown): CheckpointInFlight | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const checkpointId = readString(value.checkpointId);
  const entries = parseTranscriptEntries(value.entries);
  const startFingerprint = readString(value.startFingerprint);
  const endFingerprint = readString(value.endFingerprint);
  if (!checkpointId || entries.length === 0 || !startFingerprint || !endFingerprint) {
    return undefined;
  }
  const prepared = parseCheckpointSummary(value.prepared);
  return {
    checkpointId,
    entries,
    startedAt: readNonNegativeNumber(value.startedAt) ?? 0,
    sequence: readNonNegativeInteger(value.sequence) ?? 1,
    startFingerprint,
    endFingerprint,
    ...(prepared ? { prepared } : {}),
  };
}

function parseCheckpointSummary(value: unknown): CheckpointSummary | undefined {
  if (!isRecord(value) || (value.source !== "model" && value.source !== "fallback")) {
    return undefined;
  }
  const summary = readString(value.summary);
  if (!summary) {
    return undefined;
  }
  const topics = Array.isArray(value.topics)
    ? value.topics.map(readString).filter((topic): topic is string => Boolean(topic))
    : [];
  return {
    summary,
    topics,
    source: value.source,
  };
}

function parseTranscriptEntries(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const item of value) {
    if (!isRecord(item) || (item.role !== "user" && item.role !== "assistant")) {
      continue;
    }
    const text = readString(item.text);
    const fingerprint = readString(item.fingerprint);
    if (text && fingerprint && /^[a-f0-9]{64}$/.test(fingerprint)) {
      entries.push({ role: item.role, text, fingerprint });
    }
  }
  return entries;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const number = readNonNegativeNumber(value);
  return number === undefined ? undefined : Math.floor(number);
}

function countUsers(entries: TranscriptEntry[]): number {
  return entries.filter((entry) => entry.role === "user").length;
}

function isQuiescentSessionState(state: ConversationSessionState): boolean {
  return state.pending.length === 0 && !state.inFlight && state.retryAt === undefined;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
