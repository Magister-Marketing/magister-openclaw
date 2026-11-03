import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkspaceFileAuthority } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrandMemoryGateway, useMachineGatewayEnv } from "./brand-memory.test-helpers.js";
import plugin from "./index.js";

describe("before_model_resolve hook", () => {
  let dir: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "magister-brand-memory-hook-"));
    restoreEnv = useMachineGatewayEnv();
  });

  afterEach(async () => {
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function registerHook() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const warn = vi.fn();
    plugin.register({
      config: { agents: { list: [] } },
      pluginConfig: {},
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) =>
        handlers.set(name, handler),
      registerService: vi.fn(),
      registerTool: vi.fn(),
    } as never);
    const hook = handlers.get("before_model_resolve");
    if (!hook) {
      throw new Error("before_model_resolve is not registered");
    }
    return {
      warn,
      run: (sessionId: string) => hook({ prompt: "hi" }, { workspaceDir: dir, sessionId }),
    };
  }

  it("refreshes every turn in the same session and never overrides the model", async () => {
    const gateway = stubBrandMemoryGateway(["Tone: plain"]);
    const { run } = registerHook();

    await expect(run("session-1")).resolves.toBeUndefined();
    gateway.entries.splice(0, 1, "Tone: warm");
    await run("session-1");
    expect(
      JSON.parse(await readFile(join(dir, ".magister", "state", "marketing-context.json"), "utf8"))
        .rendered,
    ).toContain("Tone: warm");
    await run("session-2");

    expect(gateway.calls.filter((call) => call.path.endsWith("marketing-context"))).toHaveLength(3);
    // The legacy list, its MEMORY.md copy and the one-time import are retired.
    expect(gateway.calls.filter((call) => call.path.includes("/brand-memory"))).toHaveLength(0);
    await expect(stat(join(dir, "MEMORY.md"))).rejects.toThrow();
  });

  it("leaves MEMORY.md alone and warns when the Gateway is unreachable", async () => {
    await writeFile(join(dir, "MEMORY.md"), "local copy", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    const { run, warn } = registerHook();

    await expect(run("session-1")).resolves.toBeUndefined();

    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("local copy");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("shared marketing context refresh failed, keeping the last snapshot"),
    );
  });
  it("keeps last good context on failure, marks stale, and retries in the same chat", async () => {
    const gateway = stubBrandMemoryGateway(["Tone: plain"]);
    const { run } = registerHook();
    const path = join(dir, ".magister", "state", "marketing-context.json");
    await run("same");
    gateway.failing.add("/api/runtime/marketing-context");
    await run("same");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      stale: true,
      rendered: "Confirmed rules: Tone: plain",
    });
    gateway.failing.clear();
    gateway.entries.splice(0, 1, "Tone: warm");
    await run("same");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      revision: 1,
      rendered: "Confirmed rules: Tone: warm",
    });
  });
  it("suppresses cached and legacy memory after an authorization denial", async () => {
    const gateway = stubBrandMemoryGateway(["Private old brand rule"]);
    await writeFile(join(dir, "MEMORY.md"), "Private old brand note", "utf8");
    const { run } = registerHook();
    await run("same");
    gateway.forbidden.add("/api/runtime/marketing-context");
    await run("same");
    const context = JSON.parse(
      await readFile(join(dir, ".magister", "state", "marketing-context.json"), "utf8"),
    );
    expect(context.available).toBe(false);
    expect(context.rendered).not.toContain("Private old brand rule");
    // Revoked: even a never-imported MEMORY.md is emptied, as before, with no copy kept.
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("");
    await expect(stat(join(dir, ".magister", "state", "memory-md-retired"))).rejects.toThrow();
  });

  it("says shared context is unavailable when the first refresh fails", async () => {
    const gateway = stubBrandMemoryGateway(["Tone: plain"]);
    gateway.failing.add("/api/runtime/marketing-context");
    const { run } = registerHook();
    await run("same");
    const context = JSON.parse(
      await readFile(join(dir, ".magister", "state", "marketing-context.json"), "utf8"),
    );
    expect(context).toMatchObject({ available: false, stale: true });
    expect(context.rendered).toContain("could not be loaded");
  });

  it("leaves MEMORY.md to the Library's legacy-write gate but purges the state copies on revocation", async () => {
    const gateway = stubBrandMemoryGateway(["Private old brand rule"]);
    const state = join(dir, ".magister", "state");
    await mkdir(state, { recursive: true });
    await writeFile(join(dir, "MEMORY.md"), "Private old brand note", "utf8");
    await writeFile(join(state, "memory-md-retired"), "Private earlier note\n", "utf8");
    await writeFile(
      join(state, "brand-memory-import"),
      '{"memory_md":"Private original"}\n',
      "utf8",
    );
    // Active or recovery: the Library refuses local projection writes.
    const unregister = registerWorkspaceFileAuthority({
      version: 1,
      wrap: (tool) => tool,
      admit: async () => true,
      legacyWrite: async () => undefined,
    });
    try {
      gateway.forbidden.add("/api/runtime/marketing-context");
      const { run } = registerHook();
      await run("same");
      expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("Private old brand note");
      await expect(stat(join(state, "memory-md-retired"))).rejects.toThrow();
      expect(await readFile(join(state, "brand-memory-import"), "utf8")).toBe("{}\n");
      const context = JSON.parse(await readFile(join(state, "marketing-context.json"), "utf8"));
      expect(context.available).toBe(false);
    } finally {
      unregister();
    }
  });

  it("empties MEMORY.md on revocation when the Library admits the workspace but allows the write", async () => {
    const gateway = stubBrandMemoryGateway(["Private old brand rule"]);
    await writeFile(join(dir, "MEMORY.md"), "Private old brand note", "utf8");
    const unregister = registerWorkspaceFileAuthority({
      version: 1,
      wrap: (tool) => tool,
      admit: async () => true,
    });
    try {
      gateway.forbidden.add("/api/runtime/marketing-context");
      const { run } = registerHook();
      await run("same");
      expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("");
    } finally {
      unregister();
    }
  });

  it("empties a MEMORY.md whose entries already reached the Gateway", async () => {
    stubBrandMemoryGateway(["Tone: plain"]);
    await mkdir(join(dir, ".magister", "state"), { recursive: true });
    await writeFile(
      join(dir, ".magister", "state", "brand-memory-import"),
      '{"memory_md":"Tone: plain"}\n',
    );
    await writeFile(join(dir, "MEMORY.md"), "Tone: plain (stale copy)", "utf8");
    const { run } = registerHook();
    await run("same");
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("");
    // A later local edit reached no store: it is kept, not lost.
    expect(await readFile(join(dir, ".magister", "state", "memory-md-retired"), "utf8")).toBe(
      "Tone: plain (stale copy)\n",
    );
    await run("same");
    expect(await readFile(join(dir, ".magister", "state", "memory-md-retired"), "utf8")).toBe(
      "Tone: plain (stale copy)\n",
    );
  });

  it("empties a stamped MEMORY.md even when the refresh fails", async () => {
    const gateway = stubBrandMemoryGateway(["Tone: plain"]);
    gateway.failing.add("/api/runtime/marketing-context");
    await mkdir(join(dir, ".magister", "state"), { recursive: true });
    await writeFile(join(dir, ".magister", "state", "brand-memory-import"), "{}\n");
    await writeFile(join(dir, "MEMORY.md"), "Tone: plain (stale copy)", "utf8");
    const { run } = registerHook();
    await run("same");
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("");
  });

  it("removes every copy of the notes on revocation, keeping only the stamp's presence", async () => {
    const gateway = stubBrandMemoryGateway(["Tone: plain"]);
    const state = join(dir, ".magister", "state");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "brand-memory-import"), '{"memory_md":"Private original"}\n');
    await writeFile(join(dir, "MEMORY.md"), "Private later edit", "utf8");
    const { run } = registerHook();
    await run("same");
    expect(await readFile(join(state, "memory-md-retired"), "utf8")).toBe("Private later edit\n");

    gateway.forbidden.add("/api/runtime/marketing-context");
    await run("same");
    await expect(stat(join(state, "memory-md-retired"))).rejects.toThrow();
    expect(await readFile(join(state, "brand-memory-import"), "utf8")).toBe("{}\n");
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("");
  });

  it("leaves a never-imported MEMORY.md for the Gateway's migration", async () => {
    stubBrandMemoryGateway(["Tone: plain"]);
    await writeFile(join(dir, "MEMORY.md"), "Owner prefers short emails.", "utf8");
    const { run } = registerHook();
    await run("same");
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("Owner prefers short emails.");
  });
});
