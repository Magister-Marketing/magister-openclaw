import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

type LifecycleEvent = { stream?: unknown; data?: Record<string, unknown> };

function lifecycleErrors(calls: Array<unknown[]>): Array<Record<string, unknown>> {
  return calls
    .map((call) => call?.[0] as LifecycleEvent | undefined)
    .filter((evt) => evt?.stream === "lifecycle" && evt?.data?.phase === "error")
    .map((evt) => evt?.data ?? {});
}

function emitAbortedEnd(emit: (evt: unknown) => void) {
  emit({
    type: "message_update",
    message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "" }] },
  });
  emit({ type: "agent_end" });
}

// The runner's real order: the yield tool marks the subscription, then aborts
// the session; pi-agent-core emits the aborted message_end / agent_end inside
// that abort, before the attempt returns. The lifecycle handler must see the
// mark at that moment, or the run closes as `aborted`.
describe("subscribeEmbeddedPiSession sessions_yield lifecycle", () => {
  it("marks a run yielded before the aborted end, with no terminal code", () => {
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-yield",
      sessionKey: "test-session",
      onAgentEvent,
    });

    subscription.setTerminalLifecycleMeta({ yielded: true });
    emitAbortedEnd(emit);

    const errors = lifecycleErrors(onAgentEvent.mock.calls);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: "error", aborted: true, yielded: true });
    expect(errors[0]).not.toHaveProperty("terminalCode");
  });

  it("stamps an aborted end without the mark as a cancelled attempt", () => {
    const onAgentEvent = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-cancel",
      sessionKey: "test-session",
      onAgentEvent,
    });

    emitAbortedEnd(emit);

    const errors = lifecycleErrors(onAgentEvent.mock.calls);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: "error", aborted: true, terminalCode: "aborted" });
    expect(errors[0]).not.toHaveProperty("yielded");
  });
});
