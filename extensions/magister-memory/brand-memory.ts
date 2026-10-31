import { join } from "node:path";
import { admitWorkspaceFiles, writeLegacyWorkspaceFile } from "openclaw/plugin-sdk/core";
import { withContextLock } from "./context-lock.js";
import { atomicWriteFile, isRecord, readUtf8IfExists } from "./file-utils.js";
import { callRuntimeGateway, RuntimeGatewayError } from "./gateway-runtime.js";
import { atomicWrite, type MemoryResult, parseMemoryEntries } from "./memory-store.js";

/**
 * The hosted memory tool writes explicit brand rules to the shared Gateway.
 * Modern context refreshes before every turn with provenance and source coverage.
 * MEMORY.md remains only the stable legacy projection and one-time import source.
 * USER.md and episodic conversation checkpoints keep their separate local stores.
 */

const READ_TIMEOUT_MS = 3_000;
const WRITE_TIMEOUT_MS = 5_000;
const SEED_PREFIX = "[magister_seed:";

export type BrandMemoryOperation = (
  | { action: "add"; content: string }
  | { action: "replace"; old_text?: string; content: string }
  | { action: "remove"; old_text?: string }
) & { entry_id?: string; scope?: Record<string, string>; expected_revision?: number };

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
  return callRuntimeGateway("marketing-context/rules", {
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
    await writeLegacyWorkspaceFile(workspaceDir, async () => {
      if (((await readUtf8IfExists(path)) ?? "") !== content) await atomicWrite(path, content);
    });
  });
}

function importStampPath(workspaceDir: string): string {
  return join(workspaceDir, ".magister", "state", "brand-memory-import");
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
    await syncMarketingContext(workspaceDir).catch(() => undefined);
  }
  if (reply.ok !== true || !list) {
    return { success: false, target: "memory", message: String(reply.error) };
  }
  return { success: true, target: "memory", entries: list.entries, charCount: list.charCount };
}

/**
 * Move this machine's MEMORY.md entries to the Gateway, once per machine.
 * Gateway seed records are dropped: they repeat PROJECT.md, BRAND.md and the
 * plan. The Gateway imports once per brand and skips the entries it already
 * has (an MCP client or the analytics review may have written first), so a
 * retry after a timeout, or after the team removed every entry, adds nothing
 * back. A transport failure throws before the stamp is written, so the next
 * session retries. An entry the Gateway refuses (a duplicate in other letter
 * case, a blocked threat, a full list) is dropped: retrying could never
 * succeed and would keep this machine's copy unsynced. The stamp keeps the
 * original file, so nothing is lost for good.
 */
async function importLocalEntries(
  original: string,
  list: BrandMemoryList,
): Promise<BrandMemoryList> {
  const local = parseMemoryEntries(original)
    .map((entry) => entry.trim())
    .filter((entry) => !entry.startsWith(SEED_PREFIX));
  if (local.length === 0) {
    return list;
  }
  return requireList(
    await callRuntimeGateway("brand-memory/import", {
      method: "POST",
      body: { entries: local },
      timeoutMs: WRITE_TIMEOUT_MS,
    }),
  );
}

/**
 * Turn-start legacy sync: fetch the Gateway's list and rewrite MEMORY.md when it
 * differs, running the one-time import first. Throws when the Gateway is
 * unreachable; the caller keeps the local file.
 */
export async function syncBrandMemory(workspaceDir: string): Promise<void> {
  if (await admitWorkspaceFiles(workspaceDir)) return;
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

/** Refresh on every turn. A failed refresh keeps the last good context, marked stale. */
export async function syncMarketingContext(workspaceDir: string): Promise<void> {
  const path = join(workspaceDir, ".magister", "state", "marketing-context.json");
  try {
    const result = await callRuntimeGateway("marketing-context", {
      method: "GET",
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (typeof result.rendered !== "string" || !Number.isSafeInteger(result.revision)) {
      throw new Error("marketing context response is invalid");
    }
    const content = JSON.stringify({
      project_id: result.project_id,
      reset_generation: result.reset_generation,
      revision: result.revision,
      rendered: result.rendered,
    });
    if ((await readUtf8IfExists(path)) !== content) {
      await atomicWriteFile(path, content);
    }
  } catch (error) {
    if (error instanceof RuntimeGatewayError && [401, 403].includes(error.status)) {
      // Revoked authority is not a transient outage. Do not inject another
      // binding's cached knowledge or fall back to its legacy file.
      await atomicWriteFile(
        path,
        JSON.stringify({
          available: false,
          rendered:
            "Shared marketing context is unavailable because access was denied. Do not use prior cached brand memory.",
        }),
      );
      await writeMemoryCopy(workspaceDir, "");
      throw error;
    }
    const cached = await readUtf8IfExists(path);
    if (cached) {
      try {
        const previous: unknown = JSON.parse(cached);
        if (isRecord(previous) && typeof previous.rendered === "string") {
          await atomicWriteFile(path, JSON.stringify({ ...previous, stale: true }));
        }
      } catch {
        // An unreadable cache cannot supply context; never replace it with empty learning.
      }
    }
    throw error;
  }
}
