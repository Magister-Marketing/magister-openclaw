import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
  mockOverflowRetrySuccess,
  queueOverflowAttemptWithOversizedToolOutput,
} from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedContextEngine,
  mockedCompactDirect,
  mockedIsCompactionFailureError,
  mockedIsLikelyContextOverflowError,
  mockedLog,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  overflowBaseRunParams as baseParams,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("overflow compaction in run loop", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedRunEmbeddedAttempt.mockReset();
    mockedCompactDirect.mockReset();
    mockedSessionLikelyHasOversizedToolResults.mockReset();
    mockedTruncateOversizedToolResultsInSession.mockReset();
    mockedContextEngine.info.ownsCompaction = false;
    mockedLog.debug.mockReset();
    mockedLog.info.mockReset();
    mockedLog.warn.mockReset();
    mockedLog.error.mockReset();
    mockedLog.isEnabled.mockReset();
    mockedLog.isEnabled.mockReturnValue(false);
    mockedIsCompactionFailureError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") && lower.includes("summarization failed");
    });
    mockedIsLikelyContextOverflowError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return (
        lower.includes("request_too_large") ||
        lower.includes("request size exceeds") ||
        lower.includes("context window exceeded") ||
        lower.includes("prompt too large")
      );
    });
    mockedCompactDirect.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValue({
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized tool results",
    });
  });

  it("retries after successful compaction on context overflow promptError", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({ authProfileId: "test-profile" }),
      }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "context overflow detected (attempt 1/3); attempting auto-compaction",
      ),
    );
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("auto-compaction succeeded"),
    );
    // Should not be an error result
    expect(result.meta.error).toBeUndefined();
  });

  it("continues from transcript after compaction when the current inbound message was persisted", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (attemptParams) => {
        (
          attemptParams as {
            onUserMessagePersisted?: (message: { role: "user"; content: string }) => void;
          }
        ).onUserMessagePersisted?.({ role: "user", content: baseParams.prompt });
        return makeAttemptResult({ promptError: overflowError });
      })
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      currentMessageId: "telegram-msg-51024",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining("Continue from the current transcript"),
        suppressNextUserMessagePersistence: true,
      }),
    );
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: baseParams.prompt }),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("does not suppress the next user turn when precheck overflow never persisted it", async () => {
    const overflowError = makeOverflowError(
      "Context overflow: prompt too large for the model (precheck).",
    );

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: overflowError,
          promptErrorSource: "precheck",
          preflightRecovery: { route: "compact_only" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted before prompt submission",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      currentMessageId: "telegram-msg-51025",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: baseParams.prompt,
        suppressNextUserMessagePersistence: false,
      }),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("retries after successful compaction on likely-overflow promptError variants", async () => {
    const overflowHintError = new Error("Context window exceeded: requested 12000 tokens");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowHintError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-6",
        tokensBefore: 140000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("source=promptError"));
    expect(result.meta.error).toBeUndefined();
  });

  it("returns error if compaction fails", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("auto-compaction failed"));
  });

  it("emits compaction start/end agent events around overflow recovery (Magister fork)", async () => {
    const onAgentEvent = vi.fn();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: makeOverflowError() }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        tokensBefore: 180_000,
        tokensAfter: 40_000,
      }),
    );

    const result = await runEmbeddedPiAgent({ ...baseParams, onAgentEvent });

    expect(result.meta.error).toBeUndefined();
    const compactionEvents = onAgentEvent.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .filter((evt) => evt.stream === "compaction");
    expect(compactionEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ phase: "start", trigger: "overflow" }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "end",
          trigger: "overflow",
          willRetry: true,
          tokensBefore: 180_000,
          tokensAfter: 40_000,
        }),
      }),
    ]);
  });

  it("emits the withheld terminal error when recovery gives up after a suppressed attempt (Magister fork)", async () => {
    const onAgentEvent = vi.fn();
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      // The subscribe layer (handleAgentEnd) consults the registry while the
      // attempt is live; mimic that here so the suppression is recorded
      // mid-run exactly as in production.
      const { shouldSuppressTerminalOverflowError } = await import("./attempt-retry-registry.js");
      expect(shouldSuppressTerminalOverflowError(baseParams.runId, overflowError.message)).toBe(
        true,
      );
      return makeAttemptResult({ promptError: overflowError });
    });
    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedPiAgent({ ...baseParams, onAgentEvent });

    expect(result.meta.error?.kind).toBe("context_overflow");
    const terminalErrors = onAgentEvent.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .filter((evt) => evt.stream === "lifecycle" && evt.data?.phase === "error");
    // Exactly once: the run loop re-emits the terminal error it withheld.
    expect(terminalErrors).toHaveLength(1);
    expect(terminalErrors[0]?.data?.error).toBe(overflowError.message);
  });

  // MAGISTER-MACHINES-N: a precheck attempt reports itself as aborted (it is a
  // compaction hand-off, not a failure), so the run loop owns the terminal
  // run.completed when recovery gives up, and only then.
  async function runCompletedEvents(run: () => Promise<unknown>) {
    const events: Array<Extract<DiagnosticEventPayload, { type: "run.completed" }>> = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.completed") {
        events.push(event);
      }
    });
    try {
      await run();
    } finally {
      stop();
    }
    return events;
  }

  it("reports a terminal run.completed when recovery gives up after a precheck hand-off", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: makeOverflowError(
          "Context overflow: prompt too large for the model (precheck).",
        ),
        promptErrorSource: "precheck",
        preflightRecovery: { route: "compact_only" },
      }),
    );
    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const events = await runCompletedEvents(() => runEmbeddedPiAgent(baseParams));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runId: baseParams.runId,
      outcome: "error",
      failureKind: "context_overflow",
      reasonCode: "overflow_recovery_exhausted",
    });
  });

  it("reports no run-level terminal when the precheck hand-off compacts and retries", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (precheck).",
          ),
          promptErrorSource: "precheck",
          preflightRecovery: { route: "compact_only" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({ summary: "Compacted", firstKeptEntryId: "entry-5" }),
    );

    const events = await runCompletedEvents(() => runEmbeddedPiAgent(baseParams));

    expect(events).toEqual([]);
  });

  it("leaves a provider overflow's terminal to the attempt that reported it", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: makeOverflowError() }),
    );
    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const events = await runCompletedEvents(() => runEmbeddedPiAgent(baseParams));

    expect(events).toEqual([]);
  });

  it("emits the terminal error on give-up even when no attempt terminal was suppressed (Magister fork)", async () => {
    // Precheck-route regression (live-proof 2026-06-10): the run loop hits the
    // give-up branch directly from a promptError precheck — no lifecycle error
    // was ever suppressed mid-run. A consume-gated emit stays silent and the
    // attempt's own terminal then gets swallowed by the still-armed registry,
    // so subscribers see the stream end with no error at all.
    const onAgentEvent = vi.fn();
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: overflowError }),
    );
    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedPiAgent({ ...baseParams, onAgentEvent });

    expect(result.meta.error?.kind).toBe("context_overflow");
    const terminalErrors = onAgentEvent.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .filter((evt) => evt.stream === "lifecycle" && evt.data?.phase === "error");
    expect(terminalErrors).toHaveLength(1);
    expect(terminalErrors[0]?.data?.error).toBe(overflowError.message);

    // Give-up disarms the registry, so a late attempt-level lifecycle error
    // (emitted after the run returns) must pass through unsuppressed.
    const { shouldSuppressTerminalOverflowError } = await import("./attempt-retry-registry.js");
    expect(shouldSuppressTerminalOverflowError(baseParams.runId, overflowError.message)).toBe(
      false,
    );
  });

  it("falls back to tool-result truncation and retries when oversized results are detected", async () => {
    queueOverflowAttemptWithOversizedToolOutput(mockedRunEmbeddedAttempt, makeOverflowError());
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 1,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedSessionLikelyHasOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindowTokens: 200000 }),
    );
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/tmp/session.json" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Truncated 1 tool result(s)"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("retries after fallback truncation for a mixed oversized-plus-aggregate tool tail", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(),
          messagesSnapshot: [
            {
              role: "toolResult",
              content: [{ type: "text", text: "x".repeat(80_000) }],
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
            {
              role: "toolResult",
              content: [{ type: "text", text: "alpha beta gamma delta ".repeat(800) }],
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
            {
              role: "toolResult",
              content: [{ type: "text", text: "alpha beta gamma delta ".repeat(800) }],
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          ],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 2,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedSessionLikelyHasOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "toolResult" }),
          expect.objectContaining({ role: "toolResult" }),
          expect.objectContaining({ role: "toolResult" }),
        ]),
      }),
    );
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/tmp/session.json" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Truncated 2 tool result(s)"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("retries without hitting compaction when attempt-level preflight truncation already handled the overflow", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          preflightRecovery: {
            route: "truncate_tool_results_only",
            handled: true,
            truncatedCount: 2,
          },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedTruncateOversizedToolResultsInSession).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("early recovery route=truncate_tool_results_only"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("continues from the transcript after mid-turn precheck truncation handled the overflow", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          preflightRecovery: {
            route: "truncate_tool_results_only",
            source: "mid-turn",
            handled: true,
            truncatedCount: 2,
          },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining("Continue from the current transcript"),
        suppressNextUserMessagePersistence: true,
      }),
    );
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: baseParams.prompt }),
    );
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("retrying from current transcript"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("falls back to compaction when early truncate-only recovery does not help", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (precheck).",
          ),
          preflightRecovery: { route: "compact_only" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted after failed early truncation",
        firstKeptEntryId: "entry-7",
        tokensBefore: 155000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedTruncateOversizedToolResultsInSession).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "context overflow detected (attempt 1/3); attempting auto-compaction",
      ),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("continues from the transcript after mid-turn precheck compaction", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (mid-turn precheck).",
          ),
          promptErrorSource: "precheck",
          preflightRecovery: { route: "compact_only", source: "mid-turn" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted after mid-turn precheck",
        firstKeptEntryId: "entry-8",
        tokensBefore: 155000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: expect.stringContaining("Continue from the current transcript"),
        suppressNextUserMessagePersistence: true,
      }),
    );
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: baseParams.prompt }),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("runs post-compaction tool-result truncation before retry for mixed precheck routes", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (precheck).",
          ),
          preflightRecovery: { route: "compact_then_truncate" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 2,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/tmp/session.json" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("post-compaction tool-result truncation succeeded"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("retries compaction up to 3 times before giving up", async () => {
    const overflowError = makeOverflowError();

    // 4 overflow errors: 3 compaction retries + final failure
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 1",
          firstKeptEntryId: "entry-3",
          tokensBefore: 180000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 2",
          firstKeptEntryId: "entry-5",
          tokensBefore: 160000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 3",
          firstKeptEntryId: "entry-7",
          tokensBefore: 140000,
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    // Compaction attempted 3 times (max)
    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    // 4 attempts: 3 overflow+compact+retry cycles + final overflow → error
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("succeeds after second compaction attempt", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 1",
          firstKeptEntryId: "entry-3",
          tokensBefore: 180000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 2",
          firstKeptEntryId: "entry-5",
          tokensBefore: 160000,
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.meta.error).toBeUndefined();
  });

  it("does not attempt compaction for compaction_failure errors", async () => {
    const compactionFailureError = new Error(
      "request_too_large: summarization failed - Request size exceeds model context window",
    );

    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ promptError: compactionFailureError }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("compaction_failure");
  });

  it("retries after successful compaction on assistant context overflow errors", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          lastAssistant: {
            stopReason: "error",
            errorMessage: "request_too_large: Request size exceeds model context window",
          } as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
    expect(result.meta.error).toBeUndefined();
  });

  it("does not treat stale assistant overflow as current-attempt overflow when promptError is non-overflow", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("transport disconnected"),
        lastAssistant: {
          stopReason: "error",
          errorMessage: "request_too_large: Request size exceeds model context window",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow("transport disconnected");

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedLog.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("source=assistantError"),
    );
  });

  it("returns an explicit timeout payload when the run times out before producing any reply", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: [],
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("returns a timeout payload instead of a partial assistant fragment after stream timeout", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: ["# Current Tasks\n\nLast updated:"],
        lastAssistant: undefined,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
    expect(
      result.payloads?.some((payload) => (payload.text ?? "").includes("# Current Tasks")),
    ).toBe(false);
  });

  it("sets promptTokens from the latest model call usage, not accumulated attempt usage", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        attemptUsage: {
          input: 4_000,
          cacheRead: 120_000,
          cacheWrite: 0,
          total: 124_000,
        },
        lastAssistant: {
          stopReason: "end_turn",
          usage: {
            input: 900,
            cacheRead: 1_100,
            cacheWrite: 0,
            total: 2_000,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.meta.agentMeta?.usage?.input).toBe(4_000);
    expect(result.meta.agentMeta?.promptTokens).toBe(2_000);
  });
});
