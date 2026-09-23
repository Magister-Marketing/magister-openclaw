import fs from "node:fs/promises";

/**
 * Resolve the task text that skill routing should key on for this run.
 *
 * Task-selected skill hints render inside the system prompt, and the system
 * prompt is the cached request prefix. Keying the selection on each turn's own
 * prompt made the `<available_skills>` block flap between turns whenever one
 * turn's wording happened to match a different skill description — and on the
 * OpenAI Responses route a system prompt that changes anywhere forfeits the
 * entire prompt cache, not just the tail (probes 2026-08-31: a single
 * ~300-char hint toggle at 97% depth read back as `cached_tokens = 0`).
 *
 * Key the selection on the session's FIRST user message instead: the hints
 * stay byte-stable for the whole session, and per-turn discovery still has the
 * skill catalog and the on-demand skill index. The first turn has no session
 * file yet, so it keys on its own prompt — which IS the first user message —
 * and every later turn re-derives the same text from the session file.
 */
const MAX_SCAN_BYTES = 512 * 1024;
const MAX_TASK_TEXT_CHARS = 16_000;

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const trimmed = record.text.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export async function resolveSessionStableTaskText(params: {
  sessionFile?: string;
  currentPrompt?: string;
}): Promise<string | undefined> {
  if (params.currentPrompt === undefined) {
    // No task text means the caller wants the full routed state prompt, not
    // task selection. Preserve that path untouched.
    return undefined;
  }
  if (!params.sessionFile) {
    return params.currentPrompt;
  }
  let scanned: string;
  try {
    const handle = await fs.open(params.sessionFile, "r");
    try {
      const buffer = Buffer.alloc(MAX_SCAN_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_SCAN_BYTES, 0);
      scanned = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    // Missing file is the first turn of a fresh session.
    return params.currentPrompt;
  }
  for (const line of scanned.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // The byte cap can truncate the final line; malformed lines are skipped.
      continue;
    }
    const message = (parsed as Record<string, unknown> | null)?.message as
      | Record<string, unknown>
      | undefined;
    if (!message || message.role !== "user") {
      continue;
    }
    // Scan forward to the first user message that carries text, so an
    // image-only opener cannot make every turn fall back to its own prompt
    // (which would reintroduce the per-turn flap).
    const text = extractMessageText(message.content);
    if (text) {
      return text.slice(0, MAX_TASK_TEXT_CHARS);
    }
  }
  return params.currentPrompt;
}
