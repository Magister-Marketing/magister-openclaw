import { join } from "node:path";
import { withContextLock } from "./context-lock.js";
import { atomicWriteFile, isRecord, readUtf8IfExists } from "./file-utils.js";
import { callRuntimeGateway } from "./gateway-runtime.js";
import { atomicWrite, type MemoryResult, parseMemoryEntries } from "./memory-store.js";

/**
 * Brand memory: the `memory` tool's target='memory' list. Its home is the
 * Gateway (`brand_memory`), which every Magister agent working on the brand
 * reads and writes: this hosted agent, MCP clients, and the analytics review.
 * The Gateway applies the rules the file store used to (2,200-char budget,
 * duplicate and unique-match checks, threat scan) inside the project's fence,
 * so a machine that lost its project cannot write. MEMORY.md is this
 * machine's copy, rewritten from every reply and once per session at the
 * start; the context engine reads that copy into the system prompt.
 */

const READ_TIMEOUT_MS = 3_000;
const WRITE_TIMEOUT_MS = 5_000;
const SEED_PREFIX = "[magister_seed:";
const MAX_TRACKED_SESSIONS = 500;

export type BrandMemoryOperation =
  | { action: "add"; content: string }
  | { action: "replace"; old_text: string; content: string }
  | { action: "remove"; old_text: string };

type BrandMemoryList = { entries: string[]; content: string; charCount: number };

function parseList(value: Record<string, unknown>): BrandMemoryList | undefined {
  const { entries, content, char_count: charCount } = value;
  if (!Array.isArray(entries) || typeof content !== "string" || !Number.isSafeInteger(charCount)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.text !== "string") {
      return undefined;
    }
    texts.push(entry.text);
  }
  return { entries: texts, content, charCount: Number(charCount) };
}

function requireList(value: Record<string, unknown>): BrandMemoryList {
  const list = parseList(value);
  if (!list) {
    throw new Error("brand memory response is invalid");
  }
  return list;
}

async function readList(): Promise<BrandMemoryList> {
  return requireList(
    await callRuntimeGateway("brand-memory", { method: "GET", timeoutMs: READ_TIMEOUT_MS }),
  );
}

function postOperation(operation: BrandMemoryOperation): Promise<Record<string, unknown>> {
  return callRuntimeGateway("brand-memory", {
    method: "POST",
    body: operation,
    timeoutMs: WRITE_TIMEOUT_MS,
  });
}

/**
 * Rewrite the machine's MEMORY.md when it differs from the Gateway's list.
 * `atomicWrite` creates the file under the process umask (0027 on machines,
 * so 0640): the sandboxed shell reads workspace files through the host's
 * group, and a 0600 copy would hide MEMORY.md from it.
 */
async function writeMemoryCopy(workspaceDir: string, content: string): Promise<void> {
  const path = join(workspaceDir, "MEMORY.md");
  await withContextLock(workspaceDir, async () => {
    if (((await readUtf8IfExists(path)) ?? "") !== content) {
      await atomicWrite(path, content);
    }
  });
}

function unavailable(error: unknown): MemoryResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    target: "memory",
    message: `Brand memory is unavailable right now (${reason}); the change was not confirmed. Try again later.`,
  };
}

/**
 * Apply one memory-tool operation through the Gateway. Refusals (full, no
 * match, duplicate, blocked) come back as the Gateway's own message, which is
 * the store's message verbatim; a transport failure or timeout says the
 * memory is unavailable, so the turn carries on either way.
 */
export async function applyBrandMemory(
  workspaceDir: string,
  operation: BrandMemoryOperation,
): Promise<MemoryResult> {
  let reply: Record<string, unknown>;
  let list: BrandMemoryList | undefined;
  try {
    reply = await postOperation(operation);
    list = parseList(reply);
    if (reply.ok === true ? !list : typeof reply.error !== "string") {
      throw new Error("brand memory response is invalid");
    }
  } catch (error) {
    return unavailable(error);
  }
  if (list) {
    // The Gateway already holds the change; a failed local copy is rewritten
    // at the next session start and must not report the write as failed.
    await writeMemoryCopy(workspaceDir, list.content).catch(() => undefined);
  }
  if (reply.ok !== true || !list) {
    return { success: false, target: "memory", message: String(reply.error) };
  }
  return { success: true, target: "memory", entries: list.entries, charCount: list.charCount };
}

function importStampPath(workspaceDir: string): string {
  return join(workspaceDir, ".magister", "state", "brand-memory-import");
}

/**
 * Move this machine's MEMORY.md entries to the Gateway, once per machine.
 * Gateway seed records are dropped: they repeat PROJECT.md, BRAND.md and the
 * plan. A project with no Gateway entries takes them through the import
 * route; one that already has entries (an MCP client or the analytics review
 * wrote first) takes each missing entry as an ordinary add, so the rewrite
 * that follows cannot erase what this machine had learned. A transport
 * failure throws before the stamp is written, so the next session retries.
 * An entry the Gateway refuses (a duplicate in other letter case, a blocked
 * threat, a full list) is dropped exactly as the import route drops it:
 * retrying could never succeed and would keep this machine's copy unsynced.
 * The stamp keeps the original file, so nothing is lost for good.
 */
async function importLocalEntries(
  original: string,
  list: BrandMemoryList,
): Promise<BrandMemoryList> {
  const local = parseMemoryEntries(original)
    .map((entry) => entry.trim())
    .filter((entry) => !entry.startsWith(SEED_PREFIX));
  if (list.entries.length === 0) {
    return local.length === 0
      ? list
      : requireList(
          await callRuntimeGateway("brand-memory/import", {
            method: "POST",
            body: { entries: local },
            timeoutMs: WRITE_TIMEOUT_MS,
          }),
        );
  }
  const known = new Set(list.entries.map((entry) => entry.trim()));
  const missing = local.filter((entry) => !known.has(entry));
  for (const content of missing) {
    await postOperation({ action: "add", content });
  }
  return missing.length === 0 ? list : await readList();
}

/**
 * Session-start sync: fetch the Gateway's list and rewrite MEMORY.md when it
 * differs, running the one-time import first. Throws when the Gateway is
 * unreachable; the caller keeps the local file.
 */
export async function syncBrandMemory(workspaceDir: string): Promise<void> {
  let list = await readList();
  const stampPath = importStampPath(workspaceDir);
  if ((await readUtf8IfExists(stampPath)) === undefined) {
    const original = (await readUtf8IfExists(join(workspaceDir, "MEMORY.md"))) ?? "";
    list = await importLocalEntries(original, list);
    await atomicWriteFile(
      stampPath,
      `${JSON.stringify({ imported_at: new Date().toISOString(), memory_md: original })}\n`,
    );
  }
  await writeMemoryCopy(workspaceDir, list.content);
}

/**
 * Which sessions already synced. The context engine is built per run and
 * reads MEMORY.md on its first assemble(), so the sync runs ahead of a
 * session's first run and is skipped for the rest of that session.
 */
export class BrandMemorySessions {
  private readonly synced = new Set<string>();

  claim(workspaceDir: string, sessionId: string | undefined): boolean {
    if (!sessionId) {
      return true;
    }
    const key = `${workspaceDir}\n${sessionId}`;
    if (this.synced.has(key)) {
      return false;
    }
    this.synced.add(key);
    if (this.synced.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.synced.values().next().value;
      if (oldest !== undefined) {
        this.synced.delete(oldest);
      }
    }
    return true;
  }
}
