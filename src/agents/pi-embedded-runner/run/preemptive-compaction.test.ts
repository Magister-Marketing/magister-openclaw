import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../../test-helpers/pi-coding-agent-token-mock.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";

let PREEMPTIVE_OVERFLOW_ERROR_TEXT: typeof import("./preemptive-compaction.js").PREEMPTIVE_OVERFLOW_ERROR_TEXT;
let estimatePrePromptTokens: typeof import("./preemptive-compaction.js").estimatePrePromptTokens;
let shouldPreemptivelyCompactBeforePrompt: typeof import("./preemptive-compaction.js").shouldPreemptivelyCompactBeforePrompt;
let resolveProactiveCompactionThresholdRatio: typeof import("./preemptive-compaction.js").resolveProactiveCompactionThresholdRatio;
let isPreemptiveOverflowSignal: typeof import("./preemptive-compaction.js").isPreemptiveOverflowSignal;

beforeAll(async () => {
  vi.resetModules();
  ({
    PREEMPTIVE_OVERFLOW_ERROR_TEXT,
    estimatePrePromptTokens,
    shouldPreemptivelyCompactBeforePrompt,
    resolveProactiveCompactionThresholdRatio,
    isPreemptiveOverflowSignal,
  } = await import("./preemptive-compaction.js"));
});

let timestamp = 1;

function makeAssistantHistory(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeToolResultMessage(...texts: string[]): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "read",
    content: texts.map((text) => ({ type: "text", text })),
    isError: false,
    timestamp: timestamp++,
  } as AgentMessage;
}

describe("preemptive-compaction", () => {
  const verboseHistory =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(40);
  const verboseSystem =
    "system guidance with multiple distinct words to avoid tokenizer overcompression ".repeat(25);
  const verbosePrompt =
    "user request with distinct content asking for a detailed answer and more context ".repeat(25);

  it("exports a context-overflow-compatible precheck error text", () => {
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("Context overflow:");
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("(precheck)");
  });

  it("raises the estimate as prompt-side content grows", () => {
    const smaller = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: "sys",
      prompt: "hello",
    });
    const larger = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
    });

    expect(larger).toBeGreaterThan(smaller);
  });

  it("requests preemptive compaction when the reserve-based prompt budget would be exceeded", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("does not request preemptive compaction when the reserve-based prompt budget still fits", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
    expect(result.estimatedPromptTokens).toBeLessThan(result.promptBudgetBeforeReserve);
  });

  it("uses the larger unwindowed message estimate when explicitly provided", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("small assembled window")],
      unwindowedMessages: [makeAssistantHistory(verboseHistory.repeat(4))],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("caps reserve tokens so small context models keep usable prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 16_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(8_000);
    expect(result.promptBudgetBeforeReserve).toBe(8_000);
    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
  });

  it("keeps the requested reserve when it leaves enough prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 32_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(20_000);
    expect(result.promptBudgetBeforeReserve).toBe(12_000);
    expect(result.shouldCompact).toBe(false);
  });

  it("routes to direct tool-result truncation when recent tool tails can clearly absorb the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(2200);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(medium, medium, medium, medium),
    ];
    const reserveTokens = 2_000;
    const contextTokenBudget = 26_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const desiredOverflowTokens = 200;
    const adjustedContextTokenBudget =
      estimatedPromptTokens - desiredOverflowTokens + reserveTokens;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: Math.max(contextTokenBudget, adjustedContextTokenBudget),
      reserveTokens,
    });

    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("routes to compact then truncate when recent tool tails help but cannot fully cover the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(220);
    const longHistory = "old discussion with substantial retained context and decisions ".repeat(
      5000,
    );
    const messages = [
      makeAssistantHistory(longHistory),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 500;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 12_000,
      reserveTokens,
    });

    expect(result.route).toBe("compact_then_truncate");
    expect(result.shouldCompact).toBe(true);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("routes to proactive compaction when a fitting prompt crosses the turn-boundary ratio", () => {
    const messages = [makeAssistantHistory(verboseHistory)];
    const estimated = estimatePrePromptTokens({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
    });
    expect(estimated).toBeGreaterThan(1_000);
    const reserveTokens = 500;
    // Budget leaves 1000 tokens of slack: the prompt fits absolutely, but at
    // ratio 0.5 the history is over the proactive threshold.
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: estimated + 1_000 + reserveTokens,
      reserveTokens,
      proactiveCompactRatio: 0.5,
    });

    expect(result.route).toBe("proactive_compact");
    expect(result.shouldCompact).toBe(true);
    expect(result.overflowTokens).toBe(0);
    expect(result.estimatedPromptTokens).toBeLessThanOrEqual(result.promptBudgetBeforeReserve);
  });

  it("does not fire proactive compaction below the ratio or when the ratio is disabled", () => {
    const messages = [makeAssistantHistory(verboseHistory)];
    const estimated = estimatePrePromptTokens({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
    });
    const reserveTokens = 500;
    const base = {
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      reserveTokens,
    };

    // Well under the ratio: budget is 4x the estimate.
    const under = shouldPreemptivelyCompactBeforePrompt({
      ...base,
      contextTokenBudget: estimated * 4 + reserveTokens,
      proactiveCompactRatio: 0.5,
    });
    expect(under.route).toBe("fits");
    expect(under.shouldCompact).toBe(false);

    // Ratio omitted or at a disabling boundary value: never proactive.
    for (const proactiveCompactRatio of [undefined, 0, 1]) {
      const result = shouldPreemptivelyCompactBeforePrompt({
        ...base,
        contextTokenBudget: estimated + 1_000 + reserveTokens,
        ...(proactiveCompactRatio !== undefined ? { proactiveCompactRatio } : {}),
      });
      expect(result.route).toBe("fits");
      expect(result.shouldCompact).toBe(false);
    }
  });

  it("lets a real overflow route win over the proactive ratio", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 500,
      reserveTokens: 50,
      proactiveCompactRatio: 0.5,
    });

    expect(result.route).toBe("compact_only");
    expect(result.overflowTokens).toBeGreaterThan(0);
  });

  it("resolves the proactive threshold ratio with a code-side default and config override", () => {
    const cfgWith = (proactiveThresholdRatio: number | undefined) =>
      ({
        agents: { defaults: { compaction: { proactiveThresholdRatio } } },
      }) as never;

    // Unset anywhere along the path → the code-side default. The default is
    // deliberately not seeded into deployed config files: the compaction
    // schema is strict, so a persisted key would invalidate the config under
    // a rolled-back older bundle.
    expect(resolveProactiveCompactionThresholdRatio(undefined)).toBe(0.5);
    expect(resolveProactiveCompactionThresholdRatio({} as never)).toBe(0.5);
    expect(resolveProactiveCompactionThresholdRatio(cfgWith(undefined))).toBe(0.5);
    // Explicit boundary values disable; NaN never enables.
    expect(resolveProactiveCompactionThresholdRatio(cfgWith(0))).toBeUndefined();
    expect(resolveProactiveCompactionThresholdRatio(cfgWith(1))).toBeUndefined();
    expect(resolveProactiveCompactionThresholdRatio(cfgWith(Number.NaN))).toBeUndefined();
    // In-range values override the default.
    expect(resolveProactiveCompactionThresholdRatio(cfgWith(0.85))).toBe(0.85);
  });

  it("treats mixed oversized-plus-aggregate tool tails as cumulative recovery potential", () => {
    const oversized = "x".repeat(45_000);
    const medium = "alpha beta gamma delta epsilon ".repeat(500);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(oversized),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 2_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const potential = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 128_000,
    });
    const desiredOverflowTokens = 2_000;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: estimatedPromptTokens - desiredOverflowTokens + reserveTokens,
      reserveTokens,
    });

    expect(potential.oversizedReducibleChars).toBeGreaterThan(0);
    expect(potential.aggregateReducibleChars).toBeGreaterThan(0);
    expect(potential.oversizedReducibleChars).toBeLessThan(potential.maxReducibleChars);
    expect(potential.maxReducibleChars).toBeGreaterThan(desiredOverflowTokens * 4);
    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
  });
});

describe("isPreemptiveOverflowSignal", () => {
  it("treats the start-of-run and mid-turn prechecks as a compaction hand-off", async () => {
    const { MidTurnPrecheckSignal } = await import("./midturn-precheck.js");
    expect(isPreemptiveOverflowSignal(new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT))).toBe(true);
    expect(
      isPreemptiveOverflowSignal(
        new MidTurnPrecheckSignal({
          route: "compact_only",
          estimatedPromptTokens: 2,
          promptBudgetBeforeReserve: 1,
          overflowTokens: 1,
          toolResultReducibleChars: 0,
          effectiveReserveTokens: 0,
        }),
      ),
    ).toBe(true);
  });

  it("leaves every other failure terminal", () => {
    expect(isPreemptiveOverflowSignal(new Error("Context overflow: provider said so"))).toBe(false);
    expect(isPreemptiveOverflowSignal(PREEMPTIVE_OVERFLOW_ERROR_TEXT)).toBe(false);
    expect(isPreemptiveOverflowSignal(undefined)).toBe(false);
  });
});
