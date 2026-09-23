import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteFile } from "./file-utils.js";

describe("atomicWriteFile", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it.runIf(process.platform !== "win32")(
    "keeps a completed write when directory sync is unsupported",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "magister-atomic-write-"));
      temporaryDirectories.push(directory);
      const probe = await open(join(directory, "probe"), "w");
      const prototype = Object.getPrototypeOf(probe) as {
        sync: (this: typeof probe) => Promise<void>;
      };
      const originalSync = prototype.sync;
      await probe.close();
      let syncCalls = 0;
      vi.spyOn(prototype, "sync").mockImplementation(async function (this: typeof probe) {
        syncCalls += 1;
        if (syncCalls === 2) {
          throw Object.assign(new Error("directory sync unsupported"), { code: "EINVAL" });
        }
        await originalSync.call(this);
      });

      const target = join(directory, "state.json");
      await expect(atomicWriteFile(target, '{"saved":true}\n')).resolves.toBeUndefined();

      expect(await readFile(target, "utf8")).toBe('{"saved":true}\n');
      expect(syncCalls).toBe(2);
    },
  );
});
