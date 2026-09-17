import { afterEach, describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
  armAttemptRetryRecovery,
  consumeSuppressedTerminal,
  consumeWithheldTerminal,
  disarmAttemptRetryRecovery,
} from "./pi-embedded-runner/attempt-retry-registry.js";
import { handleAgentEnd } from "./pi-embedded-subscribe.handlers.lifecycle.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

function createContext(
  lastAssistant: unknown,
  overrides?: {
    onAgentEvent?: (event: unknown) => void;
    onBeforeLifecycleTerminal?: () => void | Promise<void>;
    onBlockReply?: ((payload: unknown) => void) | undefined;
    onBlockReplyFlush?: () => void | Promise<void>;
    suppressLifecycleTerminal?: boolean;
  },
): EmbeddedPiSubscribeContext {
  const hasOnBlockReplyOverride = Boolean(overrides && "onBlockReply" in overrides);
  const onBlockReply = hasOnBlockReplyOverride ? overrides?.onBlockReply : vi.fn();
  const emitBlockReply = vi.fn();
  return {
    params: {
      runId: "run-1",
      config: {},
      sessionKey: "agent:main:main",
      onAgentEvent: overrides?.onAgentEvent,
      onBeforeLifecycleTerminal: overrides?.onBeforeLifecycleTerminal,
      suppressLifecycleTerminal: overrides?.suppressLifecycleTerminal,
      ...(onBlockReply ? { onBlockReply } : {}),
      onBlockReplyFlush: overrides?.onBlockReplyFlush,
    },
    state: {
      lastAssistant: lastAssistant as EmbeddedPiSubscribeContext["state"]["lastAssistant"],
      pendingCompactionRetry: 0,
      pendingToolMediaUrls: [],
      pendingToolAudioAsVoice: false,
      replayState: { replayInvalid: false, hadPotentialSideEffects: false },
      blockState: {
        thinking: true,
        final: true,
        inlineCode: createInlineCodeState(),
      },
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    flushBlockReplyBuffer: vi.fn(),
    emitBlockReply,
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
  } as unknown as EmbeddedPiSubscribeContext;
}

async function handleAgentEndAndReadWarnMeta(ctx: EmbeddedPiSubscribeContext) {
  await handleAgentEnd(ctx);

  const warn = vi.mocked(ctx.log.warn);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toBe("embedded run agent end");
  return warn.mock.calls[0]?.[1];
}

describe("handleAgentEnd", () => {
  it("logs the resolved error message when run ends with assistant error", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";

    const warnMeta = await handleAgentEndAndReadWarnMeta(ctx);
    expect(warnMeta).toMatchObject({
      event: "embedded_run_agent_end",
      runId: "run-1",
      error: "LLM request failed: connection refused by the provider endpoint.",
      providerRuntimeFailureKind: "timeout",
      rawErrorPreview: "connection refused",
      consoleMessage:
        "embedded run agent end: runId=run-1 isError=true model=unknown provider=unknown error=LLM request failed: connection refused by the provider endpoint. rawError=connection refused",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "LLM request failed: connection refused by the provider endpoint.",
        livenessState: "blocked",
      },
    });
  });

  it("attaches raw provider error metadata and includes model/provider in console output", async () => {
    const ctx = createContext({
      role: "assistant",
      stopReason: "error",
      provider: "anthropic",
      model: "claude-test",
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      content: [{ type: "text", text: "" }],
    });

    const warnMeta = await handleAgentEndAndReadWarnMeta(ctx);
    expect(warnMeta).toMatchObject({
      event: "embedded_run_agent_end",
      runId: "run-1",
      error: "The AI service is temporarily overloaded. Please try again in a moment.",
      failoverReason: "overloaded",
      providerRuntimeFailureKind: "timeout",
      providerErrorType: "overloaded_error",
      consoleMessage:
        'embedded run agent end: runId=run-1 isError=true model=claude-test provider=anthropic error=The AI service is temporarily overloaded. Please try again in a moment. rawError={"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    });
  });

  it("sanitizes model and provider before writing consoleMessage", async () => {
    const ctx = createContext({
      role: "assistant",
      stopReason: "error",
      provider: "anthropic\u001b]8;;https://evil.test\u0007",
      model: "claude\tsonnet\n4",
      errorMessage: "connection refused",
      content: [{ type: "text", text: "" }],
    });

    await handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    const meta = warn.mock.calls[0]?.[1];
    expect(meta).toMatchObject({
      consoleMessage:
        "embedded run agent end: runId=run-1 isError=true model=claude sonnet 4 provider=anthropic]8;;https://evil.test error=LLM request failed: connection refused by the provider endpoint. rawError=connection refused",
    });
    expect(meta?.consoleMessage).not.toContain("\n");
    expect(meta?.consoleMessage).not.toContain("\r");
    expect(meta?.consoleMessage).not.toContain("\t");
    expect(meta?.consoleMessage).not.toContain("\u001b");
  });

  it("redacts logged error text before emitting lifecycle events", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "x-api-key: sk-abcdefghijklmnopqrstuvwxyz123456",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );

    await handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      event: "embedded_run_agent_end",
      error: "x-api-key: ***",
      rawErrorPreview: "x-api-key: ***",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "x-api-key: ***",
      },
    });
  });

  it("logs runtime failure kind for missing-scope auth errors", async () => {
    const ctx = createContext({
      role: "assistant",
      stopReason: "error",
      provider: "openai-codex",
      model: "gpt-5.4",
      errorMessage:
        '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
      content: [{ type: "text", text: "" }],
    });

    await handleAgentEnd(ctx);

    expect(vi.mocked(ctx.log.warn).mock.calls[0]?.[1]).toMatchObject({
      failoverReason: "auth",
      providerRuntimeFailureKind: "auth_scope",
      httpCode: "401",
    });
  });

  it("omits raw HTML auth bodies from consoleMessage for HTML 403 auth failures", async () => {
    const ctx = createContext({
      role: "assistant",
      stopReason: "error",
      provider: "openai-codex",
      model: "gpt-5.4",
      errorMessage: "403 <!DOCTYPE html><html><body>Access denied</body></html>",
      content: [{ type: "text", text: "" }],
    });

    await handleAgentEnd(ctx);

    const warnMeta = vi.mocked(ctx.log.warn).mock.calls[0]?.[1];
    expect(warnMeta).toMatchObject({
      providerRuntimeFailureKind: "auth_html_403",
      rawErrorPreview: "403 <!DOCTYPE html><html><body>Access denied</body></html>",
      error:
        "Authentication failed with an HTML 403 response from the provider. Re-authenticate and verify your provider account access.",
    });
    const consoleMsg = typeof warnMeta?.consoleMessage === "string" ? warnMeta.consoleMessage : "";
    expect(consoleMsg).not.toContain("rawError=");
    expect(consoleMsg).not.toContain("<html>");
  });

  it("keeps non-error run-end logging on debug only", async () => {
    const ctx = createContext(undefined);

    await handleAgentEnd(ctx);

    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(ctx.log.debug).toHaveBeenCalledWith("embedded run agent end: runId=run-1 isError=false");
  });

  it("surfaces replay-invalid paused lifecycle end state when present", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.replayState = { ...ctx.state.replayState, replayInvalid: true };
    ctx.state.livenessState = "paused";

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "paused",
        replayInvalid: true,
      },
    });
  });

  it("derives abandoned lifecycle end state when replay-invalid work finished without a reply", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.replayState = { ...ctx.state.replayState, replayInvalid: true };
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = [];
    ctx.state.messagingToolSentTexts = [];
    ctx.state.messagingToolSentMediaUrls = [];
    ctx.state.successfulCronAdds = 0;

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "abandoned",
        replayInvalid: true,
      },
    });
  });

  it("marks incomplete tool-use lifecycle end state before runner finalization", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = [];

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "abandoned",
        replayInvalid: true,
      },
    });
  });

  it("marks tool-use terminal with pre-tool text as abandoned (#76477)", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Initial analysis..." },
          { type: "tool_use", id: "tool_1", name: "read", input: { path: "src/index.ts" } },
        ],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = ["Initial analysis..."];

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "abandoned",
        replayInvalid: true,
      },
    });
  });

  it("keeps accumulated deterministic side effects from being marked abandoned", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.replayState = { ...ctx.state.replayState, replayInvalid: true };
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = [];
    ctx.state.hadDeterministicSideEffect = true;

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "working",
        replayInvalid: true,
      },
    });
  });

  it("flushes orphaned tool media as a media-only block reply", async () => {
    const ctx = createContext(undefined);
    ctx.state.pendingToolMediaUrls = ["/tmp/reply.opus"];
    ctx.state.pendingToolAudioAsVoice = true;

    await handleAgentEnd(ctx);

    expect(ctx.emitBlockReply).toHaveBeenCalledWith({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(false);
  });

  it("preserves orphaned tool media when no block reply callback is configured", async () => {
    const ctx = createContext(undefined, { onBlockReply: undefined });
    ctx.state.pendingToolMediaUrls = ["/tmp/reply.opus"];
    ctx.state.pendingToolAudioAsVoice = true;

    await handleAgentEnd(ctx);

    expect(ctx.emitBlockReply).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });

  it("emits orphaned tool media before the lifecycle end event", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.pendingToolMediaUrls = ["/tmp/reply.opus"];
    ctx.state.pendingToolAudioAsVoice = true;

    await handleAgentEnd(ctx);

    const blockReplyOrder =
      (vi.mocked(ctx.emitBlockReply).mock.invocationCallOrder[0] as number | undefined) ?? 0;
    const lifecycleOrder = onAgentEvent.mock.invocationCallOrder[0] as number | undefined;

    expect(blockReplyOrder).toBeGreaterThan(0);
    expect(lifecycleOrder).toBeGreaterThan(blockReplyOrder);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("resolves compaction wait before awaiting an async block reply flush", async () => {
    let resolveFlush: (() => void) | undefined;
    const ctx = createContext(undefined);
    ctx.flushBlockReplyBuffer = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFlush = resolve;
          }),
      )
      .mockImplementation(() => {});

    const endPromise = handleAgentEnd(ctx);

    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(ctx.resolveCompactionRetry).not.toHaveBeenCalled();

    resolveFlush?.();
    await endPromise;
  });

  it("resolves compaction wait before awaiting an async channel flush", async () => {
    let resolveChannelFlush: (() => void) | undefined;
    const onBlockReplyFlush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChannelFlush = resolve;
        }),
    );
    const ctx = createContext(undefined, { onBlockReplyFlush });

    const endPromise = handleAgentEnd(ctx);

    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);

    resolveChannelFlush?.();
    await endPromise;
  });

  it("runs the before-lifecycle callback before the lifecycle end event", async () => {
    const order: string[] = [];
    const onAgentEvent = vi.fn(() => {
      order.push("event");
    });
    const onBeforeLifecycleTerminal = vi.fn(() => {
      order.push("before");
    });
    const ctx = createContext(undefined, {
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    await handleAgentEnd(ctx);

    expect(order).toEqual(["before", "event"]);
    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("adds verification evidence without changing an existing error terminal", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      { role: "assistant", stopReason: "error", errorMessage: "Failed", content: [] },
      { onAgentEvent },
    );
    const receipt = {
      version: 1 as const,
      mode: "shadow" as const,
      outcome: "unchecked" as const,
      checks: [],
      repair_attempts: 0 as const,
      stop_reason: "error" as const,
      ceiling_retried: null,
      skill_reads: null,
    };
    ctx.params.getDraftVerificationReceipt = () => receipt;
    await handleAgentEnd(ctx);
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error", draftVerification: receipt }),
      }),
    );
    expect(onAgentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phase: "end" }) }),
    );
  });

  it("terminates cancellation as aborted without success, retry withholding, or provider warnings", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      { role: "assistant", stopReason: "aborted", errorMessage: "Request aborted", content: [] },
      { onAgentEvent },
    );
    armAttemptRetryRecovery("run-1", {
      hasOverflowBudget: () => true,
      hasNoVisibleAnswerRetryBudget: () => true,
    });
    try {
      await handleAgentEnd(ctx);
      expect(consumeWithheldTerminal("run-1")).toBeNull();
    } finally {
      disarmAttemptRetryRecovery("run-1");
    }
    expect(onAgentEvent).toHaveBeenCalledExactlyOnceWith({
      stream: "lifecycle",
      data: expect.objectContaining({ phase: "error", stopReason: "aborted", aborted: true }),
    });
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("runs terminal cleanup but lets the outer run own final lifecycle ordering", async () => {
    const { emitAgentEvent } = await import("../infra/agent-events.js");
    vi.mocked(emitAgentEvent).mockClear();
    const onAgentEvent = vi.fn();
    const onBeforeLifecycleTerminal = vi.fn();
    const ctx = createContext(undefined, {
      onAgentEvent,
      onBeforeLifecycleTerminal,
      suppressLifecycleTerminal: true,
    });

    await handleAgentEnd(ctx);

    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(vi.mocked(emitAgentEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream: "lifecycle" }),
    );
    expect(ctx.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("outer run owns final payload ordering"),
    );
  });

  it("runs an async before-lifecycle callback before the lifecycle end event", async () => {
    const order: string[] = [];
    const onAgentEvent = vi.fn(() => {
      order.push("event");
    });
    const onBeforeLifecycleTerminal = vi.fn(() =>
      Promise.resolve().then(() => {
        order.push("before");
      }),
    );
    const ctx = createContext(undefined, {
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    await handleAgentEnd(ctx);

    expect(order).toEqual(["before", "event"]);
    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("still emits lifecycle terminal when sync before-lifecycle callback throws", async () => {
    const onAgentEvent = vi.fn();
    const onBeforeLifecycleTerminal = vi.fn(() => {
      throw new Error("hook exploded");
    });
    const ctx = createContext(undefined, {
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    await handleAgentEnd(ctx);

    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("still emits lifecycle terminal when async before-lifecycle callback rejects", async () => {
    const onAgentEvent = vi.fn();
    const onBeforeLifecycleTerminal = vi.fn(() => Promise.reject(new Error("hook failed")));
    const ctx = createContext(undefined, {
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    await handleAgentEnd(ctx);

    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("emits lifecycle end after async channel flush completes", async () => {
    let resolveChannelFlush: (() => void) | undefined;
    const onAgentEvent = vi.fn();
    const onBlockReplyFlush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChannelFlush = resolve;
        }),
    );
    const ctx = createContext(undefined, { onAgentEvent, onBlockReplyFlush });

    const endPromise = handleAgentEnd(ctx);

    expect(onAgentEvent).not.toHaveBeenCalled();

    resolveChannelFlush?.();
    await endPromise;

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("emits lifecycle error after async channel flush completes", async () => {
    let resolveChannelFlush: (() => void) | undefined;
    const onAgentEvent = vi.fn();
    const onBlockReplyFlush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChannelFlush = resolve;
        }),
    );
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent, onBlockReplyFlush },
    );

    const endPromise = handleAgentEnd(ctx);

    expect(onAgentEvent).not.toHaveBeenCalled();

    resolveChannelFlush?.();
    await endPromise;

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "LLM request failed: connection refused by the provider endpoint.",
      },
    });
  });

  it("emits lifecycle end when block reply flush rejects", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.flushBlockReplyBuffer = vi.fn().mockRejectedValue(new Error("flush failed"));

    await expect(handleAgentEnd(ctx)).rejects.toThrow("flush failed");

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("emits lifecycle end when channel flush rejects", async () => {
    const onAgentEvent = vi.fn();
    const onBlockReplyFlush = vi.fn().mockRejectedValue(new Error("channel flush failed"));
    const ctx = createContext(undefined, { onAgentEvent, onBlockReplyFlush });

    await expect(handleAgentEnd(ctx)).rejects.toThrow("channel flush failed");

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("emits lifecycle end when block reply flush throws", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.flushBlockReplyBuffer = vi.fn(() => {
      throw new Error("flush exploded");
    });

    expect(() => handleAgentEnd(ctx)).toThrow("flush exploded");

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
});

function armRun(budgets: { overflow?: () => boolean; noAnswer?: () => boolean } = {}) {
  armAttemptRetryRecovery("run-1", {
    hasOverflowBudget: budgets.overflow ?? (() => true),
    hasNoVisibleAnswerRetryBudget: budgets.noAnswer ?? (() => true),
  });
}

describe("handleAgentEnd overflow-recovery suppression (Magister fork)", () => {
  const OVERFLOW_ERROR =
    "Context overflow: estimated context size exceeds safe threshold during tool loop.";

  afterEach(() => {
    disarmAttemptRetryRecovery("run-1");
  });

  it("suppresses the terminal lifecycle error while the run loop will retry", async () => {
    const { emitAgentEvent } = await import("../infra/agent-events.js");
    vi.mocked(emitAgentEvent).mockClear();
    armRun();
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: OVERFLOW_ERROR,
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";

    await handleAgentEnd(ctx);

    // No terminal lifecycle event reached subscribers …
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(vi.mocked(emitAgentEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream: "lifecycle" }),
    );
    // … and the suppression was recorded for the run loop's give-up path.
    expect(consumeSuppressedTerminal("run-1")).toBe(true);
  });

  it("emits the terminal error normally once overflow budget is exhausted", async () => {
    armRun({ overflow: () => false });
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: OVERFLOW_ERROR,
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error" }),
      }),
    );
    expect(consumeSuppressedTerminal("run-1")).toBe(false);
  });

  it("emits non-overflow terminal errors even while armed", async () => {
    armRun();
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error" }),
      }),
    );
  });
});

describe("handleAgentEnd retryable-empty-attempt withholding (Magister fork)", () => {
  // The run loop's `while (true)` reuses one runId across attempts, so an
  // attempt that produced no visible answer is not terminal for the run while
  // a retry can still fire. Emitting `end` here closed the HTTP stream and
  // orphaned the retry's answer (2026-08-07).
  function createEmptyAttemptContext(
    assistantTexts: string[],
    onAgentEvent: (event: unknown) => void,
  ) {
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: assistantTexts.join("") }],
      },
      { onAgentEvent },
    );
    ctx.state.assistantTexts = assistantTexts;
    ctx.state.livenessState = "working";
    return ctx;
  }

  afterEach(() => {
    disarmAttemptRetryRecovery("run-1");
  });

  it("withholds the terminal end when an empty attempt can still be retried", async () => {
    const { emitAgentEvent } = await import("../infra/agent-events.js");
    vi.mocked(emitAgentEvent).mockClear();
    armRun();
    const onAgentEvent = vi.fn();

    await handleAgentEnd(createEmptyAttemptContext([""], onAgentEvent));

    // Nothing terminal reached subscribers — the stream stays open for the retry.
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(vi.mocked(emitAgentEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream: "lifecycle" }),
    );
    // … and the run loop's finally has the exact payload the handler would
    // have emitted, so a run that ends up not retrying loses nothing.
    expect(consumeWithheldTerminal("run-1")).toEqual({ livenessState: "working" });
  });

  it("emits the terminal end normally when the attempt answered", async () => {
    armRun();
    const onAgentEvent = vi.fn();

    await handleAgentEnd(
      createEmptyAttemptContext(["Google Images is open with a search for lions."], onAgentEvent),
    );

    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "end" }),
      }),
    );
    expect(consumeWithheldTerminal("run-1")).toBeNull();
  });

  it("emits the terminal end normally once every retry is spent", async () => {
    armRun({ noAnswer: () => false });
    const onAgentEvent = vi.fn();

    await handleAgentEnd(createEmptyAttemptContext([""], onAgentEvent));

    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "end" }),
      }),
    );
    expect(consumeWithheldTerminal("run-1")).toBeNull();
  });

  it("emits the terminal end normally when the run was never armed", async () => {
    const onAgentEvent = vi.fn();

    await handleAgentEnd(createEmptyAttemptContext([""], onAgentEvent));

    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "end" }),
      }),
    );
  });
});

describe("handleAgentEnd cut-tool-chain withholding (Magister fork)", () => {
  // 2026-08-25 (Digmatix): the model narrated one sentence, issued eight
  // parallel reads, and the loop threw before the next model call. The SDK
  // swallowed the throw (synthetic error message, no message_end), the
  // handler saw a stale toolUse lastAssistant plus visible narration, emitted
  // `end`, the HTTP stream closed at 60s, and the same-runId retry answered
  // headless for 24 minutes.
  const OVERFLOW_ERROR =
    "Context overflow: estimated context size exceeds safe threshold during tool loop.";

  function createCutToolChainContext(onAgentEvent: (event: unknown) => void) {
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "I'll pull the underlying Google Ads reports first." },
          { type: "toolCall", id: "call_1", name: "magister_integration_read", arguments: {} },
        ],
      },
      { onAgentEvent },
    );
    ctx.state.assistantTexts = ["I'll pull the underlying Google Ads reports first."];
    ctx.state.livenessState = "working";
    return ctx;
  }

  afterEach(() => {
    disarmAttemptRetryRecovery("run-1");
  });

  it("withholds the terminal end of a cut tool chain despite pre-tool narration", async () => {
    const { emitAgentEvent } = await import("../infra/agent-events.js");
    vi.mocked(emitAgentEvent).mockClear();
    armRun();
    const onAgentEvent = vi.fn();

    await handleAgentEnd(createCutToolChainContext(onAgentEvent));

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(vi.mocked(emitAgentEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream: "lifecycle" }),
    );
    // The run loop's finally flushes exactly the #76477 payload if no retry starts.
    expect(consumeWithheldTerminal("run-1")).toEqual({
      livenessState: "abandoned",
      replayInvalid: true,
    });
  });

  it("still emits the #76477 abandoned end for a cut tool chain when the run is not armed", async () => {
    const onAgentEvent = vi.fn();

    await handleAgentEnd(createCutToolChainContext(onAgentEvent));

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end", livenessState: "abandoned", replayInvalid: true },
    });
    expect(consumeWithheldTerminal("run-1")).toBeNull();
  });

  it("suppresses a context overflow the agent loop swallowed while overflow recovery can retry", async () => {
    const { emitAgentEvent } = await import("../infra/agent-events.js");
    vi.mocked(emitAgentEvent).mockClear();
    armRun({ noAnswer: () => false, overflow: () => true });
    const onAgentEvent = vi.fn();
    const ctx = createCutToolChainContext(onAgentEvent);

    await handleAgentEnd(ctx, {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: OVERFLOW_ERROR,
          content: [{ type: "text", text: "" }],
        },
      ],
    });

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(vi.mocked(emitAgentEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream: "lifecycle" }),
    );
    expect(consumeSuppressedTerminal("run-1")).toBe(true);
    expect(consumeWithheldTerminal("run-1")).toBeNull();
  });

  it("withholds a non-overflow failure the agent loop swallowed while a retry is still possible", async () => {
    armRun();
    const onAgentEvent = vi.fn();

    await handleAgentEnd(createCutToolChainContext(onAgentEvent), {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "convertToLlm exploded",
          content: [{ type: "text", text: "" }],
        },
      ],
    });

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(consumeWithheldTerminal("run-1")).toEqual({
      livenessState: "abandoned",
      replayInvalid: true,
    });
  });

  it("surfaces a swallowed failure as a terminal error once every retry is spent", async () => {
    armRun({ noAnswer: () => false, overflow: () => false });
    const onAgentEvent = vi.fn();

    await handleAgentEnd(createCutToolChainContext(onAgentEvent), {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "convertToLlm exploded",
          content: [{ type: "text", text: "" }],
        },
      ],
    });

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: expect.objectContaining({
        phase: "error",
        error: expect.stringContaining("convertToLlm exploded"),
        livenessState: "abandoned",
        replayInvalid: true,
      }),
    });
    expect(consumeWithheldTerminal("run-1")).toBeNull();
  });

  it("ignores agent_end messages whose tail is the assistant message it already saw", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Final answer." }],
      },
      { onAgentEvent },
    );
    ctx.state.assistantTexts = ["Final answer."];
    ctx.state.livenessState = "working";

    await handleAgentEnd(ctx, { messages: [ctx.state.lastAssistant] });

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end", livenessState: "working" },
    });
  });
});
