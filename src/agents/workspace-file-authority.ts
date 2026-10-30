import type { AnyAgentTool } from "./pi-tools.types.js";

export type WorkspacePatchChange =
  | { kind: "add" | "update"; path: string; text: string; movePath?: string }
  | { kind: "delete"; path: string };

export type WorkspacePatchPlan = {
  paths: string[];
  stage: (read: (path: string) => Promise<string>) => Promise<WorkspacePatchChange[]>;
};

export type WorkspaceFileAuthorityContext = {
  workspaceDir: string;
  sessionId?: string;
  sessionKey?: string;
  planPatch: (input: string) => WorkspacePatchPlan;
};

/** Host-owned file tools keep their schemas and policy guards. A storage plugin
 * may add durable admission/commit semantics without replacing tool discovery. */
export type WorkspaceFileAuthority = {
  version: 1;
  wrap: (tool: AnyAgentTool, context: WorkspaceFileAuthorityContext) => AnyAgentTool;
  admit: (workspaceDir: string) => Promise<boolean>;
  readSnapshot?: <T>(workspaceDir: string, read: () => Promise<T>) => Promise<T>;
  legacyWrite?: (workspaceDir: string, write: () => Promise<void>) => Promise<void>;
};

/** Awaited outside best-effort plugin hooks: storage admission must fail closed. */
export async function admitWorkspaceFiles(workspaceDir: string): Promise<boolean> {
  return (await authority?.admit(workspaceDir)) ?? false;
}

/** Source plugins keep old local projections only while that authority owns them. */
export async function writeLegacyWorkspaceFile(
  workspaceDir: string,
  write: () => Promise<void>,
): Promise<void> {
  if (authority?.legacyWrite) return authority.legacyWrite(workspaceDir, write);
  return write();
}

let authority: WorkspaceFileAuthority | undefined;

export class WorkspaceFileAuthorityError extends Error {}

export async function readWorkspaceFileSnapshot<T>(
  workspaceDir: string,
  read: () => Promise<T>,
): Promise<T> {
  if (!authority?.readSnapshot) return read();
  let callbackFailed = false;
  try {
    return await authority.readSnapshot(workspaceDir, async () => {
      try {
        return await read();
      } catch (error) {
        callbackFailed = true;
        throw error;
      }
    });
  } catch (cause) {
    // Preserve existing context-engine error handling. Only storage admission
    // or snapshot failures must bypass the runner's best-effort fallback.
    if (callbackFailed) throw cause;
    throw new WorkspaceFileAuthorityError("Workspace file snapshot is unavailable", { cause });
  }
}

export function registerWorkspaceFileAuthority(value: WorkspaceFileAuthority): () => void {
  authority = value;
  return () => {
    if (authority === value) authority = undefined;
  };
}

export function wrapWorkspaceFileAuthority(
  tool: AnyAgentTool,
  context: WorkspaceFileAuthorityContext,
): AnyAgentTool {
  return authority?.wrap(tool, context) ?? tool;
}
