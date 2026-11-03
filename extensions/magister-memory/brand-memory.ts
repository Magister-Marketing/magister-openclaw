import { join } from "node:path";
import { admitWorkspaceFiles, writeLegacyWorkspaceFile } from "openclaw/plugin-sdk/core";
import { withContextLock } from "./context-lock.js";
import { atomicWriteFile, isRecord, readUtf8IfExists } from "./file-utils.js";
import { callRuntimeGateway, RuntimeGatewayError } from "./gateway-runtime.js";
import { atomicWrite, type MemoryResult } from "./memory-store.js";

/**
 * The hosted memory tool writes explicit brand rules to the shared Gateway, and
 * the shared marketing context refreshes before every turn with provenance and
 * source coverage. MEMORY.md is no longer read or written here: the Gateway's
 * shared context is the only brand memory. USER.md and episodic conversation
 * checkpoints keep their separate local stores.
 */

/**
 * Written once a machine's own MEMORY.md reached the Gateway (by the old
 * plugin's upload or the Gateway's migration); it keeps the original file.
 */
const IMPORT_STAMP = join(".magister", "state", "brand-memory-import");
/** What a stamped MEMORY.md held when it was emptied: later edits reached no store. */
const RETIRED_COPY = join(".magister", "state", "memory-md-retired");

const READ_TIMEOUT_MS = 3_000;
const WRITE_TIMEOUT_MS = 5_000;

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

function postOperation(operation: BrandMemoryOperation): Promise<Record<string, unknown>> {
  return callRuntimeGateway("marketing-context/rules", {
    method: "POST",
    body: operation,
    timeoutMs: WRITE_TIMEOUT_MS,
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
    await syncMarketingContext(workspaceDir).catch(() => undefined);
  }
  if (reply.ok !== true || !list) {
    return { success: false, target: "memory", message: String(reply.error) };
  }
  return { success: true, target: "memory", entries: list.entries, charCount: list.charCount };
}

/**
 * Empty MEMORY.md: always after access was revoked, otherwise only once its
 * entries reached the Gateway (the import stamp exists), since the file is then
 * a stale copy the agent could still read with its file tools. A file that was
 * never imported is left for the Gateway's one-time migration to read.
 */
export async function retireLegacyMemoryFile(
  workspaceDir: string,
  { revoked = false }: { revoked?: boolean } = {},
): Promise<void> {
  // Revocation still tries the clear when the Library admits this workspace,
  // through its legacy-write gate as the old sync did. That gate refuses in the
  // Library's active and recovery modes, where the cloud copy is authoritative.
  if (!revoked && (await admitWorkspaceFiles(workspaceDir))) {
    return;
  }
  if (!revoked && (await readUtf8IfExists(join(workspaceDir, IMPORT_STAMP))) === undefined) {
    return;
  }
  const path = join(workspaceDir, "MEMORY.md");
  await withContextLock(workspaceDir, async () => {
    await writeLegacyWorkspaceFile(workspaceDir, async () => {
      const current = (await readUtf8IfExists(path)) ?? "";
      if (current === "") {
        return;
      }
      // Revoked: the brand's notes must not outlive its access.
      if (!revoked) {
        const retired = join(workspaceDir, RETIRED_COPY);
        await atomicWriteFile(retired, `${(await readUtf8IfExists(retired)) ?? ""}${current}\n`);
      }
      await atomicWrite(path, "");
    });
  });
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
      // binding's cached knowledge.
      await atomicWriteFile(
        path,
        JSON.stringify({
          available: false,
          rendered:
            "Shared marketing context is unavailable because access was denied. Do not use prior cached brand memory.",
        }),
      );
      await retireLegacyMemoryFile(workspaceDir, { revoked: true });
      throw error;
    }
    let kept = false;
    const cached = await readUtf8IfExists(path);
    if (cached) {
      try {
        const previous: unknown = JSON.parse(cached);
        if (isRecord(previous) && typeof previous.rendered === "string") {
          await atomicWriteFile(path, JSON.stringify({ ...previous, stale: true }));
          kept = true;
        }
      } catch {
        // An unreadable cache cannot supply context.
      }
    }
    if (!kept) {
      // No last good context: say so, rather than let the turn run as if the
      // brand had no rules (an authoritative empty context renders nothing).
      await atomicWriteFile(
        path,
        JSON.stringify({
          available: false,
          stale: true,
          rendered:
            "Shared marketing context could not be loaded, so this brand's confirmed rules and learned style are missing from this turn. Do not guess brand preferences; say they could not be loaded when they matter.",
        }),
      );
    }
    throw error;
  }
}
