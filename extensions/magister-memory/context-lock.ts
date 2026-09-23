import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 15_000;

type LockOwner = {
  created_at: number;
  pid: number;
  token: string;
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function processAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as LockOwner;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function recoverStaleLock(path: string): Promise<void> {
  let lockStat;
  try {
    lockStat = await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs <= LOCK_STALE_MS) {
    return;
  }
  const owner = await readOwner(path);
  if (processAlive(owner?.pid)) {
    return;
  }

  const stale = `${path}.stale-${randomBytes(8).toString("hex")}`;
  try {
    await rename(path, stale);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await rm(stale, { recursive: true, force: true });
  await fsyncDirectory(dirname(path));
}

async function releaseContextLock(lockPath: string, token: string): Promise<void> {
  const owner = await readOwner(lockPath);
  if (owner?.token !== token) {
    throw new Error("context lock ownership changed");
  }
  await unlink(join(lockPath, "owner.json"));
  await rmdir(lockPath);
  await fsyncDirectory(dirname(lockPath));
}

export async function withContextLock<T>(
  workspaceDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = join(workspaceDir, ".magister", "locks", "context.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ created_at: Date.now() / 1000, pid: process.pid, token })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      break;
    } catch (error) {
      if (created) {
        await rm(lockPath, { recursive: true, force: true });
        await fsyncDirectory(dirname(lockPath));
      }
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
      await recoverStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for context lock", { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await action() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let releaseFailure: { error: unknown } | undefined;
  try {
    await releaseContextLock(lockPath, token);
  } catch (error) {
    releaseFailure = { error };
  }

  if (!outcome.ok) {
    if (releaseFailure) {
      throw new AggregateError(
        [outcome.error, releaseFailure.error],
        "context action and lock release both failed",
      );
    }
    throw outcome.error;
  }
  if (releaseFailure) {
    throw releaseFailure.error;
  }
  return outcome.value;
}
