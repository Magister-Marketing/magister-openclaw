// Magister fork: runtime resilience guards layered on upstream's loop detector.
// Terminal-failure streaks per strategy, user-denial circuit breaker, and the
// per-run browser launch limit; all independent of loopDetection.enabled.
import { describe, expect, it } from "vitest";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  detectRuntimeResilienceBlock,
  recordToolCall,
  recordToolCallOutcome,
  resolveRuntimeResilienceOutcomeDecision,
} from "./tool-loop-detection.js";

// Upstream's fixed sliding window; the guards must keep counting past it.
const TOOL_CALL_HISTORY_SIZE = 30;

function createState(): SessionState {
  return {
    lastActivity: Date.now(),
    state: "processing",
    queueDepth: 0,
  };
}

const runtimeResilienceConfig: ToolLoopDetectionConfig = {
  runtimeResilience: {
    enabled: true,
    failureWarningThreshold: 2,
    failureBlockThreshold: 5,
    denialBlockThreshold: 3,
    browserLaunchLimit: 2,
  },
};

function magisterResult(params: {
  operationId: string;
  state?: "running" | "succeeded" | "failed";
  errorCode?: string | null;
  retryable?: boolean;
  approvalState?: "pending" | "denied";
  sideEffect?: "none" | "external_write";
}) {
  const state = params.state ?? "failed";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: state === "succeeded",
          operation_id: params.operationId,
          status: { state, terminal: state !== "running" },
          side_effect: params.sideEffect ?? "external_write",
          receipt: params.approvalState
            ? { approval: { state: params.approvalState, operation_id: params.operationId } }
            : {},
          error:
            params.errorCode === null || state === "succeeded"
              ? null
              : {
                  code: params.errorCode ?? "upstream_failed",
                  retryable: params.retryable ?? false,
                },
        }),
      },
    ],
  };
}

function recordFailedCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  error: unknown,
  index: number,
  options?: {
    config?: ToolLoopDetectionConfig;
    runId?: string;
  },
): void {
  const toolCallId = `${toolName}-error-${index}`;
  recordToolCall(state, toolName, params, toolCallId, options?.config, {
    runId: options?.runId,
  });
  recordToolCallOutcome(state, {
    toolName,
    toolParams: params,
    toolCallId,
    error,
    config: options?.config,
    runId: options?.runId,
  });
}

describe("tool-loop-detection runtime resilience", () => {
  describe("runtime resilience", () => {
    function recordMagisterOutcome(params: {
      state: SessionState;
      callIndex: number;
      operationId: string;
      result: unknown;
      runId?: string;
      toolParams?: Record<string, unknown>;
      trustedSideEffect?: "none" | "external_write";
    }) {
      const runId = params.runId ?? "run-resilience";
      const trustedSideEffect = params.trustedSideEffect ?? "external_write";
      const toolParams = params.toolParams ?? {
        to: ["person@example.com"],
        subject: "Hello",
        idempotency_key: `volatile-${params.callIndex}`,
      };
      const toolCallId = `call-${params.callIndex}`;
      recordToolCall(
        params.state,
        "magister_send_agent_email",
        toolParams,
        toolCallId,
        runtimeResilienceConfig,
        { runId, sideEffect: trustedSideEffect },
      );
      const record = recordToolCallOutcome(params.state, {
        toolName: "magister_send_agent_email",
        toolParams,
        toolCallId,
        result: params.result,
        config: runtimeResilienceConfig,
        runId,
        trustedSideEffect,
      });
      if (!record) {
        throw new Error("expected recorded outcome");
      }
      return resolveRuntimeResilienceOutcomeDecision(
        params.state,
        record,
        runtimeResilienceConfig,
        { runId },
      );
    }

    it("adds guidance on the second equivalent terminal failure despite volatile ids", () => {
      const state = createState();
      const first = recordMagisterOutcome({
        state,
        callIndex: 1,
        operationId: "op-1",
        result: magisterResult({ operationId: "op-1" }),
      });
      const second = recordMagisterOutcome({
        state,
        callIndex: 2,
        operationId: "op-2",
        result: magisterResult({ operationId: "op-2" }),
      });

      expect(first.guidance).toBeUndefined();
      expect(second.guidance).toContain("same terminal failure 2 times");
    });

    it("blocks the fifth equivalent attempt before execution", () => {
      const state = createState();
      for (let index = 1; index <= 4; index += 1) {
        recordMagisterOutcome({
          state,
          callIndex: index,
          operationId: `op-${index}`,
          result: magisterResult({ operationId: `op-${index}` }),
        });
      }

      const result = detectRuntimeResilienceBlock(
        state,
        "magister_send_agent_email",
        {
          to: ["person@example.com"],
          subject: "Hello",
          idempotency_key: "volatile-fifth",
        },
        runtimeResilienceConfig,
        { runId: "run-resilience", sideEffect: "external_write" },
      );

      expect(result).toMatchObject({
        stuck: true,
        level: "critical",
        detector: "terminal_failure",
        count: 4,
      });
    });

    it("ignores volatile exception text when stable failure identity matches", () => {
      const state = createState();
      recordFailedCall(
        state,
        "exec",
        { command: "deploy" },
        new Error("network reset request=req-1"),
        1,
        { config: runtimeResilienceConfig },
      );
      recordFailedCall(
        state,
        "exec",
        { command: "deploy" },
        new Error("network reset request=req-2"),
        2,
        { config: runtimeResilienceConfig },
      );

      const latest = state.toolCallHistory?.at(-1);
      expect(
        latest &&
          resolveRuntimeResilienceOutcomeDecision(state, latest, runtimeResilienceConfig, {
            runId: undefined,
          }).guidance,
      ).toContain("same terminal failure 2 times");
    });

    it("does not combine thrown failures with different stable codes", () => {
      const state = createState();
      const first = Object.assign(new Error("provider failed"), { code: "EHOSTUNREACH" });
      const second = Object.assign(new Error("provider failed"), { code: "EACCES" });
      recordFailedCall(state, "exec", { command: "deploy" }, first, 1, {
        config: runtimeResilienceConfig,
      });
      recordFailedCall(state, "exec", { command: "deploy" }, second, 2, {
        config: runtimeResilienceConfig,
      });

      const result = detectRuntimeResilienceBlock(
        state,
        "exec",
        { command: "deploy" },
        runtimeResilienceConfig,
        { runId: undefined },
      );

      expect(result.stuck).toBe(false);
    });

    it("resets an equivalent failure streak after success", () => {
      const state = createState();
      for (let index = 1; index <= 2; index += 1) {
        recordMagisterOutcome({
          state,
          callIndex: index,
          operationId: `op-fail-${index}`,
          result: magisterResult({ operationId: `op-fail-${index}` }),
        });
      }
      recordMagisterOutcome({
        state,
        callIndex: 3,
        operationId: "op-success",
        result: magisterResult({
          operationId: "op-success",
          state: "succeeded",
          errorCode: null,
        }),
      });
      for (let index = 4; index <= 5; index += 1) {
        recordMagisterOutcome({
          state,
          callIndex: index,
          operationId: `op-new-fail-${index}`,
          result: magisterResult({ operationId: `op-new-fail-${index}` }),
        });
      }

      const result = detectRuntimeResilienceBlock(
        state,
        "magister_send_agent_email",
        { to: ["person@example.com"], subject: "Hello" },
        runtimeResilienceConfig,
        { runId: "run-resilience", sideEffect: "external_write" },
      );
      expect(result.stuck).toBe(false);
    });

    it("ignores pending and retryable outcomes", () => {
      const state = createState();
      for (let index = 1; index <= 5; index += 1) {
        recordMagisterOutcome({
          state,
          callIndex: index,
          operationId: `op-${index}`,
          result:
            index % 2 === 0
              ? magisterResult({
                  operationId: `op-${index}`,
                  state: "running",
                  errorCode: "approval_required",
                  approvalState: "pending",
                })
              : magisterResult({
                  operationId: `op-${index}`,
                  errorCode: "rate_limited",
                  retryable: true,
                }),
        });
      }

      const result = detectRuntimeResilienceBlock(
        state,
        "magister_send_agent_email",
        { to: ["person@example.com"], subject: "Hello" },
        runtimeResilienceConfig,
        { runId: "run-resilience", sideEffect: "external_write" },
      );
      expect(result.stuck).toBe(false);
    });

    it("deduplicates denied operation replays and blocks later side effects after three", () => {
      const state = createState();
      const operationIds = ["op-1", "op-1", "op-2", "op-3"];
      let finalGuidance: string | undefined;
      operationIds.forEach((operationId, index) => {
        finalGuidance = recordMagisterOutcome({
          state,
          callIndex: index + 1,
          operationId,
          result: magisterResult({
            operationId,
            state: "failed",
            errorCode: null,
            approvalState: "denied",
          }),
          toolParams: { target: `resource-${index}` },
        }).guidance;
      });

      expect(finalGuidance).toContain("3 distinct side-effect operations");
      const replayGuidance = recordMagisterOutcome({
        state,
        callIndex: 5,
        operationId: "op-3",
        result: magisterResult({
          operationId: "op-3",
          state: "failed",
          errorCode: null,
          approvalState: "denied",
        }),
        toolParams: { target: "resource-3" },
      }).guidance;
      expect(replayGuidance).toBeUndefined();
      const blockedWrite = detectRuntimeResilienceBlock(
        state,
        "magister_send_agent_email",
        { to: ["new@example.com"] },
        runtimeResilienceConfig,
        { runId: "run-resilience", sideEffect: "external_write" },
      );
      const allowedRead = detectRuntimeResilienceBlock(
        state,
        "magister_get_brand",
        {},
        runtimeResilienceConfig,
        { runId: "run-resilience", sideEffect: "none" },
      );

      expect(blockedWrite.stuck && blockedWrite.detector).toBe("denial_circuit_breaker");
      expect(allowedRead.stuck).toBe(false);
    });

    it("does not count denials for operations classified as read-only", () => {
      const state = createState();
      for (let index = 1; index <= 3; index += 1) {
        recordMagisterOutcome({
          state,
          callIndex: index,
          operationId: `read-op-${index}`,
          result: magisterResult({
            operationId: `read-op-${index}`,
            state: "failed",
            errorCode: null,
            approvalState: "denied",
            sideEffect: "none",
          }),
          trustedSideEffect: "none",
        });
      }

      const result = detectRuntimeResilienceBlock(
        state,
        "magister_send_agent_email",
        { to: ["person@example.com"] },
        runtimeResilienceConfig,
        { runId: "run-resilience", sideEffect: "external_write" },
      );
      expect(result.stuck).toBe(false);
    });

    it("isolates denial state by run id", () => {
      const state = createState();
      for (let index = 1; index <= 3; index += 1) {
        recordMagisterOutcome({
          state,
          callIndex: index,
          operationId: `op-${index}`,
          result: magisterResult({
            operationId: `op-${index}`,
            state: "failed",
            errorCode: null,
            approvalState: "denied",
          }),
        });
      }

      const result = detectRuntimeResilienceBlock(
        state,
        "magister_send_agent_email",
        { to: ["person@example.com"] },
        runtimeResilienceConfig,
        { runId: "different-run", sideEffect: "external_write" },
      );
      expect(result.stuck).toBe(false);
    });

    it("counts browser start/open but not useful in-tab work", () => {
      const state = createState();
      recordToolCall(state, "browser", { action: "start" }, "browser-1", runtimeResilienceConfig, {
        runId: "browser-run",
      });
      recordToolCall(
        state,
        "browser",
        { action: "snapshot" },
        "browser-snapshot",
        runtimeResilienceConfig,
        { runId: "browser-run" },
      );
      recordToolCall(
        state,
        "browser",
        { action: "open", targetUrl: "https://example.com" },
        "browser-2",
        runtimeResilienceConfig,
        { runId: "browser-run" },
      );

      const blocked = detectRuntimeResilienceBlock(
        state,
        "browser",
        { action: "open", targetUrl: "https://example.org" },
        runtimeResilienceConfig,
        { runId: "browser-run" },
      );
      const allowed = detectRuntimeResilienceBlock(
        state,
        "browser",
        { action: "screenshot" },
        runtimeResilienceConfig,
        { runId: "browser-run" },
      );

      expect(blocked.stuck && blocked.detector).toBe("browser_launch_limit");
      expect(allowed.stuck).toBe(false);
    });

    it("does not age browser launches out when useful work exceeds the legacy window", () => {
      const state = createState();
      for (let launch = 0; launch < 10; launch += 1) {
        recordToolCall(
          state,
          "browser",
          { action: "open", targetUrl: `https://example.com/${launch}` },
          `open-${launch}`,
          runtimeResilienceConfig,
          { runId: "browser-run" },
        );
        for (let snapshot = 0; snapshot < 3; snapshot += 1) {
          recordToolCall(
            state,
            "browser",
            { action: "snapshot", launch, snapshot },
            `snapshot-${launch}-${snapshot}`,
            runtimeResilienceConfig,
            { runId: "browser-run" },
          );
        }
      }

      expect(state.toolCallHistory).toHaveLength(TOOL_CALL_HISTORY_SIZE);
      expect(state.toolCallHistory?.filter((record) => record.browserLaunch)).toHaveLength(7);
      expect(
        detectRuntimeResilienceBlock(
          state,
          "browser",
          { action: "open", targetUrl: "https://example.com/blocked" },
          runtimeResilienceConfig,
          { runId: "browser-run" },
        ),
      ).toMatchObject({ stuck: true, detector: "browser_launch_limit", count: 10 });
    });

    it("does not age denials out after later read-only work", () => {
      const state = createState();
      for (let index = 1; index <= 3; index += 1) {
        recordMagisterOutcome({
          state,
          callIndex: index,
          operationId: `op-${index}`,
          result: magisterResult({
            operationId: `op-${index}`,
            state: "failed",
            errorCode: null,
            approvalState: "denied",
          }),
          toolParams: { target: `resource-${index}` },
        });
      }
      for (let index = 0; index <= TOOL_CALL_HISTORY_SIZE; index += 1) {
        recordToolCall(
          state,
          "magister_read",
          { index },
          `read-${index}`,
          runtimeResilienceConfig,
          { runId: "run-resilience", sideEffect: "none" },
        );
      }

      expect(
        state.toolCallHistory?.some((record) => record.resilienceOutcomeKind === "denial"),
      ).toBe(false);
      expect(
        detectRuntimeResilienceBlock(
          state,
          "magister_send_agent_email",
          { to: ["new@example.com"] },
          runtimeResilienceConfig,
          { runId: "run-resilience", sideEffect: "external_write" },
        ),
      ).toMatchObject({ stuck: true, detector: "denial_circuit_breaker", count: 3 });
    });

    it("does not age equivalent failures out after unrelated tool work", () => {
      const state = createState();
      for (let index = 1; index <= 4; index += 1) {
        recordMagisterOutcome({
          state,
          callIndex: index,
          operationId: `op-${index}`,
          result: magisterResult({ operationId: `op-${index}` }),
        });
      }
      for (let index = 0; index <= TOOL_CALL_HISTORY_SIZE; index += 1) {
        recordToolCall(
          state,
          "magister_read",
          { index },
          `read-${index}`,
          runtimeResilienceConfig,
          { runId: "run-resilience", sideEffect: "none" },
        );
      }

      expect(
        state.toolCallHistory?.some((record) => record.resilienceOutcomeKind === "failure"),
      ).toBe(false);
      expect(
        detectRuntimeResilienceBlock(
          state,
          "magister_send_agent_email",
          { to: ["person@example.com"], subject: "Hello" },
          runtimeResilienceConfig,
          { runId: "run-resilience", sideEffect: "external_write" },
        ),
      ).toMatchObject({ stuck: true, detector: "terminal_failure", count: 4 });
    });

    it("keeps interleaved run counters isolated outside the legacy window", () => {
      const state = createState();
      for (let index = 0; index < 10; index += 1) {
        for (const runId of ["run-a", "run-b"]) {
          recordToolCall(
            state,
            "browser",
            { action: "open", targetUrl: `https://example.com/${runId}/${index}` },
            `${runId}-${index}`,
            runtimeResilienceConfig,
            { runId },
          );
          recordToolCall(
            state,
            "browser",
            { action: "snapshot", index },
            `${runId}-snapshot-${index}`,
            runtimeResilienceConfig,
            { runId },
          );
        }
      }

      for (const runId of ["run-a", "run-b"]) {
        expect(
          detectRuntimeResilienceBlock(
            state,
            "browser",
            { action: "open", targetUrl: "https://example.com/blocked" },
            runtimeResilienceConfig,
            { runId },
          ),
        ).toMatchObject({ stuck: true, detector: "browser_launch_limit", count: 10 });
      }
      expect(
        detectRuntimeResilienceBlock(
          state,
          "browser",
          { action: "open", targetUrl: "https://example.com/new-run" },
          runtimeResilienceConfig,
          { runId: "run-c" },
        ).stuck,
      ).toBe(false);
    });

    it("fails closed when a run exhausts its bounded failure-strategy tracker", () => {
      const state = createState();
      for (let index = 0; index <= 256; index += 1) {
        recordFailedCall(
          state,
          "exec",
          { command: `strategy-${index}` },
          Object.assign(new Error("failed"), { code: "EFAILED" }),
          index,
          { config: runtimeResilienceConfig, runId: "wide-run" },
        );
      }

      expect(
        detectRuntimeResilienceBlock(
          state,
          "exec",
          { command: "one-more-strategy" },
          runtimeResilienceConfig,
          { runId: "wide-run" },
        ),
      ).toMatchObject({
        stuck: true,
        detector: "terminal_failure",
        count: 256,
      });
    });
  });
});
