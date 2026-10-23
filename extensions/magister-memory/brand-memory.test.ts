import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandMemorySessions, syncBrandMemory } from "./brand-memory.js";
import { stubBrandMemoryGateway, useMachineGatewayEnv } from "./brand-memory.test-helpers.js";
import plugin from "./index.js";

const SEED = "[magister_seed:company] Company/Product: Artworks San Diego";

describe("brand memory session-start sync", () => {
  let dir: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "magister-brand-memory-"));
    restoreEnv = useMachineGatewayEnv();
  });

  afterEach(async () => {
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const memoryPath = () => join(dir, "MEMORY.md");
  const stampPath = () => join(dir, ".magister", "state", "brand-memory-import");
  const readMemory = () => readFile(memoryPath(), "utf8");
  const stamp = async (): Promise<void> => {
    await mkdir(join(dir, ".magister", "state"), { recursive: true });
    await writeFile(stampPath(), "2026-10-22T00:00:00.000Z\n", "utf8");
  };

  it("rewrites MEMORY.md with the Gateway's list within a 3 s read", async () => {
    await stamp();
    await writeFile(memoryPath(), "an old copy", "utf8");
    const gateway = stubBrandMemoryGateway(["Never call it Magister Cloud", "Tone: plain"]);
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await syncBrandMemory(dir);

    expect(gateway.calls).toEqual([
      {
        method: "GET",
        path: "/api/runtime/brand-memory",
        body: undefined,
        authorization: "Bearer broker-local",
      },
    ]);
    expect(timeout).toHaveBeenCalledWith(3000);
    expect(await readMemory()).toBe("Never call it Magister Cloud\n§\nTone: plain");
  });

  it("leaves an identical copy untouched", async () => {
    stubBrandMemoryGateway(["Tone: plain"]);
    await syncBrandMemory(dir);
    const before = await stat(memoryPath());

    await syncBrandMemory(dir);

    expect((await stat(memoryPath())).ino).toBe(before.ino);
  });

  it("throws when the Gateway is unreachable, leaving the local file alone", async () => {
    await writeFile(memoryPath(), "kept while the Gateway is down", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(syncBrandMemory(dir)).rejects.toThrow("fetch failed");

    expect(await readMemory()).toBe("kept while the Gateway is down");
    await expect(stat(stampPath())).rejects.toThrow();
  });

  it("imports the machine's own entries once, skipping Gateway seed records", async () => {
    const original = `${SEED}\n§\n  Never call it Magister Cloud  \n§\nNo paid ads before March`;
    await writeFile(memoryPath(), original, "utf8");
    const gateway = stubBrandMemoryGateway();

    await syncBrandMemory(dir);

    expect(gateway.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["GET", "/api/runtime/brand-memory", undefined],
      [
        "POST",
        "/api/runtime/brand-memory/import",
        { entries: ["Never call it Magister Cloud", "No paid ads before March"] },
      ],
    ]);
    expect(await readMemory()).toBe("Never call it Magister Cloud\n§\nNo paid ads before March");
    expect(JSON.parse(await readFile(stampPath(), "utf8"))).toEqual({
      imported_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      memory_md: original,
    });

    // Once per machine: after the user removes everything in the Library, the
    // next session copies the empty list instead of importing again.
    gateway.entries.splice(0);
    gateway.calls.splice(0);
    await syncBrandMemory(dir);

    expect(gateway.calls.map((call) => call.path)).toEqual(["/api/runtime/brand-memory"]);
    expect(await readMemory()).toBe("");
  });

  it("imports nothing when the machine only holds seed records, and drops them", async () => {
    await writeFile(memoryPath(), SEED, "utf8");
    const gateway = stubBrandMemoryGateway();

    await syncBrandMemory(dir);

    expect(gateway.calls.map((call) => call.path)).toEqual(["/api/runtime/brand-memory"]);
    expect(await readMemory()).toBe("");
    expect(await readFile(stampPath(), "utf8")).toBeTruthy();
  });

  it("retries the import next session when it fails", async () => {
    await writeFile(memoryPath(), "No paid ads before March", "utf8");
    const gateway = stubBrandMemoryGateway();
    gateway.failing.add("/api/runtime/brand-memory/import");

    await expect(syncBrandMemory(dir)).rejects.toThrow("HTTP 500");
    expect(await readMemory()).toBe("No paid ads before March");
    await expect(stat(stampPath())).rejects.toThrow();

    gateway.failing.clear();
    await syncBrandMemory(dir);

    expect(gateway.entries).toEqual(["No paid ads before March"]);
    expect(await readFile(stampPath(), "utf8")).toBeTruthy();
  });

  it("adds the machine's missing entries when another agent wrote first", async () => {
    await writeFile(
      memoryPath(),
      `${SEED}\n§\nNever call it Magister Cloud\n§\nNo paid ads before March`,
      "utf8",
    );
    // An MCP client saved one of the same rules before this machine's first sync.
    const gateway = stubBrandMemoryGateway(["Never call it Magister Cloud"]);

    await syncBrandMemory(dir);

    expect(gateway.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["GET", "/api/runtime/brand-memory", undefined],
      ["POST", "/api/runtime/brand-memory", { action: "add", content: "No paid ads before March" }],
      ["GET", "/api/runtime/brand-memory", undefined],
    ]);
    expect(await readMemory()).toBe("Never call it Magister Cloud\n§\nNo paid ads before March");
  });

  it("finishes the migration when the Gateway refuses an entry, keeping it in the stamp", async () => {
    // Retrying a refusal (here a duplicate in other letter case; equally a
    // blocked threat or a full list) could never succeed and would leave the
    // copy unsynced on every session.
    const original = "never call it magister cloud";
    await writeFile(memoryPath(), original, "utf8");
    const gateway = stubBrandMemoryGateway(["Never call it Magister Cloud"]);

    await syncBrandMemory(dir);

    expect(gateway.calls.map((call) => call.body)).toContainEqual({
      action: "add",
      content: original,
    });
    expect(await readMemory()).toBe("Never call it Magister Cloud");
    expect(JSON.parse(await readFile(stampPath(), "utf8"))).toMatchObject({
      memory_md: original,
    });
  });
});

describe("BrandMemorySessions", () => {
  it("claims each session once", () => {
    const sessions = new BrandMemorySessions();
    expect(sessions.claim("/ws", "s1")).toBe(true);
    expect(sessions.claim("/ws", "s1")).toBe(false);
    expect(sessions.claim("/ws", "s2")).toBe(true);
    expect(sessions.claim("/other", "s1")).toBe(true);
  });

  it("always syncs a run without a session id", () => {
    const sessions = new BrandMemorySessions();
    expect(sessions.claim("/ws", undefined)).toBe(true);
    expect(sessions.claim("/ws", undefined)).toBe(true);
  });
});

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

  it("syncs once per session and never overrides the model", async () => {
    const gateway = stubBrandMemoryGateway(["Tone: plain"]);
    const { run } = registerHook();

    await expect(run("session-1")).resolves.toBeUndefined();
    await run("session-1");
    await run("session-2");

    expect(gateway.calls.filter((call) => call.method === "GET")).toHaveLength(2);
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("Tone: plain");
  });

  it("keeps the local MEMORY.md and warns when the Gateway is unreachable", async () => {
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
      expect.stringContaining("brand memory sync failed, keeping the local MEMORY.md"),
    );
  });
});
