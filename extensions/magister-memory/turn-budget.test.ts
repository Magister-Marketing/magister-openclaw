import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  DEFAULT_TURN_BUDGET,
  resolveTurnBudgetConfig,
  TurnBudget,
  turnBudgetNudge,
} from "./turn-budget.js";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advanceMinutes: (minutes: number) => {
      now += minutes * 60_000;
    },
  };
}

describe("TurnBudget", () => {
  it("lets a short run through untouched", () => {
    const c = clock();
    const budget = new TurnBudget({ minutes: 5, toolCalls: 25 }, c.now);
    budget.start("run-1");
    for (let i = 0; i < 24; i += 1) {
      expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
    }
    // The 25th call, just inside the clock, is still within both limits.
    c.advanceMinutes(4.9);
    expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
  });

  it("nudges once the clock is spent, then starts the next window", () => {
    const c = clock();
    const budget = new TurnBudget({ minutes: 5, toolCalls: 25 }, c.now);
    budget.start("run-1");
    expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
    c.advanceMinutes(5);
    const nudge = budget.noteToolCall("run-1", "exec");
    expect(nudge).toBe(
      "You have worked 5 minutes (2 tool calls) without replying. " +
        "Reply now with what you have, and ask one question if you are blocked.",
    );
    // The re-issued call goes through; the next nudge is a window later.
    expect(budget.noteToolCall("run-1", "exec")).toBeUndefined();
    c.advanceMinutes(4);
    expect(budget.noteToolCall("run-1", "exec")).toBeUndefined();
    c.advanceMinutes(1);
    expect(budget.noteToolCall("run-1", "exec")).toContain("without replying");
    expect(budget.nudgesFor("run-1")).toBe(2);
  });

  it("nudges on the tool-call count alone", () => {
    const c = clock();
    const budget = new TurnBudget({ minutes: 5, toolCalls: 3 }, c.now);
    budget.start("run-1");
    expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
    expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
    expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
    expect(budget.noteToolCall("run-1", "read")).toContain("(4 tool calls) without replying");
    expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
  });

  it("treats a delivered message as the reply", () => {
    const c = clock();
    const budget = new TurnBudget({ minutes: 5, toolCalls: 25 }, c.now);
    budget.start("run-1");
    c.advanceMinutes(10);
    expect(budget.noteToolCall("run-1", "message")).toBeUndefined();
    expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
    expect(budget.nudgesFor("run-1")).toBe(0);
  });

  it("keys the window on the run, and forgets an ended run", () => {
    const c = clock();
    const budget = new TurnBudget({ minutes: 5, toolCalls: 25 }, c.now);
    budget.start("run-1");
    c.advanceMinutes(6);
    // A run the prompt hook never announced starts its clock at its first call.
    expect(budget.noteToolCall("run-2", "read")).toBeUndefined();
    expect(budget.noteToolCall("run-1", "read")).toContain("without replying");
    budget.end("run-1");
    expect(budget.nudgesFor("run-1")).toBe(0);
    expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
    expect(budget.noteToolCall(undefined, "read")).toBeUndefined();
  });

  it("is off when both limits are zero", () => {
    const c = clock();
    const budget = new TurnBudget({ minutes: 0, toolCalls: 0 }, c.now);
    budget.start("run-1");
    c.advanceMinutes(60);
    for (let i = 0; i < 100; i += 1) {
      expect(budget.noteToolCall("run-1", "read")).toBeUndefined();
    }
    expect(budget.enabled).toBe(false);
  });

  it("reads its limits from plugin config with the defaults as fallback", () => {
    expect(resolveTurnBudgetConfig(undefined)).toEqual(DEFAULT_TURN_BUDGET);
    expect(resolveTurnBudgetConfig({ minutes: 2 })).toEqual({ minutes: 2, toolCalls: 25 });
    expect(resolveTurnBudgetConfig({ minutes: -1, toolCalls: "x" })).toEqual(DEFAULT_TURN_BUDGET);
    expect(resolveTurnBudgetConfig({ minutes: 0, toolCalls: 0 })).toEqual({
      minutes: 0,
      toolCalls: 0,
    });
  });

  it("never says zero minutes", () => {
    expect(turnBudgetNudge({ minutes: 0.2, toolCalls: 26 })).toContain(
      "worked 1 minute (26 tool calls)",
    );
  });
});

describe("registration", () => {
  function register(pluginConfig: Record<string, unknown>) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    plugin.register({
      config: { agents: { list: [] } },
      pluginConfig,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
      },
      registerService: vi.fn(),
      registerTool: vi.fn(),
    } as never);
    return handlers;
  }

  it("vetoes the call past the budget with the nudge as its reason", () => {
    const handlers = register({ turnBudget: { minutes: 0, toolCalls: 2 } });
    const before = handlers.get("before_tool_call")!;
    const ctx = { runId: "run-9", sessionKey: "agent:main:webchat:s1" };
    expect(before({ toolName: "read", params: {}, runId: "run-9" }, ctx)).toBeUndefined();
    expect(before({ toolName: "read", params: {}, runId: "run-9" }, ctx)).toBeUndefined();
    expect(before({ toolName: "read", params: {}, runId: "run-9" }, ctx)).toEqual({
      block: true,
      blockReason: expect.stringContaining("Reply now with what you have"),
    });
    // agent_end forgets the run; the memory capture still runs after it.
    const end = handlers.get("agent_end")!;
    void end({ runId: "run-9", messages: [], success: true }, ctx);
    expect(before({ toolName: "read", params: {}, runId: "run-9" }, ctx)).toBeUndefined();
  });
});
