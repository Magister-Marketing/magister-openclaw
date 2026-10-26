/**
 * Turn budget: a one-line nudge when a run has worked too long without a reply.
 *
 * On lane onepr (2026-10-20) an agent worked six minutes in one turn, 26 model
 * calls, without replying, until the person cancelled. The only hook that
 * runs per tool call and can change what the model sees next is
 * `before_tool_call`, so the nudge is delivered the way the tool-loop
 * detector delivers its critical warning: the call is vetoed once and its
 * reason is the tool result the model reads. The model then replies, or
 * re-issues the call, which goes through — a nudge costs one round trip, not
 * the tool.
 *
 * What the hooks can see: the run's start (before_prompt_build), each tool
 * call's start and end (before_tool_call, after_tool_call) and the run's end
 * (agent_end). Whether the assistant has already written a text block
 * mid-turn is not observable from a plugin (llm_input / llm_output fire per
 * attempt, not per model call), so the budget resets on each nudge and on the
 * tools that are themselves a reply.
 *
 * The clock counts the agent's own time only: it stops while any tool runs,
 * so an approval card the person takes four minutes to decide, or a slow
 * fetch, is not time spent working without replying. And it applies only to
 * chats a person is waiting in; a workflow step, a cron job or a subagent has
 * nobody to reply to, and a nudge there would end the step on a question
 * nobody answers.
 */

export type TurnBudgetConfig = {
  /** Minutes of work before a nudge; 0 disables the clock. */
  minutes: number;
  /** Tool calls before a nudge; 0 disables the count. */
  toolCalls: number;
};

export const DEFAULT_TURN_BUDGET: TurnBudgetConfig = { minutes: 5, toolCalls: 25 };

/** Tools that deliver a message to the person: they are the reply. */
const REPLY_TOOLS = new Set(["message", "sessions_yield", "sessions_send"]);

/**
 * Session keys of a chat a person is waiting in: web chat, Slack, and the
 * Getting Started chat, which keeps the onboarding kickoff's key. A stored
 * key carries an `agent:<id>:` qualifier; a kickoff key is bare.
 */
const INTERACTIVE_SESSION_RE = /^(?:(?:agent:[^:]+:)?(?:webchat|slack):|audit_kickoff:)/i;

export function isInteractiveSession(sessionKey: string | undefined): boolean {
  return sessionKey !== undefined && INTERACTIVE_SESSION_RE.test(sessionKey);
}

type RunState = {
  /** The agent's own time banked in this window, while no tool ran. */
  workedMs: number;
  /** When the clock last restarted; undefined while a tool runs. */
  resumedAt: number | undefined;
  /** The calls running now, by tool call id. */
  running: Set<string>;
  windowToolCalls: number;
  nudges: number;
};

export function resolveTurnBudgetConfig(raw: unknown): TurnBudgetConfig {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const minutes = numberOr(value.minutes, DEFAULT_TURN_BUDGET.minutes);
  const toolCalls = numberOr(value.toolCalls, DEFAULT_TURN_BUDGET.toolCalls);
  return { minutes, toolCalls };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function turnBudgetNudge(params: { minutes: number; toolCalls: number }): string {
  const minutes = Math.max(1, Math.round(params.minutes));
  return (
    `You have worked ${minutes} minute${minutes === 1 ? "" : "s"} ` +
    `(${params.toolCalls} tool calls) without replying. ` +
    "Reply now with what you have, and ask one question if you are blocked."
  );
}

export class TurnBudget {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly config: TurnBudgetConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get enabled(): boolean {
    return this.config.minutes > 0 || this.config.toolCalls > 0;
  }

  /** A run started (before_prompt_build); a repeat for the same run is a no-op. */
  start(runId: string | undefined): void {
    if (!runId || !this.enabled || this.runs.has(runId)) {
      return;
    }
    this.runs.set(runId, {
      workedMs: 0,
      resumedAt: this.now(),
      running: new Set(),
      windowToolCalls: 0,
      nudges: 0,
    });
  }

  /**
   * A tool is about to run. Returns the nudge when the window is spent, and
   * starts the next window; otherwise undefined, the call goes through and the
   * clock stops until it ends. A call without an id cannot be matched to its
   * end, so the clock keeps running through it.
   */
  noteToolCall(
    runId: string | undefined,
    toolName: string,
    toolCallId?: string,
  ): string | undefined {
    if (!runId || !this.enabled) {
      return undefined;
    }
    let state = this.runs.get(runId);
    if (!state) {
      this.start(runId);
      state = this.runs.get(runId);
      if (!state) {
        return undefined;
      }
    }
    if (REPLY_TOOLS.has(toolName)) {
      this.restartWindow(state);
    } else {
      state.windowToolCalls += 1;
      const workedMinutes = this.workedMs(state) / 60_000;
      const overClock = this.config.minutes > 0 && workedMinutes >= this.config.minutes;
      const overCount = this.config.toolCalls > 0 && state.windowToolCalls > this.config.toolCalls;
      if (overClock || overCount) {
        const nudge = turnBudgetNudge({
          minutes: workedMinutes,
          toolCalls: state.windowToolCalls,
        });
        this.restartWindow(state);
        state.nudges += 1;
        return nudge;
      }
    }
    if (toolCallId) {
      state.workedMs = this.workedMs(state);
      state.resumedAt = undefined;
      state.running.add(toolCallId);
    }
    return undefined;
  }

  /** A tool call ended (after_tool_call); the clock restarts once none runs. */
  noteToolEnd(runId: string | undefined, toolCallId: string | undefined): void {
    const state = runId ? this.runs.get(runId) : undefined;
    if (!state || !toolCallId || !state.running.delete(toolCallId)) {
      return;
    }
    if (state.running.size === 0) {
      state.resumedAt = this.now();
    }
  }

  private workedMs(state: RunState): number {
    return state.workedMs + (state.resumedAt === undefined ? 0 : this.now() - state.resumedAt);
  }

  private restartWindow(state: RunState): void {
    state.workedMs = 0;
    state.windowToolCalls = 0;
    if (state.running.size === 0) {
      state.resumedAt = this.now();
    }
  }

  /** The run ended (agent_end). */
  end(runId: string | undefined): void {
    if (runId) {
      this.runs.delete(runId);
    }
  }

  /** How many nudges a run has received; for tests and diagnostics. */
  nudgesFor(runId: string): number {
    return this.runs.get(runId)?.nudges ?? 0;
  }
}
