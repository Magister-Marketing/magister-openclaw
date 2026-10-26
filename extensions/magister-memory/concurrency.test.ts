import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { withContextLock } from "./context-lock.js";
import { createMemoryTool } from "./index.js";

function makeTool(workspaceDir: string) {
  const api = { pluginConfig: {}, config: {} } as unknown as OpenClawPluginApi;
  const ctx = { workspaceDir, agentId: "main" } as unknown as OpenClawPluginToolContext;
  const tool = createMemoryTool(api, ctx);
  if (!tool) {
    throw new Error("memory tool disabled");
  }
  return tool;
}

describe("memory tool concurrency", () => {
  it("preserves action errors and releases the lock for the next action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magister-memory-lock-error-"));
    const failure = new Error("action failed");

    await expect(
      withContextLock(dir, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(withContextLock(dir, async () => "recovered")).resolves.toBe("recovered");
  });

  it("does not lose entries when two adds race on the same target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "magister-memory-race-"));
    const tool = makeTool(dir);
    // Fire both adds WITHOUT awaiting the first — without a lock both
    // loadFromDisk() calls see the empty file and the second persist
    // clobbers the first entry (last-writer-wins).
    await Promise.all([
      tool.execute("c1", { action: "add", target: "user", content: "entry one" }),
      tool.execute("c2", { action: "add", target: "user", content: "entry two" }),
    ]);
    const userMd = readFileSync(join(dir, "USER.md"), "utf8");
    expect(userMd).toContain("entry one");
    expect(userMd).toContain("entry two");
  });
});
