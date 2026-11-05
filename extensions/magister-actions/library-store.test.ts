import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digest, LibraryStore } from "./library-store.js";
import type { LibraryBridge, LibraryFile } from "./library-types.js";

const entry = (
  id: string,
  name: string,
  type: "file" | "directory",
  lifecycle: "active" | "trashed",
  sequence: number,
  text = "library bytes",
) =>
  ({
    project_id: "p",
    file_id: id,
    revision_id: `${id}-${sequence}`,
    path: name,
    entry_type: type,
    lifecycle,
    ownership: "user",
    sha256: digest(text),
    size: Buffer.byteLength(text),
    commit_sequence: sequence,
  }) as unknown as LibraryFile;

let workspace: string;
const local = (name: string) => path.join(workspace, name);
const put = async (name: string, text = "local") => {
  await fs.mkdir(path.dirname(local(name)), { recursive: true });
  await fs.writeFile(local(name), text);
};

/** A volume whose cache says `before` is installed, taking `after` as the next changeset. */
async function storeAt(before: LibraryFile[], after: LibraryFile[]): Promise<LibraryStore> {
  const bridge = {
    request: async (_method: string, endpoint: string, values: { revision_id?: string }) => {
      if (endpoint === "/read") {
        const file = after.find((candidate) => candidate.revision_id === values.revision_id)!;
        return { file, text: "library bytes", truncated: false };
      }
      return { files: after, sequence: 2, next_cursor: null, complete: true };
    },
  } as unknown as LibraryBridge;
  const store = new LibraryStore(workspace, bridge);
  await store.initialize();
  const files = Object.fromEntries(before.map((file) => [file.file_id, file]));
  await fs.writeFile(
    path.join(store.directory, "cache.json"),
    JSON.stringify({ project_id: "p", epoch: 1, sequence: 1, files }),
  );
  return store;
}

/** The install finished: no journal is left to replay on the next turn. */
async function installs(store: LibraryStore): Promise<void> {
  await store.reconcile("p", 1, 2);
  expect(await store.installing()).toBe(false);
  await expect(store.recover()).resolves.toBeUndefined();
  await expect(store.reconcile("p", 1, 2)).resolves.toMatchObject({ sequence: 2 });
}

async function displaced(store: LibraryStore, name: string): Promise<string> {
  const root = path.join(store.directory, "displaced");
  const [only, ...rest] = await fs.readdir(root);
  expect(rest).toEqual([]);
  return fs.readFile(path.join(root, only, name), "utf8");
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "library-store-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("a local-only entry never leaves an install stuck", () => {
  const folder = entry("d", "foo", "directory", "active", 1);
  const draft = entry("a", "foo/draft.md", "file", "active", 1);
  it("trashing a Library folder keeps what the migration left in it", async () => {
    await put("foo/draft.md", "library bytes");
    await put("foo/tmp/scratch.txt");
    await put("foo/node_modules/pkg/index.js");
    await put("foo/.DS_Store");
    await installs(
      await storeAt(
        [folder, draft],
        [
          entry("d", "foo", "directory", "trashed", 2),
          entry("a", "foo/draft.md", "file", "trashed", 2),
        ],
      ),
    );
    await expect(fs.stat(local("foo/draft.md"))).rejects.toThrow("ENOENT");
    expect(await fs.readFile(local("foo/tmp/scratch.txt"), "utf8")).toBe("local");
    expect(await fs.readFile(local("foo/node_modules/pkg/index.js"), "utf8")).toBe("local");
    expect(await fs.readFile(local("foo/.DS_Store"), "utf8")).toBe("local");
  });
  it("moving a Library folder keeps them where they were", async () => {
    await put("foo/draft.md", "library bytes");
    await put("foo/tmp/scratch.txt");
    await installs(
      await storeAt(
        [folder, draft],
        [
          entry("d", "resources/foo", "directory", "active", 2),
          entry("a", "resources/foo/draft.md", "file", "active", 2),
        ],
      ),
    );
    expect(await fs.readFile(local("foo/tmp/scratch.txt"), "utf8")).toBe("local");
    expect(await fs.readFile(local("resources/foo/draft.md"), "utf8")).toBe("library bytes");
    await expect(fs.stat(local("foo/draft.md"))).rejects.toThrow("ENOENT");
  });
  it("a Library file takes a path a kept local folder holds, moving the folder aside", async () => {
    await put("foo/draft.md", "library bytes");
    await put("foo/tmp/scratch.txt", "kept");
    const store = await storeAt(
      [folder, draft],
      [
        entry("d", "foo", "directory", "trashed", 2),
        entry("a", "foo/draft.md", "file", "trashed", 2),
        entry("f", "foo", "file", "active", 2),
      ],
    );
    await installs(store);
    expect(await fs.readFile(local("foo"), "utf8")).toBe("library bytes");
    expect(await displaced(store, "foo/tmp/scratch.txt")).toBe("kept");
  });
  it("a Library file lands below a local file, moving the file aside", async () => {
    await put("resources/temp", "kept");
    const store = await storeAt([], [entry("f", "resources/temp/brief.md", "file", "active", 2)]);
    await installs(store);
    expect(await fs.readFile(local("resources/temp/brief.md"), "utf8")).toBe("library bytes");
    expect(await displaced(store, "temp")).toBe("kept");
  });
  it("a Library folder takes a path a local file holds", async () => {
    await put("resources/temp", "kept");
    const store = await storeAt([], [entry("d", "resources/temp", "directory", "active", 2)]);
    await installs(store);
    expect((await fs.stat(local("resources/temp"))).isDirectory()).toBe(true);
    expect(await displaced(store, "temp")).toBe("kept");
  });
  it("removing an entry whose path now holds something else leaves that alone", async () => {
    await put("was-a-file/inside.txt");
    await put("was-a-folder");
    await put("gone-parent");
    await installs(
      await storeAt(
        [
          entry("a", "was-a-file", "file", "active", 1),
          entry("b", "was-a-folder", "directory", "active", 1),
          entry("c", "gone-parent/child.md", "file", "active", 1),
        ],
        [
          entry("a", "was-a-file", "file", "trashed", 2),
          entry("b", "was-a-folder", "directory", "trashed", 2),
          entry("c", "gone-parent/child.md", "file", "trashed", 2),
        ],
      ),
    );
    expect(await fs.readFile(local("was-a-file/inside.txt"), "utf8")).toBe("local");
    expect(await fs.readFile(local("was-a-folder"), "utf8")).toBe("local");
    expect(await fs.readFile(local("gone-parent"), "utf8")).toBe("local");
  });
  it("still refuses a link rather than following it", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "library-outside-"));
    try {
      await fs.symlink(outside, local("link"));
      const store = await storeAt([], [entry("f", "link/brief.md", "file", "active", 2)]);
      await expect(store.reconcile("p", 1, 2)).rejects.toThrow("symlink");
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

it("installs a file whose name is as long as the Library allows", async () => {
  const name = `resources/${"a".repeat(255)}`;
  await installs(await storeAt([], [entry("f", name, "file", "active", 2)]));
  expect(await fs.readFile(local(name), "utf8")).toBe("library bytes");
  expect((await fs.readdir(local("resources"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});
