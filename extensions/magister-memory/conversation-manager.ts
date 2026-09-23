import { randomUUID } from "node:crypto";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import { KeyedAsyncQueue, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  createConversationSessionState,
  listConversationSessionStates,
  pruneShadowCheckpoints,
  readConversationSessionState,
  removeConversationSessionState,
  selectConversationSessionStatesForPruning,
  writeConversationSessionState,
  writeShadowCheckpoint,
} from "./checkpoint-state.js";
import { appendCheckpoint, listRecentCheckpoints } from "./checkpoint-store.js";
import { buildFallbackSummary, summarizeCheckpoint } from "./checkpoint-summarizer.js";
import { withContextLock } from "./context-lock.js";
import {
  boundEntriesFromEnd,
  containsToolWorkInLatestTurn,
  countUserTurns,
  extractConversationDelta,
  extractTranscriptEntries,
  hashIdentifier,
  isMeaningfulConversation,
  transcriptCharCount,
} from "./conversation-text.js";
import type {
  CheckpointInFlight,
  CheckpointRecord,
  ConversationCheckpointConfig,
  ConversationSessionState,
} from "./conversation-types.js";
import { buildRecentConversationContext } from "./recent-recall.js";

const SERVICE_INTERVAL_MS = 60_000;
const CHECKPOINT_CHAR_THRESHOLD = 10_000;
const CHECKPOINT_USER_TURN_THRESHOLD = 20;
const MAX_MODEL_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const STATE_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_SESSION_STATE_FILES = 500;
const MAX_SHADOW_CHECKPOINT_FILES = 500;
const EXCLUDED_SESSION_PATTERN =
  /(?:^|:)(?:cron|heartbeat|subagent|workflow|reviewer|memory-flush)(?:$|:)/i;

type AgentContext = {
  agentId?: string;
  workspaceDir?: string;
  trigger?: string;
  sessionId?: string;
  sessionKey?: string;
};

type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
};

type CaptureOutcome = {
  workspaceDir: string;
  sessionHash: string;
  forceFinalize: boolean;
};

export class ConversationCheckpointManager {
  private readonly stateQueue = new KeyedAsyncQueue();
  private readonly activeFinalizations = new Set<string>();
  private readonly knownWorkspaces = new Set<string>();
  private readonly lastMaintenanceAt = new Map<string, number>();
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly config: ConversationCheckpointConfig,
  ) {
    for (const agent of api.config.agents?.list ?? []) {
      if (agent.id && agent.id !== "heartbeat") {
        this.knownWorkspaces.add(resolveAgentWorkspaceDir(api.config, agent.id));
      }
    }
  }

  start(workspaceDir?: string): void {
    if (workspaceDir) {
      this.knownWorkspaces.add(workspaceDir);
    }
    if (this.config.mode === "off" || this.interval) {
      return;
    }
    void this.tick();
    this.interval = setInterval(() => void this.tick(), SERVICE_INTERVAL_MS);
    this.interval.unref?.();
    this.api.logger.info(
      `magister-memory: conversation checkpoints started (mode=${this.config.mode}, interval_seconds=60)`,
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  async captureAgentEnd(event: AgentEndEvent, ctx: AgentContext): Promise<void> {
    if (this.config.mode === "off" || !event.success || !this.isInteractiveContext(ctx)) {
      return;
    }
    const outcome = await this.captureMessages(event.messages, ctx);
    if (outcome?.forceFinalize) {
      this.scheduleFinalize(outcome.workspaceDir, outcome.sessionHash, true, "threshold");
    }
  }

  async captureBeforeCompaction(messages: unknown[] | undefined, ctx: AgentContext): Promise<void> {
    if (this.config.mode === "off") {
      return;
    }
    const outcome =
      messages && this.isInteractiveContext(ctx)
        ? await this.captureMessages(messages, ctx)
        : undefined;
    const identity = this.resolveSessionIdentity(ctx);
    const workspaceDir = outcome?.workspaceDir ?? this.resolveWorkspaceDir(ctx);
    const sessionHash = outcome?.sessionHash ?? (identity ? hashIdentifier(identity) : undefined);
    if (sessionHash) {
      this.scheduleFinalize(workspaceDir, sessionHash, true, "compaction");
    }
  }

  scheduleSessionEnd(ctx: AgentContext): void {
    if (this.config.mode === "off") {
      return;
    }
    const identity = this.resolveSessionIdentity(ctx);
    if (!identity) {
      return;
    }
    const workspaceDir = this.resolveWorkspaceDir(ctx);
    const sessionHash = hashIdentifier(identity);
    void this.markSessionEnded(workspaceDir, sessionHash, ctx.agentId ?? "main")
      .then(() => this.scheduleFinalize(workspaceDir, sessionHash, true, "session_end"))
      .catch((error) => {
        this.api.logger.warn(
          `magister-memory: session-end checkpoint failed (error=${errorCode(error)})`,
        );
      });
  }

  async buildPromptContext(ctx: AgentContext): Promise<string | undefined> {
    if (this.config.mode !== "active") {
      return undefined;
    }
    const identity = this.resolveSessionIdentity(ctx);
    if (!identity) {
      return undefined;
    }
    const interactive = this.isInteractiveContext(ctx);
    const workspaceDir = this.resolveWorkspaceDir(ctx);
    const sessionHash = hashIdentifier(identity);
    return this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir,
        sessionHash,
        agentId: ctx.agentId ?? "main",
      });
      if (state.recallFrozen) {
        // Once a session carries recall it keeps it on every turn, whatever
        // the trigger. The block is part of the cached system prompt; a turn
        // that dropped it (approval continuation, cron on the same session)
        // and the next user turn that restored it each re-wrote the prefix.
        return state.frozenRecall;
      }
      if (!interactive) {
        return undefined;
      }
      const checkpoints = (
        await listRecentCheckpoints({
          workspaceDir,
          recentDays: this.config.recentDays,
          userTimezone: this.userTimezone(),
        })
      ).filter((record) => record.sessionHash !== sessionHash);
      const frozenRecall = buildRecentConversationContext({
        checkpoints,
        maxChars: this.config.maxHeaderChars,
      });
      if (!frozenRecall) {
        return undefined;
      }
      state.recallFrozen = true;
      state.frozenRecall = frozenRecall;
      await writeConversationSessionState(workspaceDir, state);
      this.api.logger.debug?.(
        `magister-memory: recent recall frozen (records=${checkpoints.length}, injected_chars=${frozenRecall?.length ?? 0})`,
      );
      return frozenRecall;
    });
  }

  async finalizeSessionForTest(params: {
    workspaceDir: string;
    sessionHash: string;
    force?: boolean;
  }): Promise<void> {
    await this.finalizeSession(params.workspaceDir, params.sessionHash, params.force ?? true);
  }

  private async captureMessages(
    messages: unknown[],
    ctx: AgentContext,
  ): Promise<CaptureOutcome | undefined> {
    const identity = this.resolveSessionIdentity(ctx);
    if (!identity) {
      return undefined;
    }
    const workspaceDir = this.resolveWorkspaceDir(ctx);
    const sessionHash = hashIdentifier(identity);
    const agentId = ctx.agentId ?? "main";
    const entries = extractTranscriptEntries(messages);
    if (entries.length === 0) {
      return undefined;
    }
    this.knownWorkspaces.add(workspaceDir);
    return this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
      const state = await readConversationSessionState({ workspaceDir, sessionHash, agentId });
      const delta = extractConversationDelta(
        entries,
        state.lastMessageFingerprint,
        state.lastMessageCount,
      );
      state.lastMessageFingerprint = entries[entries.length - 1].fingerprint;
      state.lastMessageCount = entries.length;
      if (delta.length === 0) {
        await writeConversationSessionState(workspaceDir, state);
        return { workspaceDir, sessionHash, forceFinalize: false };
      }
      state.lastActivityAt = Date.now();
      if (
        isMeaningfulConversation(delta, {
          hasToolWork: containsToolWorkInLatestTurn(messages),
        })
      ) {
        state.pending = boundEntriesFromEnd(
          [...state.pending, ...delta],
          this.config.maxInputChars * 2,
        );
        state.pendingUserTurns = countUserTurns(state.pending);
      }
      await writeConversationSessionState(workspaceDir, state);
      const forceFinalize =
        transcriptCharCount(state.pending) >= CHECKPOINT_CHAR_THRESHOLD ||
        state.pendingUserTurns >= CHECKPOINT_USER_TURN_THRESHOLD;
      this.api.logger.debug?.(
        `magister-memory: conversation delta captured (delta_messages=${delta.length}, pending_chars=${transcriptCharCount(state.pending)}, force=${forceFinalize})`,
      );
      return { workspaceDir, sessionHash, forceFinalize };
    });
  }

  private async tick(): Promise<void> {
    if (this.config.mode === "off") {
      return;
    }
    for (const workspaceDir of this.knownWorkspaces) {
      try {
        const states = await listConversationSessionStates(workspaceDir);
        const nowMs = Date.now();
        if (
          nowMs - (this.lastMaintenanceAt.get(workspaceDir) ?? 0) >=
          STATE_MAINTENANCE_INTERVAL_MS
        ) {
          await this.maintainCheckpointState(workspaceDir, states, nowMs);
          this.lastMaintenanceAt.set(workspaceDir, nowMs);
        }
        for (const state of states) {
          if (
            (state.inFlight && (!state.retryAt || state.retryAt <= nowMs)) ||
            this.isDue(state, nowMs)
          ) {
            this.scheduleFinalize(workspaceDir, state.sessionHash, false, "service");
          }
        }
      } catch (error) {
        this.api.logger.warn(
          `magister-memory: conversation checkpoint scan failed (error=${errorCode(error)})`,
        );
      }
    }
  }

  private scheduleFinalize(
    workspaceDir: string,
    sessionHash: string,
    force: boolean,
    reason: string,
  ): void {
    const key = `${workspaceDir}:${sessionHash}`;
    if (this.activeFinalizations.has(key)) {
      return;
    }
    this.activeFinalizations.add(key);
    void this.finalizeSession(workspaceDir, sessionHash, force)
      .catch((error) => {
        this.api.logger.warn(
          `magister-memory: conversation checkpoint failed (reason=${reason}, error=${errorCode(error)})`,
        );
      })
      .finally(() => this.activeFinalizations.delete(key));
  }

  private async finalizeSession(
    workspaceDir: string,
    sessionHash: string,
    force: boolean,
  ): Promise<void> {
    const finalizeStartedAt = Date.now();
    const claimed = await this.claimCheckpoint(workspaceDir, sessionHash, force);
    if (!claimed) {
      return;
    }
    let summary = claimed.inFlight.prepared;
    if (!summary) {
      try {
        summary = await summarizeCheckpoint({
          api: this.api,
          config: this.config,
          context: {
            workspaceDir,
            agentId: claimed.agentId,
            sessionHash,
            entries: claimed.inFlight.entries,
            previousSummary: claimed.previousSummary,
          },
        });
      } catch (error) {
        const retryCount = claimed.retryCount + 1;
        if (retryCount < MAX_MODEL_ATTEMPTS) {
          await this.requeueFailedCheckpoint({
            workspaceDir,
            sessionHash,
            checkpointId: claimed.inFlight.checkpointId,
            retryCount,
          });
          this.api.logger.warn(
            `magister-memory: checkpoint summary retry scheduled (retry=${retryCount}, duration_ms=${Date.now() - finalizeStartedAt}, error=${errorCode(error)})`,
          );
          return;
        }
        summary = buildFallbackSummary(
          claimed.inFlight.entries,
          this.config.maxCheckpointChars,
          claimed.previousSummary,
        );
      }
      await this.persistPreparedSummary(
        workspaceDir,
        sessionHash,
        claimed.inFlight.checkpointId,
        summary,
      );
    }

    // Keep the canonical date and marker stable when a prepared write is retried.
    const createdAt = claimed.inFlight.startedAt;
    const record: CheckpointRecord = {
      version: 1,
      checkpointId: claimed.inFlight.checkpointId,
      sessionHash,
      sequence: claimed.inFlight.sequence,
      startFingerprint: claimed.inFlight.startFingerprint,
      endFingerprint: claimed.inFlight.endFingerprint,
      createdAt,
      summary: summary.summary,
      topics: summary.topics,
    };
    try {
      if (this.config.mode === "active") {
        await withContextLock(workspaceDir, async () => {
          await appendCheckpoint({
            workspaceDir,
            userTimezone: this.userTimezone(),
            record,
          });
        });
      } else {
        await writeShadowCheckpoint({
          workspaceDir,
          checkpointId: record.checkpointId,
          sessionHash,
          sequence: record.sequence,
          createdAt,
          summary,
        });
      }
      await this.completeCheckpoint({
        workspaceDir,
        sessionHash,
        checkpointId: record.checkpointId,
        summary: summary.summary,
        sequence: record.sequence,
      });
    } catch (error) {
      await this.deferPreparedCheckpoint({
        workspaceDir,
        sessionHash,
        checkpointId: record.checkpointId,
      }).catch(() => undefined);
      throw error;
    }
    this.api.logger.info(
      `magister-memory: conversation checkpoint stored (mode=${this.config.mode}, duration_ms=${Date.now() - finalizeStartedAt}, summary_source=${summary.source}, summary_chars=${summary.summary.length})`,
    );
  }

  private async claimCheckpoint(
    workspaceDir: string,
    sessionHash: string,
    force: boolean,
  ): Promise<
    | {
        agentId: string;
        previousSummary?: string;
        retryCount: number;
        inFlight: CheckpointInFlight;
      }
    | undefined
  > {
    return this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir,
        sessionHash,
        agentId: "main",
      });
      if (state.retryAt !== undefined && state.retryAt > Date.now()) {
        return undefined;
      }
      if (state.inFlight) {
        return {
          agentId: state.agentId,
          previousSummary: state.previousSummary,
          retryCount: state.retryCount,
          inFlight: state.inFlight,
        };
      }
      const nowMs = Date.now();
      if (state.pending.length === 0) {
        if (state.endedAt !== undefined && !state.inFlight) {
          await removeConversationSessionState(workspaceDir, sessionHash);
        }
        return undefined;
      }
      if (!force && !this.isDue(state, nowMs)) {
        return undefined;
      }
      const entries = state.pending;
      const inFlight: CheckpointInFlight = {
        checkpointId: randomUUID(),
        entries,
        startedAt: Date.now(),
        sequence: state.sequence + 1,
        startFingerprint: entries[0].fingerprint,
        endFingerprint: entries.at(-1)?.fingerprint ?? entries[0].fingerprint,
      };
      state.pending = [];
      state.pendingUserTurns = 0;
      state.inFlight = inFlight;
      await writeConversationSessionState(workspaceDir, state);
      return {
        agentId: state.agentId,
        previousSummary: state.previousSummary,
        retryCount: state.retryCount,
        inFlight,
      };
    });
  }

  private async persistPreparedSummary(
    workspaceDir: string,
    sessionHash: string,
    checkpointId: string,
    summary: NonNullable<CheckpointInFlight["prepared"]>,
  ): Promise<void> {
    await this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir,
        sessionHash,
        agentId: "main",
      });
      if (state.inFlight?.checkpointId !== checkpointId) {
        throw new Error("checkpoint_claim_changed");
      }
      state.inFlight.prepared = summary;
      await writeConversationSessionState(workspaceDir, state);
    });
  }

  private async requeueFailedCheckpoint(params: {
    workspaceDir: string;
    sessionHash: string;
    checkpointId: string;
    retryCount: number;
  }): Promise<void> {
    await this.stateQueue.enqueue(`${params.workspaceDir}:${params.sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir: params.workspaceDir,
        sessionHash: params.sessionHash,
        agentId: "main",
      });
      if (state.inFlight?.checkpointId !== params.checkpointId) {
        return;
      }
      state.pending = boundEntriesFromEnd(
        [...state.inFlight.entries, ...state.pending],
        this.config.maxInputChars * 2,
      );
      state.pendingUserTurns = countUserTurns(state.pending);
      state.retryCount = params.retryCount;
      state.retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(params.retryCount - 1, 2)];
      delete state.inFlight;
      await writeConversationSessionState(params.workspaceDir, state);
    });
  }

  private async completeCheckpoint(params: {
    workspaceDir: string;
    sessionHash: string;
    checkpointId: string;
    summary: string;
    sequence: number;
  }): Promise<void> {
    await this.stateQueue.enqueue(`${params.workspaceDir}:${params.sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir: params.workspaceDir,
        sessionHash: params.sessionHash,
        agentId: "main",
      });
      if (state.inFlight?.checkpointId !== params.checkpointId) {
        return;
      }
      delete state.inFlight;
      delete state.retryAt;
      state.retryCount = 0;
      state.sequence = Math.max(state.sequence, params.sequence);
      state.previousSummary = params.summary;
      if (state.endedAt !== undefined && state.pending.length === 0) {
        await removeConversationSessionState(params.workspaceDir, params.sessionHash);
      } else {
        await writeConversationSessionState(params.workspaceDir, state);
      }
    });
  }

  private async markSessionEnded(
    workspaceDir: string,
    sessionHash: string,
    agentId: string,
  ): Promise<void> {
    await this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
      const state = await readConversationSessionState({ workspaceDir, sessionHash, agentId });
      state.endedAt = Date.now();
      await writeConversationSessionState(workspaceDir, state);
    });
  }

  private async maintainCheckpointState(
    workspaceDir: string,
    states: ConversationSessionState[],
    nowMs: number,
  ): Promise<void> {
    const retentionMs = Math.max(STATE_RETENTION_MS, this.config.recentDays * 24 * 60 * 60 * 1_000);
    const stateByHash = new Map(states.map((state) => [state.sessionHash, state]));
    const selected = selectConversationSessionStatesForPruning({
      states,
      nowMs,
      retentionMs,
      maxStates: MAX_SESSION_STATE_FILES,
    });
    let sessionsDeleted = 0;
    for (const sessionHash of selected) {
      const snapshot = stateByHash.get(sessionHash);
      if (!snapshot) {
        continue;
      }
      await this.stateQueue.enqueue(`${workspaceDir}:${sessionHash}`, async () => {
        const current = await readConversationSessionState({
          workspaceDir,
          sessionHash,
          agentId: snapshot.agentId,
        });
        if (
          current.updatedAt !== snapshot.updatedAt ||
          current.pending.length > 0 ||
          current.inFlight ||
          current.retryAt !== undefined
        ) {
          return;
        }
        await removeConversationSessionState(workspaceDir, sessionHash);
        sessionsDeleted += 1;
      });
    }
    const shadowDeleted = await pruneShadowCheckpoints({
      workspaceDir,
      nowMs,
      retentionMs,
      maxFiles: MAX_SHADOW_CHECKPOINT_FILES,
    });
    if (sessionsDeleted > 0 || shadowDeleted > 0) {
      this.api.logger.info(
        `magister-memory: pruned checkpoint state (sessions=${sessionsDeleted}, shadow=${shadowDeleted})`,
      );
    }
  }

  private async deferPreparedCheckpoint(params: {
    workspaceDir: string;
    sessionHash: string;
    checkpointId: string;
  }): Promise<void> {
    await this.stateQueue.enqueue(`${params.workspaceDir}:${params.sessionHash}`, async () => {
      const state = await readConversationSessionState({
        workspaceDir: params.workspaceDir,
        sessionHash: params.sessionHash,
        agentId: "main",
      });
      if (state.inFlight?.checkpointId !== params.checkpointId) {
        return;
      }
      state.retryAt = Date.now() + RETRY_DELAYS_MS[1];
      await writeConversationSessionState(params.workspaceDir, state);
    });
  }

  private isDue(state: ConversationSessionState, nowMs: number): boolean {
    if (state.pending.length === 0 || (state.retryAt && state.retryAt > nowMs)) {
      return false;
    }
    return nowMs - state.lastActivityAt >= this.config.idleMinutes * 60_000;
  }

  private isInteractiveContext(ctx: AgentContext): boolean {
    const identity = this.resolveSessionIdentity(ctx) ?? "";
    return (
      ctx.trigger === "user" &&
      ctx.agentId !== "heartbeat" &&
      !EXCLUDED_SESSION_PATTERN.test(`${identity}:${ctx.agentId ?? ""}`)
    );
  }

  private resolveWorkspaceDir(ctx: AgentContext): string {
    const workspace =
      ctx.workspaceDir ?? resolveAgentWorkspaceDir(this.api.config, ctx.agentId ?? "main");
    this.knownWorkspaces.add(workspace);
    return workspace;
  }

  private resolveSessionIdentity(ctx: AgentContext): string | undefined {
    return ctx.sessionId ?? ctx.sessionKey;
  }

  private userTimezone(): string | undefined {
    return this.api.config.agents?.defaults?.userTimezone;
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 40);
  }
  if (
    error instanceof Error &&
    /^[a-zA-Z0-9_.:-]{1,80}$/.test(error.message) &&
    (error.message.startsWith("checkpoint_") || error.message.startsWith("memory_"))
  ) {
    return error.message;
  }
  if (error instanceof Error && error.name) {
    return error.name.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 40);
  }
  return "unknown";
}

export { createConversationSessionState };
