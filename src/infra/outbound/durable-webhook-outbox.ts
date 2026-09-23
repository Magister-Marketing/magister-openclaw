import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { emitDiagnosticEvent } from "../diagnostic-events.js";

const OUTBOX_DIRNAME = "durable-webhook-outbox";
const DEAD_LETTER_DIRNAME = "dead-letter";
const MAX_ATTEMPTS = 10;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const DELIVERY_TIMEOUT_MS = 10_000;

const DIAGNOSTIC_CHANNEL_BY_EVENT_TYPE = {
  cron_completion: "cron",
  slack_completion: "slack",
  subagent_completion: "subagent",
} as const;

export type DurableWebhookEventType =
  | "cron_completion"
  | "slack_completion"
  | "subagent_completion";

export type DurableWebhookEntry = {
  version: 1;
  eventId: string;
  eventType: DurableWebhookEventType;
  payloadHash: string;
  url: string;
  payload: Record<string, unknown>;
  enqueuedAt: number;
  attemptCount: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  lastError?: string;
  acknowledged?: boolean;
  deliveredAt?: number;
};

export class DurableWebhookReplayConflictError extends Error {
  constructor() {
    super("conflicting durable webhook event replay");
    this.name = "DurableWebhookReplayConflictError";
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    // Match JSON.stringify/writeDurable: object properties with undefined
    // values do not survive persistence, while undefined array items become null.
    .filter((key) => row[key] !== undefined)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outboxDir(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(), OUTBOX_DIRNAME);
}

function deadLetterDir(stateDir?: string): string {
  return path.join(outboxDir(stateDir), DEAD_LETTER_DIRNAME);
}

function entryFilename(eventId: string): string {
  return `${sha256(eventId)}.json`;
}

function entryPath(eventId: string, stateDir?: string): string {
  return path.join(outboxDir(stateDir), entryFilename(eventId));
}

function deliveredEntryPath(eventId: string, stateDir?: string): string {
  return `${entryPath(eventId, stateDir)}.delivered`;
}

function originalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload };
  delete result.event_id;
  delete result.event_type;
  delete result.payload_hash;
  return result;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurable(filePath: string, value: DurableWebhookEntry): Promise<void> {
  const encoded = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) {
    throw new Error("durable webhook payload exceeds 512 KiB");
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  const handle = await fs.promises.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(temporary, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function readEntry(filePath: string): Promise<DurableWebhookEntry> {
  return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as DurableWebhookEntry;
}

function retryDelayMs(eventId: string, attemptCount: number): number {
  const base = Math.min(5_000 * 2 ** Math.max(0, attemptCount - 1), 15 * 60_000);
  // Stable jitter prevents a rebooted fleet from retrying in lockstep while
  // keeping tests and crash recovery deterministic for the same event.
  const sample = Number.parseInt(sha256(`${eventId}:${attemptCount}`).slice(0, 8), 16) / 0xffffffff;
  const jitter = 0.8 + sample * 0.4;
  return Math.min(15 * 60_000, Math.max(5_000, Math.round(base * jitter)));
}

export async function enqueueDurableWebhook(params: {
  eventId: string;
  eventType: DurableWebhookEventType;
  url: string;
  payload: Record<string, unknown>;
  stateDir?: string;
}): Promise<DurableWebhookEntry> {
  const directory = outboxDir(params.stateDir);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(deadLetterDir(params.stateDir), { recursive: true, mode: 0o700 });
  const payloadHash = sha256(canonicalJson(params.payload));
  const filePath = entryPath(params.eventId, params.stateDir);
  try {
    const delivered = await readEntry(deliveredEntryPath(params.eventId, params.stateDir));
    if (delivered.eventType !== params.eventType || delivered.payloadHash !== payloadHash) {
      throw new DurableWebhookReplayConflictError();
    }
    return delivered;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    const existing = await readEntry(filePath);
    // Pending entries retain their body, so it is safe to repair metadata from
    // the canonical persisted payload. This migrates hashes written before
    // undefined properties were omitted and retargets undelivered callbacks
    // after an allowlisted route change without resetting retry history.
    const persistedPayloadHash = sha256(canonicalJson(originalPayload(existing.payload)));
    if (
      existing.eventId !== params.eventId ||
      existing.eventType !== params.eventType ||
      persistedPayloadHash !== payloadHash
    ) {
      throw new DurableWebhookReplayConflictError();
    }
    if (existing.payloadHash !== payloadHash || existing.url !== params.url) {
      const repaired: DurableWebhookEntry = {
        ...existing,
        payloadHash,
        url: params.url,
        payload: {
          ...existing.payload,
          payload_hash: payloadHash,
        },
      };
      await writeDurable(filePath, repaired);
      return repaired;
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const now = Date.now();
  const entry: DurableWebhookEntry = {
    version: 1,
    eventId: params.eventId,
    eventType: params.eventType,
    payloadHash,
    url: params.url,
    payload: {
      ...params.payload,
      event_id: params.eventId,
      event_type: params.eventType,
      payload_hash: payloadHash,
    },
    enqueuedAt: now,
    attemptCount: 0,
    nextAttemptAt: now,
  };
  await writeDurable(filePath, entry);
  return entry;
}

async function acknowledge(entry: DurableWebhookEntry, stateDir?: string): Promise<void> {
  const filePath = entryPath(entry.eventId, stateDir);
  const deliveredPath = deliveredEntryPath(entry.eventId, stateDir);
  await writeDurable(deliveredPath, {
    ...entry,
    payload: {},
    acknowledged: true,
    deliveredAt: Date.now(),
    lastError: undefined,
  });
  await fs.promises.rm(filePath, { force: true });
  await syncDirectory(path.dirname(filePath));
}

async function recordFailure(
  entry: DurableWebhookEntry,
  error: unknown,
  stateDir?: string,
): Promise<void> {
  const now = Date.now();
  const updated: DurableWebhookEntry = {
    ...entry,
    attemptCount: entry.attemptCount + 1,
    lastAttemptAt: now,
    lastError: String(error).slice(0, 500),
    nextAttemptAt: now + retryDelayMs(entry.eventId, entry.attemptCount + 1),
  };
  const currentPath = entryPath(entry.eventId, stateDir);
  if (updated.attemptCount >= MAX_ATTEMPTS) {
    const target = path.join(deadLetterDir(stateDir), entryFilename(entry.eventId));
    await writeDurable(currentPath, updated);
    await fs.promises.rename(currentPath, target);
    await syncDirectory(outboxDir(stateDir));
    await syncDirectory(deadLetterDir(stateDir));
    emitDiagnosticEvent({
      type: "webhook.delivery.dead_lettered",
      channel: DIAGNOSTIC_CHANNEL_BY_EVENT_TYPE[entry.eventType],
      failureKind: "retry_exhausted",
    });
    return;
  }
  await writeDurable(currentPath, updated);
}

export async function deliverDurableWebhookEntry(params: {
  entry: DurableWebhookEntry;
  token: string;
  fetchImpl?: FetchLike;
  stateDir?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  if (params.entry.acknowledged) {
    return true;
  }
  if (!params.token) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DELIVERY_TIMEOUT_MS);
  try {
    const response = await (params.fetchImpl ?? fetch)(params.entry.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify(params.entry.payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`webhook returned HTTP ${response.status}`);
    }
    await acknowledge(params.entry, params.stateDir);
    return true;
  } catch (error) {
    await recordFailure(params.entry, error, params.stateDir);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function enqueueAndDeliverDurableWebhook(params: {
  eventId: string;
  eventType: DurableWebhookEventType;
  url: string;
  payload: Record<string, unknown>;
  token: string;
  fetchImpl?: FetchLike;
  stateDir?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const entry = await enqueueDurableWebhook(params);
  if (entry.acknowledged) {
    return true;
  }
  return await deliverDurableWebhookEntry({
    entry,
    token: params.token,
    fetchImpl: params.fetchImpl,
    stateDir: params.stateDir,
    timeoutMs: params.timeoutMs,
  });
}

export async function loadPendingDurableWebhooks(
  stateDir?: string,
): Promise<DurableWebhookEntry[]> {
  const directory = outboxDir(stateDir);
  let names: string[];
  try {
    names = await fs.promises.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const entries: DurableWebhookEntry[] = [];
  const delivered = new Set(
    names.filter((name) => name.endsWith(".json.delivered")).map((name) => name.slice(0, -10)),
  );
  for (const name of names) {
    if (name.endsWith(".delivered")) {
      continue;
    }
    if (!name.endsWith(".json")) {
      continue;
    }
    if (delivered.has(name)) {
      continue;
    }
    try {
      entries.push(await readEntry(path.join(directory, name)));
    } catch {
      // A malformed entry remains for operator inspection; never delete it or
      // invent a callback body from partial JSON.
    }
  }
  return entries.toSorted((left, right) => left.enqueuedAt - right.enqueuedAt);
}

export async function recoverDurableWebhookOutbox(params: {
  tokens: Partial<Record<DurableWebhookEventType, string>>;
  fetchImpl?: FetchLike;
  stateDir?: string;
  now?: number;
}): Promise<{ delivered: number; deferred: number; unavailable: number }> {
  const now = params.now ?? Date.now();
  let delivered = 0;
  let deferred = 0;
  let unavailable = 0;
  for (const entry of await loadPendingDurableWebhooks(params.stateDir)) {
    if (entry.nextAttemptAt > now) {
      deferred += 1;
      continue;
    }
    const token = params.tokens[entry.eventType];
    if (!token) {
      unavailable += 1;
      continue;
    }
    if (
      await deliverDurableWebhookEntry({
        entry,
        token,
        fetchImpl: params.fetchImpl,
        stateDir: params.stateDir,
      })
    ) {
      delivered += 1;
    }
  }
  return { delivered, deferred, unavailable };
}
