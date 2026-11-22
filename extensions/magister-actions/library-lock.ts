import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type LockMode = "shared" | "exclusive";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 15));
const timedOut = () => new Error("temporarily_unavailable: Library lock timed out");

/** Waiters of this process for one lock, first come, first served. SQLite's
 * lock has no queue: a writer polling every 15 ms gives up all its locks
 * between tries, so readers that overlap one another kept it out for good. On
 * 2026-11-22 sixteen tasks started at once on one brand, and turns, tool calls
 * and checkpoints failed with "Library lock timed out" for twenty minutes. A
 * waiting writer now stops later readers, and readers ahead of it finish. */
type Waiter = { mode: LockMode; grant: () => void };
type Gate = { readers: number; writer: boolean; queue: Waiter[] };
const gates = new Map<string, Gate>();

function pump(key: string, gate: Gate): void {
  while (gate.queue.length > 0) {
    const next = gate.queue[0];
    const fits = next.mode === "shared" ? !gate.writer : !gate.writer && gate.readers === 0;
    if (!fits) {
      break;
    }
    gate.queue.shift();
    if (next.mode === "shared") {
      gate.readers += 1;
    } else {
      gate.writer = true;
    }
    next.grant();
  }
  if (gate.readers === 0 && !gate.writer && gate.queue.length === 0) {
    gates.delete(key);
  }
}

async function enter(key: string, mode: LockMode, deadline: number): Promise<() => void> {
  let gate = gates.get(key);
  if (!gate) {
    gate = { readers: 0, writer: false, queue: [] };
    gates.set(key, gate);
  }
  const entered = gate;
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      mode,
      grant: () => {
        clearTimeout(timer);
        resolve();
      },
    };
    const timer = setTimeout(
      () => {
        const index = entered.queue.indexOf(waiter);
        if (index < 0) {
          return;
        }
        entered.queue.splice(index, 1);
        pump(key, entered);
        reject(timedOut());
      },
      Math.max(0, deadline - Date.now()),
    );
    timer.unref?.();
    entered.queue.push(waiter);
    pump(key, entered);
  });
  let left = false;
  return () => {
    if (left) {
      return;
    }
    left = true;
    if (mode === "shared") {
      entered.readers -= 1;
    } else {
      entered.writer = false;
    }
    pump(key, entered);
  };
}

/** The locks the current task holds, so a nested call does not queue behind
 * itself. A hold ends only once nested work started under it has finished,
 * so work left running cannot overlap the next holder. */
type Held = { mode: LockMode; released: boolean; nested: Set<Promise<unknown>> };
const holding = new AsyncLocalStorage<Map<string, Held>>();

/** Run `fn` as if no Library lock were held: work that serves other callers
 * (a shared admission) must not inherit the hold of whoever started it. */
export function outsideLibraryHold<T>(fn: () => T): T {
  return holding.exit(fn);
}

/** SQLite's OS locks supply real cross-process readers/writer exclusion and
 * release on process death (the context materializer takes the same lock). No
 * stale-PID timeout can steal a live writer. This database deliberately uses
 * rollback journaling: WAL permits concurrent reads. */
export async function withLibraryLock<T>(
  directory: string,
  mode: LockMode,
  run: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const key = path.resolve(directory);
  const current = holding.getStore()?.get(key);
  if (current && !current.released) {
    // A task already inside the lock runs nested work under it: a shared hold
    // covers reads, an exclusive one covers everything.
    if (current.mode === "exclusive" || mode === "shared") {
      const nested = (async () => run())();
      current.nested.add(nested);
      const forget = () => current.nested.delete(nested);
      nested.then(forget, forget);
      return nested;
    }
    // Upgrading would wait for this task's own read to end: it never can.
    throw new Error("temporarily_unavailable: Library lock is held for reading by this task");
  }
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const leave = await enter(key, mode, deadline);
  let db: DatabaseSync | undefined;
  let held = false;
  try {
    db = new DatabaseSync(path.join(directory, "lock.sqlite"));
    const sqlite = db;
    const retry = async (fn: () => void) => {
      while (true) {
        try {
          fn();
          return;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/database (?:is )?(?:locked|busy)/i.test(error.message)
          ) {
            throw error;
          }
          if (Date.now() >= deadline) {
            throw timedOut();
          }
          await pause();
        }
      }
    };
    sqlite.exec("PRAGMA busy_timeout=0");
    await retry(() => sqlite.exec("CREATE TABLE IF NOT EXISTS lock_v1 (id INTEGER PRIMARY KEY)"));
    await retry(() => {
      try {
        sqlite.exec(mode === "exclusive" ? "BEGIN EXCLUSIVE" : "BEGIN");
        sqlite.prepare("SELECT id FROM lock_v1 LIMIT 1").get();
      } catch (error) {
        try {
          sqlite.exec("ROLLBACK");
        } catch {
          /* BEGIN may itself have failed. */
        }
        throw error;
      }
    });
    held = true;
    const marker: Held = { mode, released: false, nested: new Set() };
    const scope = new Map(holding.getStore() ?? []);
    scope.set(key, marker);
    try {
      return await holding.run(scope, run);
    } finally {
      while (marker.nested.size > 0) {
        await Promise.allSettled(marker.nested);
      }
      marker.released = true;
    }
  } finally {
    // The queue slot is freed whatever SQLite does: a leaked slot would block
    // this lock for the rest of the process.
    try {
      if (held) {
        db?.exec("ROLLBACK");
      }
    } finally {
      try {
        db?.close();
      } finally {
        leave();
      }
    }
  }
}
