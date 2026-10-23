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
 * call (before_tool_call) and its end (agent_end). Whether the assistant has
 * already written a text block mid-turn is not observable from a plugin
 * (llm_input / llm_output fire per attempt, not per model call), so the budget
 * resets on each nudge and on the tools that are themselves a reply.
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

type RunState = { windowStartedAt: number; windowToolCalls: number; nudges: number };

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
    this.runs.set(runId, { windowStartedAt: this.now(), windowToolCalls: 0, nudges: 0 });
  }

  /**
   * A tool is about to run. Returns the nudge when the window is spent, and
   * starts the next window; otherwise undefined and the call goes through.
   */
  noteToolCall(runId: string | undefined, toolName: string): string | undefined {
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
      state.windowStartedAt = this.now();
      state.windowToolCalls = 0;
      return undefined;
    }
    state.windowToolCalls += 1;
    const elapsedMinutes = (this.now() - state.windowStartedAt) / 60_000;
    const overClock = this.config.minutes > 0 && elapsedMinutes >= this.config.minutes;
    const overCount = this.config.toolCalls > 0 && state.windowToolCalls > this.config.toolCalls;
    if (!overClock && !overCount) {
      return undefined;
    }
    const nudge = turnBudgetNudge({ minutes: elapsedMinutes, toolCalls: state.windowToolCalls });
    state.windowStartedAt = this.now();
    state.windowToolCalls = 0;
    state.nudges += 1;
    return nudge;
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
