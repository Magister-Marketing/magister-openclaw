import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadTool, createWriteTool, createEditTool } from "@mariozechner/pi-coding-agent";
import type {
  AnyAgentTool,
  WorkspaceFileAuthorityContext,
  WorkspacePatchPlan,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryHttpError } from "./library-bridge.js";
import { withLibraryLock } from "./library-lock.js";
import { LibraryRuntime } from "./library-runtime.js";
import { digest } from "./library-store.js";
import type {
  LibraryBridge,
  LibraryCommit,
  LibraryFile,
  LibraryReceipt,
  LibraryState,
} from "./library-types.js";

class Gateway implements LibraryBridge {
  state: LibraryState = {
    project_id: "project",
    mode: "active",
    epoch: 1,
    sequence: 0,
    publication: { pending: 0, failed: 0 },
    coverage: { complete: true, pending_sources: [] },
  };
  revisions: Array<LibraryFile & { text: string; sequence: number }> = [];
  receipts = new Map<string, LibraryReceipt>();
  commits: LibraryCommit[] = [];
  uploads = new Map<string, { text?: string; verified: boolean }>();
  unavailable = false;
  loseCommitReply = false;
  counter = 0;
  put(name: string, text: string, ownership: "user" | "managed" = "user"): LibraryFile {
    const old = this.heads().find((file) => file.path === name);
    const file = {
      file_id: old?.file_id ?? `file-${++this.counter}`,
      revision_id: `revision-${++this.counter}`,
      project_id: "project",
      path: name,
      entry_type: "file" as const,
      ownership,
      lifecycle: "active" as const,
      size: Buffer.byteLength(text),
      sha256: digest(text),
      text,
      sequence: ++this.state.sequence,
    };
    this.revisions.push(file);
    return file;
  }
  heads(through = this.state.sequence) {
    const map = new Map<string, (typeof this.revisions)[number]>();
    for (const file of this.revisions) if (file.sequence <= through) map.set(file.file_id, file);
    return [...map.values()];
  }
  request = async <T>(
    method: "GET" | "POST",
    endpoint: string,
    values: Record<string, unknown> = {},
  ): Promise<T> => {
    if (this.unavailable) throw new LibraryHttpError(503, {});
    if (endpoint === "/state" || endpoint === "/context-ready")
      return structuredClone(this.state) as T;
    if (endpoint === "/capabilities") return {} as T;
    if (endpoint === "/legacy-writes") return { lease_id: "legacy-lease" } as T;
    if (endpoint === "/legacy-writes/legacy-lease/complete") return {} as T;
    if (endpoint === "/uploads") {
      const id = String(values.operation_id);
      const upload = this.uploads.get(id) ?? { verified: false };
      this.uploads.set(id, upload);
      return { upload_id: id, upload_url: id, verified: upload.verified } as T;
    }
    if (endpoint.startsWith("/uploads/") && endpoint.endsWith("/finalize")) {
      this.uploads.get(endpoint.slice(9, -9))!.verified = true;
      return { verified: true } as T;
    }
    if (endpoint === "/manifest")
      return {
        files: this.heads(Number(values.through_sequence)),
        sequence: values.through_sequence,
        complete: true,
      } as T;
    if (endpoint === "/read") {
      const file = this.revisions.find((file) => file.revision_id === values.revision_id);
      if (!file) throw new Error("missing revision");
      return { file, text: file.text, truncated: false } as T;
    }
    if (method !== "POST" || endpoint !== "/commit")
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    const request = structuredClone(values) as LibraryCommit;
    const saved = this.receipts.get(request.operation_id);
    if (saved) return saved as T;
    this.commits.push(request);
    const heads = new Map(this.heads().map((file) => [file.file_id, { ...file }]));
    for (const change of request.changes) {
      if (
        change.kind !== "create" &&
        heads.get(change.file_id)?.revision_id !== change.expected_revision
      )
        throw new Error("CAS mismatch");
    }
    const changed = new Set<string>();
    const sequence = ++this.state.sequence;
    for (const change of request.changes) {
      if (change.kind === "create") {
        const text = change.text ?? this.uploads.get(change.upload_id ?? "")?.text ?? "";
        const file = {
          file_id: `file-${++this.counter}`,
          revision_id: `revision-${++this.counter}`,
          project_id: "project",
          path: change.path,
          entry_type: "file" as const,
          ownership: "user" as const,
          lifecycle: "active" as const,
          size: Buffer.byteLength(text),
          sha256: digest(text),
          text,
          sequence,
        };
        heads.set(file.file_id, file);
        changed.add(file.file_id);
      } else {
        const file = heads.get(change.file_id)!;
        if (change.kind === "replace") {
          file.text = change.text ?? this.uploads.get(change.upload_id ?? "")?.text ?? "";
          file.sha256 = digest(file.text);
          file.size = Buffer.byteLength(file.text);
        }
        if (change.kind === "trash") file.lifecycle = "trashed" as "active";
        if (change.kind === "move") file.path = change.path;
        changed.add(file.file_id);
      }
    }
    const files = [...changed].map((id) => ({
      ...heads.get(id)!,
      revision_id: `revision-${++this.counter}`,
      sequence,
    }));
    this.revisions.push(...files);
    const receipt: LibraryReceipt = {
      operation_id: request.operation_id,
      status: "committed",
      project_id: "project",
      epoch: 1,
      sequence,
      files,
      cloud_saved: true,
      materialization: "pending",
    };
    this.receipts.set(request.operation_id, receipt);
    if (this.loseCommitReply) {
      this.loseCommitReply = false;
      throw new Error("connection lost after commit");
    }
    return receipt as T;
  };
  download = async () => Buffer.alloc(0);
  upload = async (url: string, bytes: Buffer) => {
    this.uploads.get(url)!.text = bytes.toString();
  };
}

let workspace: string;
let gateway: Gateway;
let runtime: LibraryRuntime;
const identity = {
  machine_id: "fixture-machine",
  runtime_release: "fixture-release",
  process_generation: "1",
};
const localCalls = vi.fn();
function context(plan?: WorkspacePatchPlan): WorkspaceFileAuthorityContext {
  return {
    workspaceDir: workspace,
    sessionId: "session",
    planPatch: () => {
      if (!plan) throw new Error("patch fixture missing");
      return plan;
    },
  };
}
function tool(name: string, plan?: WorkspacePatchPlan, instance = runtime): AnyAgentTool {
  return instance.wrap(
    {
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async (_id, raw) => {
        const args = raw as { path: string; content?: string };
        localCalls(name);
        if (name === "write")
          await fs.writeFile(path.join(workspace, args.path), args.content ?? "");
        const text =
          name === "read" ? await fs.readFile(path.join(workspace, args.path), "utf8") : "done";
        return { content: [{ type: "text", text }], details: {} };
      },
    },
    context(plan),
  );
}
const read = (name: string, instance = runtime) =>
  tool("read", undefined, instance).execute(`read-${Math.random()}`, { path: name });
const write = (name: string, content: string, id = "write", instance = runtime) =>
  tool("write", undefined, instance).execute(id, { path: name, content });

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "library-runtime-"));
  gateway = new Gateway();
  runtime = new LibraryRuntime(workspace, gateway, identity);
  localCalls.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("hosted Library tool authority", () => {
  it("fences direct legacy projections against cutover and retains failed writer leases", async () => {
    const writeProjection = vi.fn(async () => {});
    await runtime.writeLegacyProjection(writeProjection);
    expect(writeProjection).not.toHaveBeenCalled();
    const legacy = new LibraryRuntime(workspace, gateway, identity);
    // Use a fresh volume because activation itself is deliberately irreversible.
    await fs.rm(path.join(workspace, ".magister/library-v1"), { recursive: true, force: true });
    gateway.state.mode = "legacy";
    const original = gateway.request;
    const request = vi
      .spyOn(gateway, "request")
      .mockImplementation(async (method, endpoint, values) => {
        if (endpoint === "/legacy-writes") return { mode: "active", epoch: 2 };
        return original(method, endpoint, values);
      });
    await legacy.writeLegacyProjection(writeProjection);
    expect(writeProjection).not.toHaveBeenCalled();
    request.mockImplementation(original);
    await expect(
      legacy.writeLegacyProjection(async () => {
        throw new Error("unknown write outcome");
      }),
    ).rejects.toThrow("unknown write outcome");
    expect(request.mock.calls.some((call) => call[1].endsWith("/complete"))).toBe(false);
  });
  it("replays a durable promotion after staging cleanup without reuploading or regressing files", async () => {
    const bytes = Buffer.from("# Reviewable report\n");
    const input = {
      attempt_id: "attempt-1",
      destination_path: "resources/report.md",
      sha256: digest(bytes),
    };
    const upload = vi.spyOn(gateway, "upload");
    const request = vi.spyOn(gateway, "request");
    gateway.loseCommitReply = true;
    await expect(runtime.promote(input, bytes)).rejects.toThrow("connection lost");
    gateway.put("resources/report.md", "newer report");
    const restarted = new LibraryRuntime(workspace, gateway, identity);
    const replay = await restarted.replayPromotion(input);
    expect(replay).toMatchObject({ status: "committed", cloud_saved: true, sequence: 1 });
    expect(gateway.commits).toHaveLength(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.find((call) => call[1] === "/uploads")?.[2]?.content_type).toBe(
      "text/markdown",
    );
    expect(await fs.readFile(path.join(workspace, input.destination_path), "utf8")).toBe(
      "newer report",
    );
    await expect(
      restarted.replayPromotion({ ...input, sha256: digest("changed retry") }),
    ).rejects.toThrow("operation_key_reused");
  });
  it("keeps exact Unicode filenames and routes native @ paths through cloud authority", async () => {
    gateway.put("resources/a b.md", "ASCII path");
    gateway.put("resources/a\u00a0b.md", "Unicode path");
    const readTool = runtime.wrap(createReadTool(workspace) as unknown as AnyAgentTool, context());
    const writeTool = runtime.wrap(
      createWriteTool(workspace) as unknown as AnyAgentTool,
      context(),
    );
    const result = await readTool.execute("unicode-read", { path: "resources/a\u00a0b.md" });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "Unicode path" }),
    );
    await writeTool.execute("at-write", { path: "@resources/new.md", content: "cloud" });
    expect(gateway.heads().find((file) => file.path === "resources/new.md")?.text).toBe("cloud");
    await writeTool.execute("dot-write", { path: "./resources/dot.md", content: "relative cloud" });
    expect(gateway.heads().find((file) => file.path === "resources/dot.md")?.text).toBe(
      "relative cloud",
    );
    await tool("ls").execute("list-root", { path: "." });
    await expect(
      readTool.execute("private", { path: "@.magister/library-v1/cache.json" }),
    ).rejects.toThrow("private runtime state");
  });
  it("holds one context snapshot while a newer materialization waits", async () => {
    gateway.put("resources/a.md", "old-a");
    gateway.put("resources/b.md", "old-b");
    await runtime.admit();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshot = runtime.readSnapshot(async () => {
      const first = await fs.readFile(path.join(workspace, "resources/a.md"), "utf8");
      started();
      await held;
      return [first, await fs.readFile(path.join(workspace, "resources/b.md"), "utf8")];
    });
    await ready;
    gateway.put("resources/a.md", "new-a");
    gateway.put("resources/b.md", "new-b");
    let installed = false;
    const install = new LibraryRuntime(workspace, gateway, identity).admit().then(() => {
      installed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(installed).toBe(false);
    release();
    expect(await snapshot).toEqual(["old-a", "old-b"]);
    await install;
    expect(await fs.readFile(path.join(workspace, "resources/b.md"), "utf8")).toBe("new-b");
  });
  it("persists activation even when the first capability acknowledgement fails", async () => {
    const request = gateway.request;
    vi.spyOn(gateway, "request").mockImplementation(async (method, endpoint, values) => {
      if (endpoint === "/capabilities") throw new LibraryHttpError(503, {});
      return request(method, endpoint, values);
    });
    await expect(runtime.admit()).rejects.toThrow("503");
    vi.spyOn(gateway, "request").mockRejectedValue(new LibraryHttpError(404, {}));
    await expect(
      read("unrelated.txt", new LibraryRuntime(workspace, gateway, identity)),
    ).rejects.toThrow("404");
    expect(localCalls).not.toHaveBeenCalled();
  });
  it("uses the real ordinary read/write/edit tools without a model export step", async () => {
    const writeTool = runtime.wrap(
      createWriteTool(workspace) as unknown as AnyAgentTool,
      context(),
    );
    const readTool = runtime.wrap(createReadTool(workspace) as unknown as AnyAgentTool, context());
    const editTool = runtime.wrap(createEditTool(workspace) as unknown as AnyAgentTool, context());
    await writeTool.execute("native-write", {
      path: "resources/native.md",
      content: "native text",
    });
    const result = await readTool.execute("native-read", { path: "resources/native.md" });
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "native text" })]),
    );
    await editTool.execute("native-edit", {
      path: "resources/native.md",
      oldText: "native",
      newText: "cloud",
    });
    expect(gateway.heads()[0].text).toBe("cloud text");
    expect((await fs.stat(path.join(workspace, "resources"))).mode & 0o050).toBe(0o050);
  });
  it("leases legacy mutations and retains ambiguous outcomes to block cutover", async () => {
    gateway.state.mode = "legacy";
    const request = vi.spyOn(gateway, "request");
    await write("legacy.txt", "ok", "known-local");
    expect(
      request.mock.calls.some((call) => call[1] === "/legacy-writes/legacy-lease/complete"),
    ).toBe(true);
    request.mockClear();
    const broken = runtime.wrap(
      {
        name: "write",
        label: "write",
        description: "",
        parameters: Type.Object({}),
        execute: async () => {
          throw new Error("uncertain partial mutation");
        },
      },
      context(),
    );
    await expect(broken.execute("uncertain-local", {})).rejects.toThrow("uncertain partial");
    expect(request.mock.calls.some((call) => call[1] === "/legacy-writes")).toBe(true);
    expect(request.mock.calls.some((call) => call[1].endsWith("/complete"))).toBe(false);
  });
  it("binds capability acknowledgements to machine, release and epoch", async () => {
    const request = vi.spyOn(gateway, "request");
    await runtime.admit();
    expect(request.mock.calls.find((call) => call[1] === "/capabilities")?.[2]).toMatchObject({
      ...identity,
      epoch: 1,
      capabilities: ["library_files_v1"],
    });
    gateway.state.epoch = 2;
    await runtime.admit();
    expect(request.mock.calls.filter((call) => call[1] === "/capabilities")).toHaveLength(2);
  });
  it("preserves legacy local tools", async () => {
    gateway.state.mode = "legacy";
    await write("draft.txt", "local");
    expect(await fs.readFile(path.join(workspace, "draft.txt"), "utf8")).toBe("local");
    expect(gateway.commits).toHaveLength(0);
  });
  it("commits normal writes and exact edits through cloud, requiring the revision actually read", async () => {
    await write("resources/draft.md", "hello");
    expect(localCalls).not.toHaveBeenCalled();
    await expect(write("resources/draft.md", "blind", "blind")).rejects.toThrow(
      "precondition_required",
    );
    await read("resources/draft.md");
    await tool("edit").execute("edit", {
      path: "resources/draft.md",
      oldText: "hello",
      newText: "world",
    });
    expect(await fs.readFile(path.join(workspace, "resources/draft.md"), "utf8")).toBe("world");
    expect(gateway.commits).toHaveLength(2);
    expect(gateway.commits[1].changes[0]).toMatchObject({
      kind: "replace",
      expected_revision: gateway.commits.length ? gateway.revisions[0].revision_id : "",
    });
  });
  it("moves and trashes a read Library file through hosted tools", async () => {
    // Hosted models have no apply_patch and exec cannot write the workspace,
    // so these are the only way an agent renames or removes a Library file.
    await write("resources/brief.md", "body");
    const move = runtime.fileTool("move_file", { sessionId: "session" });
    await expect(
      move.execute("move-unread", {
        path: "resources/brief.md",
        destination: "resources/approved.md",
      }),
    ).rejects.toThrow("precondition_required");
    await read("resources/brief.md");
    await move.execute("move", {
      path: "resources/brief.md",
      destination: "resources/approved.md",
    });
    expect(gateway.commits.at(-1)?.changes[0]).toMatchObject({
      kind: "move",
      path: "resources/approved.md",
    });
    expect(await fs.readFile(path.join(workspace, "resources/approved.md"), "utf8")).toBe("body");
    await expect(fs.access(path.join(workspace, "resources/brief.md"))).rejects.toThrow();
    await read("resources/approved.md");
    for (const destination of ["../outside.md", "PLAN.md", "resources/approved.md"])
      await expect(
        move.execute(`bad-${destination}`, { path: "resources/approved.md", destination }),
      ).rejects.toThrow("invalid_path");
    // Unregistered local bytes and a trashed entry both keep their path.
    await fs.writeFile(path.join(workspace, "resources/local.md"), "unregistered");
    await expect(
      move.execute("onto-local", {
        path: "resources/approved.md",
        destination: "resources/local.md",
      }),
    ).rejects.toThrow("unregistered local bytes");
    gateway.put("resources/old.md", "old");
    await read("resources/old.md");
    await runtime
      .fileTool("trash_file", { sessionId: "session" })
      .execute("trash-old", { path: "resources/old.md" });
    await expect(
      move.execute("onto-trashed", {
        path: "resources/approved.md",
        destination: "resources/old.md",
      }),
    ).rejects.toThrow("already exists");
    await read("resources/approved.md");
    await runtime
      .fileTool("trash_file", { sessionId: "session" })
      .execute("trash", { path: "resources/approved.md" });
    expect(gateway.commits.at(-1)?.changes[0]).toMatchObject({ kind: "trash" });
    await expect(fs.access(path.join(workspace, "resources/approved.md"))).rejects.toThrow();
  });
  it("applies the edit tool's edits array against the revision read", async () => {
    // Lane hazelib, 2026-10-29: the agent's edit in this form failed with
    // "Exact oldText and newText are required" and it overwrote the file.
    await write("resources/brief.md", "TOKEN=two\nkeep\nend");
    await read("resources/brief.md");
    await tool("edit").execute("edit-array", {
      path: "resources/brief.md",
      edits: [
        { oldText: "end", newText: "END" },
        { oldText: "TOKEN=two", newText: "TOKEN=three" },
      ],
    });
    expect(gateway.heads()[0].text).toBe("TOKEN=three\nkeep\nEND");
    await read("resources/brief.md");
    await expect(
      tool("edit").execute("edit-overlap", {
        path: "resources/brief.md",
        edits: [
          { oldText: "TOKEN=three", newText: "a" },
          { oldText: "three\nkeep", newText: "b" },
        ],
      }),
    ).rejects.toThrow("overlap");
  });
  it("does not advance observations when another writer refreshes the cache", async () => {
    gateway.put("resources/draft.md", "one");
    await read("resources/draft.md");
    gateway.put("resources/draft.md", "two");
    await expect(write("resources/draft.md", "overwrite")).rejects.toThrow("conflict");
    expect(await fs.readFile(path.join(workspace, "resources/draft.md"), "utf8")).toBe("two");
    await read("resources/draft.md");
    await write("resources/draft.md", "three", "new-call");
    expect(gateway.heads()[0].text).toBe("three");
  });
  it("replays the persisted request after a lost reply and never installs an old receipt over a newer revision", async () => {
    gateway.loseCommitReply = true;
    await expect(write("resources/draft.md", "first")).rejects.toThrow("connection lost");
    gateway.put("resources/draft.md", "newer");
    const restarted = new LibraryRuntime(workspace, gateway, identity);
    const result = await write("resources/draft.md", "first", "write", restarted);
    expect(result.details).toMatchObject({ status: "committed", sequence: 1 });
    expect(gateway.commits).toHaveLength(1);
    expect(await fs.readFile(path.join(workspace, "resources/draft.md"), "utf8")).toBe("newer");
    await expect(write("resources/draft.md", "changed retry", "write", restarted)).rejects.toThrow(
      "operation_key_reused",
    );
  });
  it("rejects a whole mixed-root or source-owned patch before any local or cloud mutation", async () => {
    gateway.put("resources/draft.md", "old");
    gateway.put("BRAND.md", "brand", "managed");
    const stage = vi.fn(async () => []);
    await expect(
      tool("apply_patch", { paths: ["scratch.txt", "resources/draft.md"], stage }).execute(
        "patch",
        { input: "mixed" },
      ),
    ).rejects.toThrow("mix");
    expect(stage).not.toHaveBeenCalled();
    await read("resources/draft.md");
    await expect(
      tool("apply_patch", { paths: ["resources/draft.md", "BRAND.md"], stage }).execute("patch2", {
        input: "managed",
      }),
    ).rejects.toThrow("managed_file");
    expect(gateway.commits).toHaveLength(0);
    expect(localCalls.mock.calls.filter(([name]) => name !== "read")).toHaveLength(0);
  });
  it("stages a complete multi-file patch before committing and supports atomic move plus replace", async () => {
    gateway.put("resources/a.md", "one\n");
    gateway.put("resources/b.md", "two\n");
    await read("resources/a.md");
    await read("resources/b.md");
    const failing: WorkspacePatchPlan = {
      paths: ["resources/a.md", "resources/b.md"],
      stage: async (reader) => {
        await reader("resources/a.md");
        throw new Error("second hunk mismatch");
      },
    };
    await expect(
      tool("apply_patch", failing).execute("bad-patch", { input: "bad" }),
    ).rejects.toThrow("second hunk");
    expect(gateway.commits).toHaveLength(0);
    const plan: WorkspacePatchPlan = {
      paths: ["resources/a.md", "resources/new.md", "resources/b.md"],
      stage: async () => [
        { kind: "update", path: "resources/a.md", text: "edited\n", movePath: "resources/new.md" },
        { kind: "delete", path: "resources/b.md" },
      ],
    };
    await tool("apply_patch", plan).execute("good-patch", { input: "good" });
    expect(gateway.commits).toHaveLength(1);
    expect(gateway.commits[0].changes.map((change) => change.kind)).toEqual([
      "replace",
      "move",
      "trash",
    ]);
    expect(await fs.readFile(path.join(workspace, "resources/new.md"), "utf8")).toBe("edited\n");
    await expect(fs.stat(path.join(workspace, "resources/a.md"))).rejects.toThrow();
    await expect(fs.stat(path.join(workspace, "resources/b.md"))).rejects.toThrow();
  });
  it("fails closed on unavailable, regressed or pending state after activation", async () => {
    gateway.put("resources/a.md", "current");
    await read("resources/a.md");
    localCalls.mockClear();
    gateway.unavailable = true;
    await expect(
      read("resources/a.md", new LibraryRuntime(workspace, gateway, identity)),
    ).rejects.toThrow("503");
    gateway.unavailable = false;
    gateway.state.mode = "legacy";
    await expect(read("resources/a.md")).rejects.toThrow("cannot fall back");
    gateway.state.mode = "active";
    gateway.state.coverage.complete = false;
    await expect(runtime.admit()).rejects.toThrow("publication_pending");
    gateway.state.coverage.complete = true;
    // A background view publishing (a plan re-render) no longer fails turns:
    // /context-ready already publishes the required context or fails closed.
    gateway.state.publication.pending = 1;
    await expect(runtime.admit()).resolves.toBe(true);
    expect(localCalls).not.toHaveBeenCalled();
  });
  it("rejects symlink targets without touching the destination", async () => {
    await fs.mkdir(path.join(workspace, "resources"));
    await fs.symlink(os.tmpdir(), path.join(workspace, "resources", "escape"));
    await expect(write("resources/escape/owned.txt", "bad")).rejects.toThrow("symlink");
    expect(gateway.commits).toHaveLength(0);
  });
  it("rejects local aliases into managed roots, including nonexistent leaves", async () => {
    gateway.put("resources/a.md", "original");
    await runtime.admit();
    await fs.symlink(path.join(workspace, "resources"), path.join(workspace, "alias"));
    const native = runtime.wrap(createWriteTool(workspace) as unknown as AnyAgentTool, context());
    await expect(
      native.execute("alias-old", { path: "alias/a.md", content: "bad" }),
    ).rejects.toThrow("aliases");
    await expect(
      native.execute("alias-new", { path: "alias/new.md", content: "bad" }),
    ).rejects.toThrow("aliases");
    expect(await fs.readFile(path.join(workspace, "resources/a.md"), "utf8")).toBe("original");
    await expect(fs.stat(path.join(workspace, "resources/new.md"))).rejects.toThrow();
    expect(gateway.commits).toHaveLength(0);
  });
  it("recovers a partially installed changeset before admitting a read", async () => {
    gateway.put("resources/a.md", "old-a");
    gateway.put("resources/b.md", "old-b");
    await runtime.admit();
    gateway.put("resources/a.md", "new-a");
    gateway.put("resources/b.md", "new-b");
    const rename = fs.rename.bind(fs);
    let fail = true;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("resources/b.md") && fail) {
        fail = false;
        throw new Error("simulated crash during install");
      }
      return rename(from, to);
    });
    await expect(runtime.admit()).rejects.toThrow("simulated crash");
    const persisted = await runtime.store.cache();
    expect(persisted?.sequence).toBe(2);
    gateway.put("resources/a.md", "newest-a");
    await new LibraryRuntime(workspace, gateway, identity).admit();
    expect((await runtime.store.cache())?.sequence).toBe(5);
    expect(await fs.readFile(path.join(workspace, "resources/a.md"), "utf8")).toBe("newest-a");
    expect(await fs.readFile(path.join(workspace, "resources/b.md"), "utf8")).toBe("new-b");
  });
  it("allows shared readers while excluding a writer, and releases a crashed process lock", async () => {
    const directory = path.join(workspace, "lock-proof");
    await withLibraryLock(directory, "exclusive", async () => {});
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const reader = withLibraryLock(directory, "shared", async () => {
      readStarted();
      await barrier;
    });
    await started;
    await withLibraryLock(directory, "shared", async () => {});
    let writerEntered = false;
    const writer = withLibraryLock(directory, "exclusive", async () => {
      writerEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(writerEntered).toBe(false);
    release();
    await reader;
    await writer;
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); setInterval(()=>{},1000)",
        path.join(directory, "lock.sqlite"),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await once(child.stdout!, "data");
      let admitted = false;
      const waiting = withLibraryLock(directory, "shared", async () => {
        admitted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(admitted).toBe(false);
      child.kill("SIGKILL");
      await once(child, "exit");
      await waiting;
      expect(admitted).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
