import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { renderMagisterContextBlock } from "./magister-provenance.js";
import { MagisterWorkflowsContextEngine } from "./magister-workflows.js";
import { registerContextEngine } from "./registry.js";
import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  ContextEngineRuntimeContext,
  IngestResult,
} from "./types.js";

const DEFAULT_PLAN_MD_PATH = "/data/.openclaw/workspace/PLAN.md";
const DEFAULT_GATEWAY_BASE_URL = "http://magister-gateway.internal:8081";
const DEFAULT_TIMEOUT_MS = 750;
const MAX_TRACKED_SESSIONS = 200;
const MAX_PLAN_CHARS = 2500;

type FetchLike = (
  input: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

type Options = {
  fallbackPath?: string;
  gatewayBaseUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
  inner?: ContextEngine;
  fetchImpl?: FetchLike;
};

type PlanSummaryPayload = {
  plan_id?: string | null;
  version?: number | null;
  updated_at?: string | null;
  summary_hash?: string | null;
  summary?: string | null;
};

type PlanContext = { summary: string; live: boolean };

let inFlightSummary: Promise<string | null> | null = null;
let warnedThisProcess = false;

/**
 * Folds the current live marketing plan into every turn.
 *
 * Primary source is the gateway's machine-token-scoped summary endpoint. If
 * that is unavailable, it falls back to the last materialized PLAN.md snapshot.
 */
export class MagisterPlanContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "magister-plan",
    name: "Magister Live Plan Context Engine",
    version: "1.0.0",
  };

  private readonly inner: ContextEngine;
  private readonly fallbackPath: string;
  private readonly gatewayBaseUrl: string;
  private readonly gatewayToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly lastSeenHash = new Map<string, string>();

  constructor(options: Options = {}) {
    this.inner = options.inner ?? new MagisterWorkflowsContextEngine();
    this.fallbackPath = options.fallbackPath ?? DEFAULT_PLAN_MD_PATH;
    this.gatewayBaseUrl = (
      options.gatewayBaseUrl ??
      process.env.GATEWAY_INTERNAL_URL ??
      DEFAULT_GATEWAY_BASE_URL
    ).replace(/\/+$/, "");
    this.gatewayToken = (
      options.gatewayToken ??
      process.env.GATEWAY_TOKEN ??
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      ""
    ).trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return this.inner.ingest(params);
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const [innerResult, planContext] = await Promise.all([
      this.inner.assemble(params),
      this.readPlanSummary(),
    ]);

    if (!planContext) {
      return innerResult;
    }

    const { summary: planSummary, live } = planContext;
    const hash = createHash("sha256").update(`${live}:${planSummary}`).digest("hex");
    const previousHash = this.lastSeenHash.get(params.sessionId);
    const changed = previousHash !== undefined && previousHash !== hash;
    this.rememberHash(params.sessionId, hash);

    const note =
      changed && live
        ? "Note: the live marketing plan changed since your last reply. Use the current plan below as the operating source of truth.\n\n"
        : "";
    const block = renderMagisterContextBlock({
      provenance: "trusted_project_state",
      source: live ? "live_marketing_plan" : "cached_marketing_plan",
      content: `${note}${planSummary.trimEnd()}`,
    });

    const previous = innerResult.systemPromptAddition?.trim();
    const merged = previous ? `${previous}\n\n${block}` : block;
    return { ...innerResult, systemPromptAddition: merged };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
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
    sessionKey?: string;
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

  private async readPlanSummary(): Promise<PlanContext | null> {
    const gatewaySummary = await this.fetchGatewaySummary();
    if (gatewaySummary) {
      return { summary: gatewaySummary, live: true };
    }
    const summary = await this.readFallbackPlanMd();
    return summary ? { summary, live: false } : null;
  }

  private async fetchGatewaySummary(): Promise<string | null> {
    if (!this.gatewayToken) {
      return null;
    }
    if (inFlightSummary) {
      return inFlightSummary;
    }
    inFlightSummary = this.fetchGatewaySummaryUncached().finally(() => {
      inFlightSummary = null;
    });
    return inFlightSummary;
  }

  private async fetchGatewaySummaryUncached(): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.gatewayBaseUrl}/api/orchestrator/current-plan/summary`,
        {
          headers: { Authorization: `Bearer ${this.gatewayToken}` },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        this.warnOnce(`gateway returned ${response.status}`);
        return null;
      }
      const payload = (await response.json()) as PlanSummaryPayload;
      const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
      return summary ? this.withPlanHeading(summary.slice(0, MAX_PLAN_CHARS)) : null;
    } catch (err) {
      this.warnOnce((err as Error).message || "gateway summary fetch failed");
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readFallbackPlanMd(): Promise<string | null> {
    try {
      const content = (await readFile(this.fallbackPath, "utf8")).trim();
      if (!content) {
        return null;
      }
      return [
        "## Cached Marketing Plan — current state unavailable",
        "",
        "The live plan could not be fetched. This snapshot may be outdated: refresh current item state before asking the user to approve, complete or reopen anything. Do not treat a cached approval requirement as a current blocker. If refresh fails, explain that the current state is unverified.",
        "",
        content.slice(0, MAX_PLAN_CHARS),
      ].join("\n");
    } catch {
      return null;
    }
  }

  private warnOnce(reason: string): void {
    if (warnedThisProcess) {
      return;
    }
    warnedThisProcess = true;
    console.warn(`[magister-plan] using PLAN.md fallback: ${reason}`);
  }

  private rememberHash(sessionId: string, hash: string): void {
    this.lastSeenHash.delete(sessionId);
    this.lastSeenHash.set(sessionId, hash);
    pruneMapToMaxSize(this.lastSeenHash, MAX_TRACKED_SESSIONS);
  }

  private withPlanHeading(summary: string): string {
    if (/^#{1,6}\s+Current Marketing Plan\b/im.test(summary)) {
      return summary;
    }
    return `## Current Marketing Plan\n\n${summary}`;
  }
}

export function registerMagisterPlanContextEngine(): void {
  registerContextEngine(
    "magister-plan",
    () =>
      new MagisterPlanContextEngine({
        inner: new MagisterWorkflowsContextEngine(),
      }),
  );
}
