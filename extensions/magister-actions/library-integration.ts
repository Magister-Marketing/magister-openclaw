import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { registerWorkspaceFileAuthority } from "openclaw/plugin-sdk/core";
import { createLibraryBridge } from "./library-bridge.js";
import { LibraryRuntime } from "./library-runtime.js";

const runtimes = new Map<string, LibraryRuntime>();
export function hostedLibraryRuntime(workspace?: string): LibraryRuntime | undefined {
  if (!process.env.GATEWAY_TOKEN) return undefined;
  const root = path.resolve(
    workspace ?? process.env.OPENCLAW_WORKSPACE_DIR ?? "/data/.openclaw/workspace",
  );
  let runtime = runtimes.get(root);
  if (!runtime) {
    runtime = new LibraryRuntime(root, createLibraryBridge());
    runtimes.set(root, runtime);
  }
  return runtime;
}

export function registerHostedLibraryAuthority(): void {
  registerWorkspaceFileAuthority({
    version: 1,
    wrap: (tool, context) =>
      hostedLibraryRuntime(context.workspaceDir)?.wrap(tool, context) ?? tool,
    admit: async (workspace) => (await hostedLibraryRuntime(workspace)?.admit()) ?? false,
    legacyWrite: async (workspace, write) => {
      const runtime = hostedLibraryRuntime(workspace);
      return runtime ? runtime.writeLegacyProjection(write) : write();
    },
    readSnapshot: async (workspace, read) => {
      const runtime = hostedLibraryRuntime(workspace);
      return runtime ? runtime.readSnapshot(read) : read();
    },
  });
}

export async function handleLibraryReconcile(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }
  try {
    const runtime = hostedLibraryRuntime();
    const active = (await runtime?.admit()) ?? false;
    const cache = active ? await runtime?.store.cache() : undefined;
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        capability: "library_files_v1",
        active,
        ...(cache
          ? { project_id: cache.project_id, epoch: cache.epoch, sequence: cache.sequence }
          : {}),
      }),
    );
  } catch {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "library_context_unavailable", retryable: true }));
  }
  return true;
}
