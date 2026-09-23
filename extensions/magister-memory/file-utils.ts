import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.magister_${randomBytes(8).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "w", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    try {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close().catch(() => undefined);
      }
    } catch {
      // Best-effort: some platforms and filesystems do not support syncing directories.
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function readUtf8IfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readJsonIfExists(path: string): Promise<unknown> {
  const raw = await readUtf8IfExists(path);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
