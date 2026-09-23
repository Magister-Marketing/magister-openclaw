import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { scanMemoryContent } from "./threat-scan.js";

export const ENTRY_DELIMITER = "\n§\n";

export type MemoryTarget = "memory" | "user";

export type MemoryResult =
  | { success: true; target: MemoryTarget; entries: string[]; charCount: number }
  | { success: false; target: MemoryTarget; message: string };

export type MemoryStoreOptions = {
  memoryDir: string;
  memoryCharLimit?: number;
  userCharLimit?: number;
  mutationBoundary?: (
    target: MemoryTarget,
    content: string,
    write: () => Promise<void>,
  ) => Promise<void>;
};

const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;

/**
 * Bounded curated memory with file persistence.
 *
 * Ported from hermes-agent/tools/memory_tool.py (MemoryStore). Two parallel files:
 * MEMORY.md (project knowledge) and USER.md (user profile). Entries are joined by
 * the section-sign delimiter "\n§\n". All writes are atomic (write+fsync+rename
 * via a temp file in the same directory) so a crash mid-write cannot truncate
 * the canonical file. Tool-mediated writes go through `add`/`replace`/`remove`,
 * each of which calls `scanMemoryContent` before persisting so adversarial
 * payloads cannot land in the next session's system prompt.
 */
export class MemoryStore {
  private readonly memoryDir: string;
  private readonly limits: Record<MemoryTarget, number>;
  private entries: Record<MemoryTarget, string[]> = { memory: [], user: [] };
  private readonly mutationBoundary?: MemoryStoreOptions["mutationBoundary"];

  constructor(opts: MemoryStoreOptions) {
    this.memoryDir = opts.memoryDir;
    this.limits = {
      memory: opts.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT,
      user: opts.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT,
    };
    this.mutationBoundary = opts.mutationBoundary;
  }

  async loadFromDisk(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    this.entries.memory = dedupe(await readEntries(join(this.memoryDir, "MEMORY.md")));
    this.entries.user = dedupe(await readEntries(join(this.memoryDir, "USER.md")));
  }

  entriesFor(target: MemoryTarget): readonly string[] {
    return this.entries[target];
  }

  charCount(target: MemoryTarget): number {
    const list = this.entries[target];
    if (list.length === 0) {
      return 0;
    }
    const joined = list.reduce((acc, e) => acc + e.length, 0);
    return joined + (list.length - 1) * ENTRY_DELIMITER.length;
  }

  charLimit(target: MemoryTarget): number {
    return this.limits[target];
  }

  async add(target: MemoryTarget, content: string): Promise<MemoryResult> {
    const trimmed = content.trim();
    if (!trimmed) {
      return fail(target, "Content cannot be empty");
    }

    const threat = scanMemoryContent(trimmed);
    if (threat) {
      return fail(target, `Blocked: ${threat}`);
    }

    if (this.entries[target].some((entry) => entry.trim() === trimmed)) {
      return fail(target, "Entry already exists (duplicate)");
    }

    const additional =
      trimmed.length + (this.entries[target].length > 0 ? ENTRY_DELIMITER.length : 0);
    const newChars = this.charCount(target) + additional;

    if (newChars > this.limits[target]) {
      return fail(
        target,
        `Char limit (${this.limits[target]}) exceeded. Current ${this.charCount(target)}, would be ${newChars}. ` +
          `Use replace/remove to free space first.`,
      );
    }

    this.entries[target].push(trimmed);
    await this.persist(target);
    return ok(target, this.entries[target], this.charCount(target));
  }

  async replace(target: MemoryTarget, oldText: string, newContent: string): Promise<MemoryResult> {
    const trimmedNew = newContent.trim();
    if (!trimmedNew) {
      return fail(target, "Content cannot be empty");
    }

    const threat = scanMemoryContent(trimmedNew);
    if (threat) {
      return fail(target, `Blocked: ${threat}`);
    }

    const match = findUniqueMatch(this.entries[target], oldText);
    if (typeof match === "string") {
      return fail(target, match);
    }

    const original = this.entries[target][match];
    this.entries[target][match] = trimmedNew;

    if (this.charCount(target) > this.limits[target]) {
      // Revert and reject.
      this.entries[target][match] = original;
      return fail(target, `Replace would exceed char limit (${this.limits[target]})`);
    }

    await this.persist(target);
    return ok(target, this.entries[target], this.charCount(target));
  }

  async remove(target: MemoryTarget, oldText: string): Promise<MemoryResult> {
    const match = findUniqueMatch(this.entries[target], oldText);
    if (typeof match === "string") {
      return fail(target, match);
    }
    this.entries[target].splice(match, 1);
    await this.persist(target);
    return ok(target, this.entries[target], this.charCount(target));
  }

  private async persist(target: MemoryTarget): Promise<void> {
    const path = join(this.memoryDir, target === "memory" ? "MEMORY.md" : "USER.md");
    const content = this.entries[target].join(ENTRY_DELIMITER);
    if (this.mutationBoundary) {
      await this.mutationBoundary(target, content, () => atomicWrite(path, content));
    } else {
      await atomicWrite(path, content);
    }
  }
}

async function readEntries(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf-8");
    if (!raw.trim()) {
      return [];
    }
    // Keep record bytes exactly as found. Only the record targeted by a tool
    // operation may change; gateway-owned and user-owned neighbors survive a
    // load/mutate/persist cycle byte-for-byte.
    return raw.split(ENTRY_DELIMITER).filter((entry) => entry.trim().length > 0);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
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

function fail(target: MemoryTarget, message: string): MemoryResult {
  return { success: false, target, message };
}

function ok(target: MemoryTarget, entries: string[], charCount: number): MemoryResult {
  return { success: true, target, entries: [...entries], charCount };
}
