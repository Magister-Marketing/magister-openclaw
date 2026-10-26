import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { scanMemoryContent } from "./threat-scan.js";

export const ENTRY_DELIMITER = "\n§\n";

export type MemoryTarget = "memory" | "user";

export type MemoryResult =
  | { success: true; target: MemoryTarget; entries: string[]; charCount: number }
  | { success: false; target: MemoryTarget; message: string };

export type UserMemoryStoreOptions = {
  memoryDir: string;
  charLimit?: number;
  mutationBoundary?: (content: string, write: () => Promise<void>) => Promise<void>;
};

const DEFAULT_USER_CHAR_LIMIT = 1375;

/**
 * Bounded curated memory about the user, persisted in USER.md.
 *
 * Ported from hermes-agent/tools/memory_tool.py (MemoryStore). Entries are
 * joined by the section-sign delimiter "\n§\n". All writes are atomic
 * (write+fsync+rename via a temp file in the same directory) so a crash
 * mid-write cannot truncate the canonical file. `add`/`replace` call
 * `scanMemoryContent` before persisting so adversarial payloads cannot land in
 * the next session's system prompt. MEMORY.md, the brand memory, lives on the
 * Gateway instead (brand-memory.ts), which applies the same rules.
 */
export class UserMemoryStore {
  private readonly path: string;
  private readonly limit: number;
  private entries: string[] = [];
  private readonly mutationBoundary?: UserMemoryStoreOptions["mutationBoundary"];

  constructor(opts: UserMemoryStoreOptions) {
    this.path = join(opts.memoryDir, "USER.md");
    this.limit = opts.charLimit ?? DEFAULT_USER_CHAR_LIMIT;
    this.mutationBoundary = opts.mutationBoundary;
  }

  async loadFromDisk(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.entries = dedupe(await readEntries(this.path));
  }

  list(): readonly string[] {
    return this.entries;
  }

  charCount(): number {
    if (this.entries.length === 0) {
      return 0;
    }
    const joined = this.entries.reduce((acc, e) => acc + e.length, 0);
    return joined + (this.entries.length - 1) * ENTRY_DELIMITER.length;
  }

  async add(content: string): Promise<MemoryResult> {
    const trimmed = content.trim();
    if (!trimmed) {
      return fail("Content cannot be empty");
    }

    const threat = scanMemoryContent(trimmed);
    if (threat) {
      return fail(`Blocked: ${threat}`);
    }

    if (this.entries.some((entry) => entry.trim() === trimmed)) {
      return fail("Entry already exists (duplicate)");
    }

    const additional = trimmed.length + (this.entries.length > 0 ? ENTRY_DELIMITER.length : 0);
    const newChars = this.charCount() + additional;

    if (newChars > this.limit) {
      return fail(
        `Char limit (${this.limit}) exceeded. Current ${this.charCount()}, would be ${newChars}. ` +
          `Use replace/remove to free space first.`,
      );
    }

    this.entries.push(trimmed);
    await this.persist();
    return this.ok();
  }

  async replace(oldText: string, newContent: string): Promise<MemoryResult> {
    const trimmedNew = newContent.trim();
    if (!trimmedNew) {
      return fail("Content cannot be empty");
    }

    const threat = scanMemoryContent(trimmedNew);
    if (threat) {
      return fail(`Blocked: ${threat}`);
    }

    const match = findUniqueMatch(this.entries, oldText);
    if (typeof match === "string") {
      return fail(match);
    }

    const original = this.entries[match];
    this.entries[match] = trimmedNew;

    if (this.charCount() > this.limit) {
      // Revert and reject.
      this.entries[match] = original;
      return fail(`Replace would exceed char limit (${this.limit})`);
    }

    await this.persist();
    return this.ok();
  }

  async remove(oldText: string): Promise<MemoryResult> {
    const match = findUniqueMatch(this.entries, oldText);
    if (typeof match === "string") {
      return fail(match);
    }
    this.entries.splice(match, 1);
    await this.persist();
    return this.ok();
  }

  private async persist(): Promise<void> {
    const content = this.entries.join(ENTRY_DELIMITER);
    if (this.mutationBoundary) {
      await this.mutationBoundary(content, () => atomicWrite(this.path, content));
    } else {
      await atomicWrite(this.path, content);
    }
  }

  private ok(): MemoryResult {
    return {
      success: true,
      target: "user",
      entries: [...this.entries],
      charCount: this.charCount(),
    };
  }
}

/** Split a memory file into its non-blank records, keeping their bytes. */
export function parseMemoryEntries(raw: string): string[] {
  if (!raw.trim()) {
    return [];
  }
  return raw.split(ENTRY_DELIMITER).filter((entry) => entry.trim().length > 0);
}

async function readEntries(path: string): Promise<string[]> {
  try {
    // Keep record bytes exactly as found. Only the record targeted by a tool
    // operation may change; gateway-owned and user-owned neighbors survive a
    // load/mutate/persist cycle byte-for-byte.
    return parseMemoryEntries(await readFile(path, "utf-8"));
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.mem_${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmp, "w");
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Returns the index of the single entry containing `needle`, or an error
 * message string when there are zero or multiple matches.
 */
function findUniqueMatch(entries: readonly string[], needle: string): number | string {
  let foundIdx = -1;
  let count = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].includes(needle)) {
      foundIdx = i;
      count++;
    }
  }
  if (count === 0) {
    return `No entry contains the substring '${needle}'`;
  }
  if (count > 1) {
    return `Substring '${needle}' matches ${count} entries — use a more unique substring`;
  }
  return foundIdx;
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of arr) {
    const identity = e.trim();
    if (identity && !seen.has(identity)) {
      seen.add(identity);
      out.push(e);
    }
  }
  return out;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

function fail(message: string): MemoryResult {
  return { success: false, target: "user", message };
}
