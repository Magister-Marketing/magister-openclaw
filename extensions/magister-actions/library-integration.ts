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
    admit: async (workspace, options) =>
      (await hostedLibraryRuntime(workspace)?.admit({ turnId: options?.turnId })) ?? false,
    authoritative: async (workspace) =>
      (await hostedLibraryRuntime(workspace)?.activated()) ?? false,
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

/** The Gateway's turn id from the reconcile body (`turn_id`). Bounded and
 * optional: no body, a bad one, or an older Gateway is no turn, which only
 * means run setup crosses the barrier again, as it always did. */
async function reconcileTurnId(req: IncomingMessage): Promise<string | undefined> {
  if (req.readableEnded) return undefined;
  const body = await new Promise<string>((resolve) => {
    let text = "";
    const done = (value: string) => {
      clearTimeout(timer);
      req.removeAllListeners("data");
      resolve(value);
    };
    const timer = setTimeout(() => done(""), 1_000);
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 4_096) done("");
    });
    req.on("end", () => done(text));
    req.on("error", () => done(""));
  });
  try {
    const turnId = (JSON.parse(body) as { turn_id?: unknown }).turn_id;
    return typeof turnId === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(turnId) ? turnId : undefined;
  } catch {
    return undefined;
  }
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
    const turnId = await reconcileTurnId(req);
    const mode = (await runtime?.admissionMode({ fromGateway: true, turnId })) ?? "legacy";
    const active = mode === "active";
    const cache = active ? await runtime?.store.cache() : undefined;
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        capability: "library_files_v1",
        mode,
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
