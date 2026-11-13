import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

/** SQLite's OS locks supply real cross-process readers/writer exclusion and
 * release on process death. No stale-PID timeout can steal a live writer. This
 * database deliberately uses rollback journaling: WAL permits concurrent reads. */
export async function withLibraryLock<T>(
  directory: string,
  mode: "shared" | "exclusive",
  run: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, "lock.sqlite"));
  const deadline = Date.now() + timeoutMs;
  let held = false;
  const retry = async (fn: () => void) => {
    while (true) {
      try {
        fn();
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/database (?:is )?(?:locked|busy)/i.test(error.message))
          throw error;
        if (Date.now() >= deadline)
          throw new Error("temporarily_unavailable: Library lock timed out");
        await pause();
      }
    }
  };
  try {
    db.exec("PRAGMA busy_timeout=0");
    await retry(() => db.exec("CREATE TABLE IF NOT EXISTS lock_v1 (id INTEGER PRIMARY KEY)"));
    await retry(() => {
      try {
        db.exec(mode === "exclusive" ? "BEGIN EXCLUSIVE" : "BEGIN");
        db.prepare("SELECT id FROM lock_v1 LIMIT 1").get();
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* BEGIN may itself have failed. */
        }
        throw error;
      }
    });
    held = true;
    return await run();
  } finally {
    if (held) db.exec("ROLLBACK");
    db.close();
  }
}
