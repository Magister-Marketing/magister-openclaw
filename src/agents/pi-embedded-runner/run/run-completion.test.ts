import { describe, expect, it } from "vitest";
import { FailoverError } from "../../failover-error.js";
import {
  resolveRunCompletionDiagnostic,
  resolveRunCompletionOutcome,
  type RunCompletionFlags,
} from "./run-completion.js";

function flags(overrides: Partial<RunCompletionFlags> = {}): RunCompletionFlags {
  return {
    externalAbortRequested: false,
    aborted: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    precheckCompactionHandoff: false,
    ...overrides,
  };
}

describe("resolveRunCompletionOutcome", () => {
  it("returns completed for a clean run", () => {
    expect(resolveRunCompletionOutcome(flags(), undefined)).toBe("completed");
  });

  it("returns error when the prompt failed without an abort request", () => {
    expect(resolveRunCompletionOutcome(flags(), new Error("boom"))).toBe("error");
  });

  it("prefers aborted over error when an external stop was requested", () => {
    // A cancel usually severs the in-flight prompt, so the error is set;
    // the run must still be recorded as aborted, not error.
    expect(
      resolveRunCompletionOutcome(
        flags({ externalAbortRequested: true, aborted: true }),
        new Error("stream severed by peer"),
      ),
    ).toBe("aborted");
  });

  it("returns aborted for watchdog timeouts without a prompt error", () => {
    expect(resolveRunCompletionOutcome(flags({ aborted: true, timedOut: true }), undefined)).toBe(
      "aborted",
    );
  });
});

describe("precheck compaction hand-off", () => {
  // MAGISTER-MACHINES-N: the precheck stops the attempt so the run loop can
  // compact and retry. Reported as an error, machine telemetry promoted every
  // routine compaction to a Sentry issue labelled "unclassified".
  const precheck = new Error("Context overflow: prompt too large for the model (precheck).");

  it("is aborted, not an error", () => {
    expect(resolveRunCompletionOutcome(flags({ precheckCompactionHandoff: true }), precheck)).toBe(
      "aborted",
    );
  });

  it("is classified as a context overflow handed to compaction", () => {
    expect(
      resolveRunCompletionDiagnostic({
        outcome: "aborted",
        err: precheck,
        flags: flags({ precheckCompactionHandoff: true }),
      }),
    ).toEqual({ failureKind: "context_overflow", reasonCode: "precheck_compaction" });
  });

  it("still reports a user cancel as canceled", () => {
    const cancel = flags({ externalAbortRequested: true, precheckCompactionHandoff: true });
    expect(resolveRunCompletionOutcome(cancel, precheck)).toBe("aborted");
    expect(
      resolveRunCompletionDiagnostic({ outcome: "aborted", err: precheck, flags: cancel }),
    ).toEqual({ failureKind: "canceled", reasonCode: "external_abort" });
  });
});

describe("resolveRunCompletionDiagnostic", () => {
  it("emits nothing for completed runs", () => {
    expect(
      resolveRunCompletionDiagnostic({ outcome: "completed", err: undefined, flags: flags() }),
    ).toEqual({});
  });

  it("classifies canceled runs with the external abort reason", () => {
    expect(
      resolveRunCompletionDiagnostic({
        outcome: "aborted",
        err: new Error("Aborted"),
        flags: flags({ externalAbortRequested: true, aborted: true }),
      }),
    ).toEqual({ failureKind: "canceled", reasonCode: "external_abort" });
  });

  it("classifies watchdog-aborted runs as timeouts", () => {
    expect(
      resolveRunCompletionDiagnostic({
        outcome: "aborted",
        err: undefined,
        flags: flags({ aborted: true, idleTimedOut: true }),
      }),
    ).toEqual({ failureKind: "timeout", reasonCode: "idle_timeout" });
  });

  it("honors an explicit failover reason on the error", () => {
    expect(
      resolveRunCompletionDiagnostic({
        outcome: "error",
        err: new FailoverError("rate limited", { reason: "rate_limit" }),
        flags: flags(),
      }),
    ).toEqual({ failureKind: "rate_limit" });
  });

  it("classifies timeout-shaped error messages", () => {
    expect(
      resolveRunCompletionDiagnostic({
        outcome: "error",
        err: new Error("Request timed out"),
        flags: flags({ timedOut: true }),
        provider: "openai",
      }),
    ).toEqual({ failureKind: "timeout", reasonCode: "run_timeout" });
  });

  it("falls back to unclassified for unrecognizable errors", () => {
    expect(
      resolveRunCompletionDiagnostic({
        outcome: "error",
        err: new Error("something inscrutable"),
        flags: flags(),
      }),
    ).toEqual({ failureKind: "unclassified" });
  });
});
