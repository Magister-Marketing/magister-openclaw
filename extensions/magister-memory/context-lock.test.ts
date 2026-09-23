import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withContextLock } from "./context-lock.js";

const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "magister-context-lock-"));
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true })));
});

describe("withContextLock", () => {
  it("returns the action result and removes the lock", async () => {
    const workspace = await createWorkspace();
    const lockPath = join(workspace, ".magister", "locks", "context.lock");

    await expect(withContextLock(workspace, () => Promise.resolve("done"))).resolves.toBe("done");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves both the action failure and an ownership-change cleanup failure", async () => {
    const workspace = await createWorkspace();
    const lockPath = join(workspace, ".magister", "locks", "context.lock");
    const ownerPath = join(lockPath, "owner.json");
    const actionFailure = new Error("action failed");

    const failure = await withContextLock(workspace, async () => {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
      await writeFile(ownerPath, `${JSON.stringify({ ...owner, token: "different-owner" })}\n`);
      throw actionFailure;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(actionFailure);
    expect((failure as AggregateError).errors[1]).toMatchObject({
      message: "context lock ownership changed",
    });
  });
});
