import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LibraryHttpError } from "./library-bridge.js";
import type { LibraryBridge, LibraryCache, LibraryFile } from "./library-types.js";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(
  file: string,
  value: string | Buffer,
  mode = 0o600,
  directoryMode = 0o700,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: directoryMode });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function expandLibraryToolPath(input: string): string {
  const value = input.startsWith("@") ? input.slice(1) : input;
  return value === "~"
    ? os.homedir()
    : value.startsWith("~/")
      ? os.homedir() + value.slice(1)
      : value;
}

/** Resolve existing parents too, so a new file below a symlink cannot bypass
 * ownership routing merely because its leaf does not exist yet. */
export async function resolveLibraryToolTarget(absolute: string): Promise<string> {
  let current = absolute;
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await fs.realpath(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function libraryRelative(workspace: string, input: string): string | undefined {
  input = expandLibraryToolPath(input);
  while (input.startsWith("./")) input = input.slice(2);
  if (input === ".") return undefined; // Ordinary directory reads may name cwd.
  if (!input || input.includes("\0") || input.includes("\\")) throw new Error("invalid_path");
  // Check original segments before resolve() can erase traversal.
  if (input.split("/").some((piece) => piece === ".." || piece === "."))
    throw new Error("invalid_path");
  const relative = path.isAbsolute(input) ? path.relative(workspace, input) : input;
  if (!relative) return undefined;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
  if (relative.split("/").some((piece) => !piece)) throw new Error("invalid_path");
  return relative;
}

/** All managed I/O rejects symlinked parents and non-regular leaves. */
export async function safeLibraryPath(workspace: string, relative: string): Promise<string> {
  if (libraryRelative(workspace, relative) !== relative) throw new Error("invalid_path");
  let current = workspace;
  const pieces = relative.split("/");
  for (let index = -1; index < pieces.length; index++) {
    if (index >= 0) current = path.join(current, pieces[index]);
    const stat = await fs.lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) continue;
    if (
      stat.isSymbolicLink() ||
      (!stat.isFile() && !stat.isDirectory()) ||
      (index < pieces.length - 1 && !stat.isDirectory()) ||
      (stat.isFile() && stat.nlink !== 1)
    )
      throw new Error("invalid_path: symlink, hard link or unsupported filesystem entry");
  }
  return current;
}

type InstallJournal = { previous: LibraryCache; next: LibraryCache };
type ManifestPage = {
  files: LibraryFile[];
  sequence: number;
  next_cursor?: string | null;
  complete: boolean;
};

const invalidSequence = (error: unknown) =>
  error instanceof LibraryHttpError &&
  JSON.stringify(error.body ?? "").includes("invalid_sequence");

export class LibraryStore {
  readonly directory: string;
  /** Catch-up runs under the exclusive Library lock, which turn admission and
   * every Library tool wait on for at most 30 s (library-lock.ts), and the
   * Gateway's admission call gives up at 30 s (library_runtime.py). Downloads
   * therefore stop after this budget and admission answers publication_pending;
   * objects are immutable per revision, so the next attempt resumes where this
   * one stopped. The lock is held for this budget plus the local install. */
  catchUpBudgetMs = 20_000;
  downloadConcurrency = 4;
  constructor(
    readonly workspace: string,
    readonly bridge: LibraryBridge,
  ) {
    this.directory = path.join(workspace, ".magister", "library-v1");
  }
  async initialize(): Promise<void> {
    await safeLibraryPath(this.workspace, ".magister/library-v1");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  cache(): Promise<LibraryCache | undefined> {
    return readJson(path.join(this.directory, "cache.json"));
  }
  async installing(): Promise<boolean> {
    return !!(await readJson(path.join(this.directory, "install.json")));
  }
  object(file: LibraryFile): string {
    return path.join(this.directory, "objects", digest(file.revision_id));
  }
  async seedObject(file: LibraryFile, bytes: Buffer): Promise<void> {
    if (
      file.entry_type !== "file" ||
      bytes.byteLength !== file.size ||
      digest(bytes) !== file.sha256
    )
      throw new Error("Library committed bytes did not match their receipt");
    await atomicWrite(this.object(file), bytes);
  }
  async ensureObject(file: LibraryFile): Promise<void> {
    if (file.entry_type !== "file" || file.lifecycle !== "active") return;
    const existing = await fs.readFile(this.object(file)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && existing.byteLength === file.size && digest(existing) === file.sha256) return;
    const result = await this.bridge.request<{
      file: LibraryFile;
      text?: string;
      download_url?: string;
      truncated?: boolean;
    }>("GET", "/read", {
      project_id: file.project_id,
      ref: file.file_id,
      revision_id: file.revision_id,
    });
    if (result.file.revision_id !== file.revision_id) throw new Error("Library revision mismatch");
    const bytes = result.download_url
      ? await this.bridge.download(result.download_url)
      : typeof result.text === "string" && !result.truncated
        ? Buffer.from(result.text)
        : undefined;
    if (!bytes || bytes.byteLength !== file.size || digest(bytes) !== file.sha256)
      throw new Error("Library immutable content verification failed");
    await atomicWrite(this.object(file), bytes);
  }
  async text(file: LibraryFile): Promise<string> {
    await this.ensureObject(file);
    const bytes = await fs.readFile(this.object(file));
    if (bytes.byteLength > 1024 * 1024)
      throw new Error("limit_exceeded: edit supports at most 1 MiB");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  async recover(): Promise<void> {
    const pending = await readJson<InstallJournal>(path.join(this.directory, "install.json"));
    if (pending) await this.install(pending);
  }
  async reconcile(projectId: string, epoch: number, through: number): Promise<LibraryCache> {
    await this.recover();
    const saved = await this.cache();
    const previous = saved ?? { project_id: projectId, epoch, sequence: 0, files: {} };
    if (previous.project_id !== projectId)
      throw new Error("Library project changed on this workspace");
    if (previous.epoch > epoch) throw new Error("Library epoch regressed");
    if (saved && previous.sequence >= through && previous.epoch === epoch) return previous;
    const deadline = Date.now() + this.catchUpBudgetMs;
    // A new epoch (reset, restore) restarts history: an old cursor cannot be
    // continued, and files from the previous epoch must not survive the install.
    const incremental = !!saved && previous.epoch === epoch;
    let files: Record<string, LibraryFile>;
    try {
      files = await this.manifest(projectId, through, incremental ? previous : undefined);
    } catch (error) {
      if (!incremental || !invalidSequence(error)) throw error;
      files = await this.manifest(projectId, through);
    }
    await this.prefetch(Object.values(files), deadline);
    const next: LibraryCache = { project_id: projectId, epoch, sequence: through, files };
    // Journal + downloaded immutable objects are durable before touching live files.
    const journal = { previous, next };
    await atomicWrite(path.join(this.directory, "install.json"), JSON.stringify(journal));
    await this.install(journal);
    return next;
  }
  /** Every Library entry through `through`, listed from the cloud (no
   * downloads). Recovery uses it because a replaced volume's cache is empty. */
  listed(projectId: string, through: number): Promise<Record<string, LibraryFile>> {
    return this.manifest(projectId, through);
  }
  /** Heads through `through`: a snapshot, or `since`'s heads plus every later
   * revision. Pages are ordered by commit, so the last entry per file wins and
   * intermediate revisions are never downloaded. */
  private async manifest(
    projectId: string,
    through: number,
    since?: LibraryCache,
  ): Promise<Record<string, LibraryFile>> {
    const files: Record<string, LibraryFile> = { ...since?.files };
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.bridge.request<ManifestPage>("GET", "/manifest", {
        project_id: projectId,
        since_sequence: since?.sequence,
        through_sequence: through,
        cursor,
        limit: 1000,
      });
      if (!Array.isArray(page.files) || page.sequence > through)
        throw new Error("Invalid Library manifest watermark");
      for (const file of page.files) {
        if (file.project_id !== projectId || !file.file_id || !file.revision_id)
          throw new Error("Invalid Library manifest identity");
        await safeLibraryPath(this.workspace, file.path);
        if (file.path.startsWith(".magister/") || file.path.startsWith(".openclaw/"))
          throw new Error("Reserved Library materialization path");
        files[file.file_id] = file;
      }
      cursor = page.next_cursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Library manifest cursor did not advance");
      if (cursor) cursors.add(cursor);
      if (!cursor && !page.complete) throw new Error("Incomplete Library manifest");
    } while (cursor);
    return files;
  }
  /** Download missing heads in parallel until the deadline. Downloads already
   * in flight finish in the background: each writes a verified immutable
   * object atomically, so they are progress for the next attempt, never state. */
  private async prefetch(files: LibraryFile[], deadline: number): Promise<void> {
    const queue = files.filter((file) => file.entry_type === "file" && file.lifecycle === "active");
    let index = 0;
    let expired = false;
    const worker = async () => {
      while (index < queue.length) {
        if (Date.now() >= deadline) {
          expired = true;
          return;
        }
        await this.ensureObject(queue[index++]);
      }
    };
    const pool = Promise.all(
      Array.from({ length: Math.min(this.downloadConcurrency, queue.length) }, worker),
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), Math.max(0, deadline - Date.now()));
    });
    try {
      const outcome = await Promise.race([pool, timeout]);
      if (outcome === "expired" || expired) {
        pool.catch(() => {}); // A late failure is retried by the next catch-up.
        throw new Error(
          "publication_pending: the agent's local Library copy is still downloading; retry shortly",
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
  private async install({ previous, next }: InstallJournal): Promise<void> {
    const current = await this.cache();
    // Sequences restart with each epoch, so only compare them within one.
    if (
      current &&
      (current.epoch > next.epoch ||
        (current.epoch === next.epoch && current.sequence > next.sequence))
    )
      throw new Error("Refusing stale Library materialization journal");
    const active = Object.values(next.files).filter((file) => file.lifecycle === "active");
    const retained = new Map(active.map((file) => [file.path, file.entry_type]));
    const removed = Object.values(previous.files)
      .filter((file) => file.lifecycle === "active" && retained.get(file.path) !== file.entry_type)
      .sort((left, right) => right.path.length - left.path.length);
    for (const file of removed) {
      const target = await safeLibraryPath(this.workspace, file.path);
      if (file.entry_type === "directory") {
        await fs.rmdir(target).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      } else await fs.rm(target, { force: true });
    }
    const desiredDirectories = new Set<string>();
    for (const file of active) {
      if (file.entry_type === "directory") desiredDirectories.add(file.path);
      for (let parent = path.dirname(file.path); parent !== "."; parent = path.dirname(parent))
        desiredDirectories.add(parent);
    }
    const oldParents = new Set<string>();
    for (const file of removed)
      for (let parent = path.dirname(file.path); parent !== "."; parent = path.dirname(parent))
        oldParents.add(parent);
    for (const parent of [...oldParents].sort((a, b) => b.length - a.length)) {
      if (desiredDirectories.has(parent)) continue;
      await fs.rmdir(await safeLibraryPath(this.workspace, parent)).catch((error) => {
        if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      });
    }
    for (const file of active.sort((left, right) => left.path.length - right.path.length)) {
      const old = previous.files[file.file_id];
      // Only changed immutable heads need filesystem I/O. Scanning every byte
      // in a warm project on each write makes latency grow with its Library.
      if (
        old?.revision_id === file.revision_id &&
        old.path === file.path &&
        old.lifecycle === "active"
      )
        continue;
      const target = await safeLibraryPath(this.workspace, file.path);
      if (file.entry_type === "directory") {
        await fs.mkdir(target, { recursive: true, mode: 0o755 });
        continue;
      }
      // Files are projections. Tools and sandbox may read; mutation goes through authority.
      await atomicWrite(target, await fs.readFile(this.object(file)), 0o644, 0o755);
    }
    await atomicWrite(path.join(this.directory, "cache.json"), JSON.stringify(next));
    await fs.rm(path.join(this.directory, "install.json"), { force: true });
    await syncDirectory(this.directory);
  }
}
