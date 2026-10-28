import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBrandMemory, syncBrandMemory } from "./brand-memory.js";
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

  it("keeps an unimported MEMORY.md through a write until the next sync imports it", async () => {
    const original = "Never call it Magister Cloud\n§\nNo paid ads before March";
    await writeFile(memoryPath(), original, "utf8");
    const gateway = stubBrandMemoryGateway();
    // The first session's sync times out, so nothing was imported yet.
    gateway.failing.add("/api/runtime/brand-memory");
    await expect(syncBrandMemory(dir)).rejects.toThrow("HTTP 500");
    gateway.failing.clear();

    const added = await applyBrandMemory(dir, { action: "add", content: "Tone: plain" });

    expect(added).toMatchObject({ success: true, entries: ["Tone: plain"] });
    expect(await readMemory()).toBe(original);
    await expect(stat(stampPath())).rejects.toThrow();

    await syncBrandMemory(dir);

    expect(gateway.entries).toEqual([
      "Tone: plain",
      "Never call it Magister Cloud",
      "No paid ads before March",
    ]);
    expect(await readMemory()).toBe(gateway.entries.join("\n§\n"));
    expect(JSON.parse(await readFile(stampPath(), "utf8"))).toMatchObject({
      memory_md: original,
    });

    // Modern writes update shared context without expanding the legacy import file.
    await applyBrandMemory(dir, { action: "remove", old_text: "Tone" });
    expect(
      JSON.parse(await readFile(join(dir, ".magister", "state", "marketing-context.json"), "utf8"))
        .rendered,
    ).not.toContain("Tone");
  });

  it("imports into a list another agent wrote first, skipping what it already has", async () => {
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
      [
        "POST",
        "/api/runtime/brand-memory/import",
        { entries: ["Never call it Magister Cloud", "No paid ads before March"] },
      ],
    ]);
    expect(await readMemory()).toBe("Never call it Magister Cloud\n§\nNo paid ads before March");
  });

  it("never brings back entries removed after an import whose reply was lost", async () => {
    await writeFile(memoryPath(), "No paid ads before March\n§\nTone: plain", "utf8");
    const gateway = stubBrandMemoryGateway();
    // The Gateway commits the import, but the machine sees a failure.
    gateway.failingAfterCommit.add("/api/runtime/brand-memory/import");

    await expect(syncBrandMemory(dir)).rejects.toThrow("HTTP 500");
    await expect(stat(stampPath())).rejects.toThrow();
    expect(gateway.entries).toEqual(["No paid ads before March", "Tone: plain"]);

    // The team removes one in the Library before the next session.
    gateway.entries.splice(1);
    gateway.failingAfterCommit.clear();
    await syncBrandMemory(dir);

    expect(gateway.entries).toEqual(["No paid ads before March"]);
    expect(await readMemory()).toBe("No paid ads before March");
    expect(await readFile(stampPath(), "utf8")).toBeTruthy();
  });

  it("finishes the migration when the Gateway refuses an entry, keeping it in the stamp", async () => {
    // Retrying a refusal (here a duplicate in other letter case; equally a
    // blocked threat or a full list) could never succeed and would leave the
    // copy unsynced on every session.
    const original = "never call it magister cloud";
    await writeFile(memoryPath(), original, "utf8");
    const gateway = stubBrandMemoryGateway(["Never call it Magister Cloud"]);

    await syncBrandMemory(dir);

    expect(gateway.calls.map((call) => call.body)).toContainEqual({ entries: [original] });
    expect(await readMemory()).toBe("Never call it Magister Cloud");
    expect(JSON.parse(await readFile(stampPath(), "utf8"))).toMatchObject({
      memory_md: original,
    });
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
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("Tone: warm");
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
    const { run } = registerHook();
    await run("same");
    gateway.forbidden.add("/api/runtime/marketing-context");
    await run("same");
    const context = JSON.parse(
      await readFile(join(dir, ".magister", "state", "marketing-context.json"), "utf8"),
    );
    expect(context.available).toBe(false);
    expect(context.rendered).not.toContain("Private old brand rule");
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe("");
  });
});
