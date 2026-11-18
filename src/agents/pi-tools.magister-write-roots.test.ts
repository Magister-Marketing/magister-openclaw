import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMagisterWriteRoots } from "./magister-write-roots.js";
import { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } from "./pi-tools.read.js";

// On a Magister machine the write and edit tools run in the OpenClaw host
// process, outside the tool sandbox. Left unbounded they could plant code the
// host later runs (a checkout's .git/config or hooks, the askpass helper in the
// repo root's .staging, the host user's Python user site) or rewrite state that
// decides what the machine may do. They keep reading anywhere: skills live
// outside the workspace.
describe("Magister write roots for the host write and edit tools", () => {
  let tmp: string;
  let workspace: string;
  let repos: string;
  let checkout: string;
  let outside: string;

  const writeTool = () =>
    createHostWorkspaceWriteTool(workspace, { writeRoots: [workspace, repos] });
  const editTool = () => createHostWorkspaceEditTool(workspace, { writeRoots: [workspace, repos] });
  const write = (target: string, content = "x") =>
    writeTool().execute("call", { path: target, content });

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "magister-write-roots-")));
    workspace = path.join(tmp, "data", ".openclaw", "workspace");
    repos = path.join(tmp, "data", "repos");
    checkout = path.join(repos, "acme", "site");
    outside = path.join(tmp, "data", ".openclaw");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(checkout, ".git"), { recursive: true });
    await fs.mkdir(path.join(repos, ".staging"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("writes in the workspace, relative or absolute, and in a checkout", async () => {
    await write("resources/report.md", "report");
    await write(path.join(workspace, ".magister", "note.md"), "note");
    await write(path.join(checkout, "src", "index.ts"), "export {};");

    expect(await fs.readFile(path.join(workspace, "resources", "report.md"), "utf8")).toBe(
      "report",
    );
    expect(await fs.readFile(path.join(workspace, ".magister", "note.md"), "utf8")).toBe("note");
    expect(await fs.readFile(path.join(checkout, "src", "index.ts"), "utf8")).toBe("export {};");
  });

  it("refuses every path outside the roots", async () => {
    for (const target of [
      path.join(outside, "openclaw.json"),
      path.join(outside, "egress-allowlist.json"),
      path.join(outside, "hooks", "evil", "handler.js"),
      path.join(tmp, "home", ".local", "lib", "python3.11", "site-packages", "usercustomize.py"),
      "../openclaw.json",
    ]) {
      await expect(write(target)).rejects.toThrow(/can only write/);
    }
    await expect(fs.readdir(outside)).resolves.toEqual(["workspace"]);
  });

  it("refuses .git anywhere, and a root's own dot folders outside the workspace", async () => {
    for (const target of [
      path.join(checkout, ".git", "config"),
      path.join(checkout, ".git", "hooks", "post-checkout"),
      path.join(checkout, "vendor", "lib", ".git", "config"),
      path.join(workspace, "site", ".git", "config"),
      path.join(repos, ".staging", "askpass-x-access-token.sh"),
      path.join(repos, ".work", "acme", "site", "runs.jsonl"),
    ]) {
      await expect(write(target)).rejects.toThrow(/can only write/);
    }
    await expect(fs.readdir(path.join(checkout, ".git"))).resolves.toEqual([]);
    await expect(fs.readdir(path.join(repos, ".staging"))).resolves.toEqual([]);
  });

  it("refuses a link that leads out of a root", async () => {
    await fs.symlink(outside, path.join(workspace, "escape"));
    await fs.symlink(path.join(checkout, ".git"), path.join(checkout, "gitdir"));

    await expect(write(path.join(workspace, "escape", "openclaw.json"))).rejects.toThrow(
      /can only write/,
    );
    await expect(write(path.join(checkout, "gitdir", "config"))).rejects.toThrow(/can only write/);
    await expect(fs.readdir(outside)).resolves.toEqual(["workspace"]);
  });

  it("refuses a link whose target does not exist yet", async () => {
    // A checkout can commit links; writing through a dangling one would create
    // its target wherever it points.
    await fs.symlink(path.join(outside, ".env"), path.join(checkout, "env-link"));
    await fs.symlink(
      path.join(checkout, ".git", "hooks", "pre-commit"),
      path.join(checkout, "hook-link"),
    );

    await expect(write(path.join(checkout, "env-link"))).rejects.toThrow(/can only write/);
    await expect(write(path.join(checkout, "hook-link"))).rejects.toThrow(/can only write/);
    await expect(fs.readdir(outside)).resolves.toEqual(["workspace"]);
    await expect(fs.readdir(path.join(checkout, ".git"))).resolves.toEqual([]);
  });

  it("refuses the workspace's own plugin and state folder", async () => {
    // OpenClaw loads workspace plugins from <workspace>/.openclaw/extensions.
    await expect(
      write(path.join(workspace, ".openclaw", "extensions", "evil", "index.js")),
    ).rejects.toThrow(/can only write/);
    await expect(write(".openclaw/workspace-state.json", "{}")).rejects.toThrow(/can only write/);
  });

  it("holds edit to the same roots", async () => {
    const config = path.join(outside, "openclaw.json");
    await fs.writeFile(config, '{"hooks": {}}');
    const source = path.join(checkout, "README.md");
    await fs.writeFile(source, "old line\n");

    await expect(
      editTool().execute("call", { path: config, edits: [{ oldText: "{}", newText: '{"x": 1}' }] }),
    ).rejects.toThrow(/can only write/);
    await editTool().execute("call", {
      path: source,
      edits: [{ oldText: "old line", newText: "new line" }],
    });

    expect(await fs.readFile(config, "utf8")).toBe('{"hooks": {}}');
    expect(await fs.readFile(source, "utf8")).toBe("new line\n");
  });

  it("reads the roots from MAGISTER_FILE_WRITE_ROOTS and fails closed on a bad value", () => {
    expect(resolveMagisterWriteRoots({})).toBeNull();
    expect(resolveMagisterWriteRoots({ MAGISTER_FILE_WRITE_ROOTS: " " })).toBeNull();
    expect(
      resolveMagisterWriteRoots({
        MAGISTER_FILE_WRITE_ROOTS: "/data/.openclaw/workspace:/data/repos/",
      }),
    ).toEqual(["/data/.openclaw/workspace", "/data/repos"]);
    expect(
      resolveMagisterWriteRoots({ MAGISTER_FILE_WRITE_ROOTS: "relative:also/relative" }),
    ).toEqual([]);
  });

  it("writes nothing at all when the roots resolve to none", async () => {
    const tool = createHostWorkspaceWriteTool(workspace, { writeRoots: [] });
    await expect(tool.execute("call", { path: "resources/a.md", content: "x" })).rejects.toThrow(
      /can only write/,
    );
  });
});
