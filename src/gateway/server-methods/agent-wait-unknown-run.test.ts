import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
  rememberAgentRun,
  resetAgentEventsForTest,
  sweepStaleRunContexts,
} from "../../infra/agent-events.js";
import { agentHandlers } from "./agent.js";
import type { GatewayRequestContext } from "./types.js";

async function agentWait(
  runId: string,
  {
    timeoutMs = 0,
    chatAbortControllers = new Map(),
  }: { timeoutMs?: number; chatAbortControllers?: Map<string, unknown> } = {},
) {
  const respond = vi.fn();
  await agentHandlers["agent.wait"]({
    params: { runId, timeoutMs },
    respond: respond as never,
    context: { dedupe: new Map(), chatAbortControllers } as unknown as GatewayRequestContext,
    req: { type: "req", id: "agent-wait-test", method: "agent.wait" },
    client: null,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("agent.wait for a run this process never heard of", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  it("says so, and keeps the status every other caller reads", async () => {
    await expect(agentWait("run-from-an-earlier-process")).resolves.toEqual({
      runId: "run-from-an-earlier-process",
      status: "timeout",
      unknownRun: true,
    });
  });

  it("leaves the answer alone for a run minted here that has not started", async () => {
    rememberAgentRun("run-queued-in-its-lane");
    await expect(agentWait("run-queued-in-its-lane")).resolves.toEqual({
      runId: "run-queued-in-its-lane",
      status: "timeout",
    });
  });

  it("leaves the answer alone for a run with a registered context", async () => {
    registerAgentRunContext("run-with-context", { sessionKey: "agent:main:main" });
    await expect(agentWait("run-with-context")).resolves.not.toHaveProperty("unknownRun");
  });

  it("still knows a run after its context is cleared between attempts", async () => {
    registerAgentRunContext("run-retrying", { sessionKey: "agent:main:main" });
    clearAgentRunContext("run-retrying");
    await expect(agentWait("run-retrying")).resolves.not.toHaveProperty("unknownRun");
  });

  it("still knows a run that went quiet long enough for its context to be swept", async () => {
    const now = Date.now();
    registerAgentRunContext("run-silent", {
      sessionKey: "agent:main:main",
      registeredAt: now - 60 * 60_000,
    });
    expect(sweepStaleRunContexts()).toBe(1);
    await expect(agentWait("run-silent")).resolves.not.toHaveProperty("unknownRun");
  });

  it("knows a run from its events alone", async () => {
    emitAgentEvent({ runId: "run-events-only", stream: "assistant", data: { text: "hi" } });
    await expect(agentWait("run-events-only")).resolves.not.toHaveProperty("unknownRun");
  });

  it("knows a chat.send run from its abort controller", async () => {
    await expect(
      agentWait("run-chat-send", {
        chatAbortControllers: new Map([["run-chat-send", { kind: "chat-send" }]]),
      }),
    ).resolves.not.toHaveProperty("unknownRun");
  });

  it("judges at the end of the wait, so a run that arrives during it is known", async () => {
    const answer = agentWait("run-arriving", { timeoutMs: 40 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    emitAgentEvent({ runId: "run-arriving", stream: "assistant", data: { text: "hi" } });
    await expect(answer).resolves.toEqual({ runId: "run-arriving", status: "timeout" });
  });

  it("holds the wait rather than answering early", async () => {
    const started = Date.now();
    await agentWait("run-from-an-earlier-process", { timeoutMs: 40 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it("forgets the oldest run first once the memory is full", async () => {
    rememberAgentRun("run-oldest");
    for (let index = 0; index < 10_000; index += 1) {
      rememberAgentRun(`run-${index}`);
    }
    await expect(agentWait("run-oldest")).resolves.toHaveProperty("unknownRun", true);
    await expect(agentWait("run-9999")).resolves.not.toHaveProperty("unknownRun");
  });
});
