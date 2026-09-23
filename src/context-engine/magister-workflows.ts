import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { LegacyContextEngine } from "./legacy.js";
import { MagisterIntegrationsContextEngine } from "./magister-integrations.js";
import { renderMagisterContextBlock } from "./magister-provenance.js";
import { registerContextEngine } from "./registry.js";
import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  ContextEngineRuntimeContext,
  IngestResult,
} from "./types.js";

const DEFAULT_WORKFLOWS_MD_PATH = "/data/.openclaw/workspace/WORKFLOWS.md";
const MAX_TRACKED_SESSIONS = 200;

type Options = {
  filePath?: string;
  inner?: ContextEngine;
};

/**
 * Wraps an inner ContextEngine to fold WORKFLOWS.md into the per-turn system
 * prompt and emit a one-shot diff note when the file content changes between
 * turns in the same session.
 *
 * The Magister gateway rewrites WORKFLOWS.md on the project machine whenever
 * a project's workflows change (create/fork/update/delete/run-complete,
 * debounced) and at session start. The agent reads workspace files at session
 * start, but without this engine, mid-session workflow changes stay invisible
 * until the next session. Fold-in here runs on every assemble() call — chat
 * and workflow paths share the call site — so the agent's view of configured
 * workflows is always-current.
 */
export class MagisterWorkflowsContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "magister-workflows",
    name: "Magister Workflows Context Engine",
    version: "1.0.0",
  };

  private readonly inner: ContextEngine;
  private readonly filePath: string;
  private readonly lastSeenHash = new Map<string, string>();

  constructor(options: Options = {}) {
    this.inner = options.inner ?? new LegacyContextEngine();
    this.filePath = options.filePath ?? DEFAULT_WORKFLOWS_MD_PATH;
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return this.inner.ingest(params);
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const [innerResult, content] = await Promise.all([
      this.inner.assemble(params),
      this.readWorkflowsMd(),
    ]);

    if (content === null) {
      return innerResult;
    }

    const hash = createHash("sha256").update(content).digest("hex");
    const previousHash = this.lastSeenHash.get(params.sessionId);
    const changed = previousHash !== undefined && previousHash !== hash;
    this.rememberHash(params.sessionId, hash);

    const note = changed
      ? "Note: workflows changed since your last reply. The Available Workflows section below is the current authoritative state.\n\n"
      : "";
    const block = renderMagisterContextBlock({
      provenance: "trusted_project_state",
      source: "workflow_summary",
      title: "Available Workflows",
      content: `${note}${content.trimEnd()}`,
    });

    const previous = innerResult.systemPromptAddition?.trim();
    const merged = previous ? `${previous}\n\n${block}` : block;

    return { ...innerResult, systemPromptAddition: merged };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    if (this.inner.afterTurn) {
      await this.inner.afterTurn(params);
    }
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    return this.inner.compact(params);
  }

  async dispose(): Promise<void> {
    if (this.inner.dispose) {
      await this.inner.dispose();
    }
    this.lastSeenHash.clear();
  }

  private async readWorkflowsMd(): Promise<string | null> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch {
      return null;
    }
  }

  private rememberHash(sessionId: string, hash: string): void {
    // Map preserves insertion order; re-inserting on hit gives LRU eviction.
    this.lastSeenHash.delete(sessionId);
    this.lastSeenHash.set(sessionId, hash);
    pruneMapToMaxSize(this.lastSeenHash, MAX_TRACKED_SESSIONS);
  }
}

export function registerMagisterWorkflowsContextEngine(): void {
  // Compose with magister-integrations so the active slot can fold BOTH
  // INTEGRATIONS.md and WORKFLOWS.md. The chain is:
  //   MagisterWorkflowsContextEngine → MagisterIntegrationsContextEngine → LegacyContextEngine
  // Each wrapper adds its own systemPromptAddition. The entrypoint.sh
  // change in the gateway repo moves the slot from 'magister-integrations' to
  // 'magister-workflows' so this composed factory becomes active.
  registerContextEngine(
    "magister-workflows",
    () =>
      new MagisterWorkflowsContextEngine({
        inner: new MagisterIntegrationsContextEngine(),
      }),
  );
}
