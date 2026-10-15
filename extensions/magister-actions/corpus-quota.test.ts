import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertCorpusPathQuotas, corpusStagingDir, directoryBytes } from "./corpus-quota.js";

const roots: string[] = [];
const locked: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magister-quota-"));
  roots.push(root);
  return root;
}

function write(file: string, bytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
}

/** A sandbox attempt directory this process cannot enter, as the supervisor
 *  leaves `attempts/<id>/home` (sandbox uid, 0700) for the upload process. */
function unreadableDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, "big.bin"), 4096);
  fs.chmodSync(dir, 0o000);
  locked.push(dir);
}

// root reads through mode 000, so the EACCES case cannot be produced as root.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

afterEach(() => {
  for (const dir of locked.splice(0)) {
    fs.chmodSync(dir, 0o700);
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("corpus quota inventory", () => {
  it.skipIf(asRoot)("skips an unreadable subdirectory and counts what it can read", async () => {
    const root = workspace();
    write(path.join(root, "a.bin"), 100);
    write(path.join(root, "nested", "b.bin"), 200);
    unreadableDir(path.join(root, "nested", "locked"));

    await expect(directoryBytes(root)).resolves.toBe(300);
  });

  it.skipIf(asRoot)("ignores sandbox attempt scratch when admitting an upload", async () => {
    const root = workspace();
    unreadableDir(path.join(root, ".magister", "tmp", "attempts", "a1", "home"));
    // Readable attempt scratch over the corpus scratch quota is the supervisor's
    // to cap, not a reason to refuse an upload.
    write(
      path.join(root, ".magister", "tmp", "attempts", "a2", "promote", "x.bin"),
      2 * 1024 * 1024,
    );

    await expect(
      assertCorpusPathQuotas({
        workspace: root,
        destination: path.join(root, "resources", "upload.txt"),
        sourceBytes: 10,
        sha256: "0".repeat(64),
        extract: false,
        env: { MAGISTER_CORPUS_SCRATCH_QUOTA_BYTES: String(1024 * 1024) },
      }),
    ).resolves.toBeUndefined();
  });

  it("still counts staged ingest files against the scratch quota", async () => {
    const root = workspace();
    write(path.join(corpusStagingDir(root), "stale.part"), 2 * 1024 * 1024);

    await expect(directoryBytes(corpusStagingDir(root))).resolves.toBe(2 * 1024 * 1024);
    await expect(
      assertCorpusPathQuotas({
        workspace: root,
        destination: path.join(root, "resources", "upload.txt"),
        sourceBytes: 10,
        sha256: "0".repeat(64),
        extract: false,
        env: { MAGISTER_CORPUS_SCRATCH_QUOTA_BYTES: String(1024 * 1024) },
      }),
    ).rejects.toMatchObject({ message: "project scratch quota is exhausted", statusCode: 507 });
  });

  it("still refuses an upload over the source-file quota", async () => {
    const root = workspace();
    write(path.join(root, "resources", "existing.bin"), 1024 * 1024);

    await expect(
      assertCorpusPathQuotas({
        workspace: root,
        destination: path.join(root, "resources", "upload.txt"),
        sourceBytes: 512 * 1024,
        sha256: "0".repeat(64),
        extract: false,
        env: { MAGISTER_CORPUS_SOURCE_QUOTA_BYTES: String(1024 * 1024) },
      }),
    ).rejects.toMatchObject({
      message: "project source-file quota would be exceeded",
      statusCode: 507,
    });
  });
});
