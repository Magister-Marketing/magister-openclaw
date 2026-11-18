import fs from "node:fs/promises";
import path from "node:path";

/**
 * Where the host write and edit tools may write on a Magister machine.
 *
 * Those tools run in the OpenClaw host process, outside the tool sandbox, as the
 * host user. `tools.fs.workspaceOnly` cannot bound them there: it also bounds the
 * `read` tool, and the agent reads its skills outside the workspace and edits
 * repository checkouts under the repo root. Left unbounded they could plant code
 * the host later runs (a checkout's `.git/config` or hooks, the askpass helper in
 * the repo root's `.staging`, the host user's Python user site) or rewrite state
 * that decides what the machine may do.
 *
 * The machine entrypoint names the roots (the agent workspace and the repo root).
 * Writes go only below one of them, after following links, and never through a
 * link whose target does not exist yet; never into a `.git` folder; never into
 * the workspace's `.openclaw` (OpenClaw loads workspace plugins from its
 * `extensions`); and, outside the agent's own workspace, never into a root's own
 * dot folders (`/data/repos/.staging`, `/data/repos/.work`). Reads are unaffected.
 */
export const MAGISTER_FILE_WRITE_ROOTS_ENV = "MAGISTER_FILE_WRITE_ROOTS";

/** The configured roots, `null` when unset, `[]` (nothing writable) when invalid. */
export function resolveMagisterWriteRoots(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env[MAGISTER_FILE_WRITE_ROOTS_ENV]?.trim();
  if (!raw) {
    return null;
  }
  return raw
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.resolve(entry));
}

/**
 * The real path of `target`: its deepest existing ancestor resolved, the rest
 * appended. `null` when a missing part is a link (a dangling one), because a
 * write would create that link's target, wherever it points.
 */
async function realTarget(target: string): Promise<string | null> {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      if (
        await fs.lstat(current).then(
          (stat) => stat.isSymbolicLink(),
          () => false,
        )
      ) {
        return null;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.join(current, ...missing);
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function assertMagisterWritablePath(params: {
  target: string;
  roots: readonly string[];
  workspaceRoot: string;
}): Promise<void> {
  const resolved = await realTarget(params.target);
  const workspace = await realTarget(params.workspaceRoot);
  for (const root of params.roots) {
    const realRoot = await realTarget(root);
    if (!resolved || !realRoot) {
      continue;
    }
    const relative = path.relative(realRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    const parts = relative ? relative.split(path.sep) : [];
    const top = parts[0] ?? "";
    const refusedTop = realRoot === workspace ? top === ".openclaw" : top.startsWith(".");
    if (!parts.includes(".git") && !refusedTop) {
      return;
    }
  }
  throw new Error(
    `This machine's file tools can only write inside ${params.roots.join(" or ") || "no folder"}, ` +
      `never through a link to a missing file, into a .git folder, into the workspace's ` +
      `.openclaw, or into a root's own dot folders: ${params.target}`,
  );
}
