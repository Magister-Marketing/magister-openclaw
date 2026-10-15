import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { SAFETY_MARGIN, estimateMessagesTokens } from "../../compaction.js";
import {
  MIN_PROMPT_BUDGET_RATIO,
  MIN_PROMPT_BUDGET_TOKENS,
} from "../../pi-compaction-constants.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import { MID_TURN_PRECHECK_ERROR_MESSAGE } from "./midturn-precheck.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

/** The error an attempt ends with to hand the run loop a compact-and-retry. */
export function isPreemptiveOverflowSignal(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message === PREEMPTIVE_OVERFLOW_ERROR_TEXT ||
      err.message === MID_TURN_PRECHECK_ERROR_MESSAGE)
  );
}

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

export type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const DEFAULT_PROACTIVE_COMPACTION_THRESHOLD_RATIO = 0.5;

/**
 * Resolve the proactive turn-boundary compaction threshold from config.
 *
 * Returns a ratio in the open interval (0, 1) of the prompt budget (context
 * window minus reserve) above which a turn should compact prior history
 * BEFORE submitting its first prompt, or undefined when the feature is
 * disabled. Unset defaults to 0.5; an explicit 0 or 1 disables. The default
 * lives in code rather than in a deployed config file on purpose: the
 * compaction config schema is strict, so a persisted key would make every
 * config written by this version invalid under a rolled-back older bundle.
 */
export function resolveProactiveCompactionThresholdRatio(
  cfg: OpenClawConfig | undefined,
): number | undefined {
  const raw = cfg?.agents?.defaults?.compaction?.proactiveThresholdRatio;
  if (raw === undefined || raw === null) {
    return DEFAULT_PROACTIVE_COMPACTION_THRESHOLD_RATIO;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return raw > 0 && raw < 1 ? raw : undefined;
}

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const { messages, systemPrompt, prompt } = params;
  const syntheticMessages: AgentMessage[] = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
    syntheticMessages.push({
      role: "system",
      content: systemPrompt,
      timestamp: 0,
    } as unknown as AgentMessage);
  }
  syntheticMessages.push({ role: "user", content: prompt, timestamp: 0 } as AgentMessage);

  const estimated =
    estimateMessagesTokens(messages) +
    syntheticMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
  return Math.max(0, Math.ceil(estimated * SAFETY_MARGIN));
}

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  unwindowedMessages?: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
  /**
   * Optional proactive turn-boundary threshold as a ratio of the prompt
   * budget. Only the run's first attempt should pass this: it compacts a
   * still-fitting prompt to leave in-turn headroom, which is wrong mid-turn.
   */
  proactiveCompactRatio?: number;
}): {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
} {
  let messagesForPressure = params.messages;
  let estimatedPromptTokens = estimatePrePromptTokens({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
  });
  if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
    const unwindowedEstimatedPromptTokens = estimatePrePromptTokens({
      messages: params.unwindowedMessages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
    });
    if (unwindowedEstimatedPromptTokens > estimatedPromptTokens) {
      estimatedPromptTokens = unwindowedEstimatedPromptTokens;
      messagesForPressure = params.unwindowedMessages;
    }
  }
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const minPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
  );
  const effectiveReserveTokens = Math.min(
    requestedReserveTokens,
    Math.max(0, contextTokenBudget - minPromptBudget),
  );
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: messagesForPressure,
    contextWindowTokens: params.contextTokenBudget,
    maxCharsOverride: params.toolResultMaxChars,
  });
  const overflowChars = overflowTokens * ESTIMATED_CHARS_PER_TOKEN;
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars + truncationBufferChars,
    Math.ceil(overflowChars * 1.5),
  );
  const toolResultReducibleChars = toolResultPotential.maxReducibleChars;

  let route: PreemptiveCompactionRoute = "fits";
  if (overflowTokens > 0) {
    if (toolResultReducibleChars <= 0) {
      route = "compact_only";
    } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
      route = "truncate_tool_results_only";
    } else {
      route = "compact_then_truncate";
    }
  } else if (
    typeof params.proactiveCompactRatio === "number" &&
    params.proactiveCompactRatio > 0 &&
    params.proactiveCompactRatio < 1 &&
    estimatedPromptTokens > Math.floor(promptBudgetBeforeReserve * params.proactiveCompactRatio)
  ) {
    // The prompt still fits, but prior history already occupies enough of the
    // budget that a tool-heavy turn can overflow mid-run — where compaction
    // can no longer shrink the turn's own tool results. Compacting at the
    // turn boundary is the last moment the whole history is summarizable.
    route = "proactive_compact";
  }
  return {
    route,
    shouldCompact:
      route === "compact_only" ||
      route === "compact_then_truncate" ||
      route === "proactive_compact",
    estimatedPromptTokens,
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
    effectiveReserveTokens,
  };
}
