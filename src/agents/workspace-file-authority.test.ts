import { describe, expect, it, vi } from "vitest";
import { planWorkspacePatch } from "./apply-patch.js";
import {
  readWorkspaceFileSnapshot,
  registerWorkspaceFileAuthority,
  WorkspaceFileAuthorityError,
} from "./workspace-file-authority.js";

it("fails closed on snapshot admission but preserves context callback failures", async () => {
  const unregister = registerWorkspaceFileAuthority({
    version: 1,
    wrap: (tool) => tool,
    admit: async () => true,
    readSnapshot: async (_workspace, read) => read(),
  });
  const engineError = new Error("context engine failed");
  try {
    await expect(
      readWorkspaceFileSnapshot("/workspace", async () => {
        throw engineError;
      }),
    ).rejects.toBe(engineError);
  } finally {
    unregister();
  }
  const remove = registerWorkspaceFileAuthority({
    version: 1,
    wrap: (tool) => tool,
    admit: async () => true,
    readSnapshot: async () => {
      throw new Error("storage unavailable");
    },
  });
  try {
    await expect(
      readWorkspaceFileSnapshot("/workspace", async () => "must not run"),
    ).rejects.toBeInstanceOf(WorkspaceFileAuthorityError);
  } finally {
    remove();
  }
});

describe("workspace patch authority planning", () => {
  it("exposes every source/destination before reading and stages all changes without I/O mutations", async () => {
    const plan = planWorkspacePatch(
      "*** Begin Patch\n*** Update File: resources/a.md\n*** Move to: resources/new.md\n@@\n-one\n+edited\n*** Add File: scratch.txt\n+new\n*** Delete File: resources/old.md\n*** End Patch",
    );
    expect(plan.paths).toEqual([
      "resources/a.md",
      "resources/new.md",
      "scratch.txt",
      "resources/old.md",
    ]);
    const reader = vi.fn(async () => "one\n");
    expect(await plan.stage(reader)).toEqual([
      { kind: "update", path: "resources/a.md", movePath: "resources/new.md", text: "edited\n" },
      { kind: "add", path: "scratch.txt", text: "new\n" },
      { kind: "delete", path: "resources/old.md" },
    ]);
    expect(reader).toHaveBeenCalledExactlyOnceWith("resources/a.md");
  });
});
