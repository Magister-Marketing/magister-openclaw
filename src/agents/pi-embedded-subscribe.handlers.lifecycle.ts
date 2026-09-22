import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { extractPrefixedHttpStatus } from "../shared/assistant-error-format.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
  sanitizeForConsole,
} from "./pi-embedded-error-observation.js";
import { classifyFailoverReason, formatAssistantErrorText } from "./pi-embedded-helpers.js";
import {
  shouldSuppressTerminalOverflowError,
  withholdTerminalForPendingRetry,
} from "./pi-embedded-runner/attempt-retry-registry.js";
import { hasCommittedMessagingToolDeliveryEvidence } from "./pi-embedded-runner/delivery-evidence.js";
import { isIncompleteTerminalAssistantTurn } from "./pi-embedded-runner/run/incomplete-turn.js";
import {
  consumePendingToolMediaReply,
  hasAssistantVisibleReply,
} from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { isPromiseLike } from "./pi-embedded-subscribe.promise.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";

export {
  handleCompactionEnd,
  handleCompactionStart,
} from "./pi-embedded-subscribe.handlers.compaction.js";

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: Date.now(),
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "start" },
  });
}

/**
 * Magister fork: the failure message pi-agent-core synthesizes when the loop
 * itself throws (transformContext, convertToLlm, stream setup). The SDK's
 * `runWithLifecycle` catches that throw, pushes an assistant message with
 * `stopReason: "error"` into agent state WITHOUT a `message_end`, and resolves
 * `prompt()` normally — so `ctx.state.lastAssistant` (updated only on
 * `message_end`) still points at the last real assistant message, the attempt
 * reports success, and the only trace of the failure is the tail of the
 * `agent_end` event's `messages`. Read it from there, or the per-attempt
 * terminal below classifies a cut tool chain as a clean `end` (2026-08-25).
 */
export function resolveSwallowedRunFailure(
  evt: { messages?: unknown } | undefined,
  lastAssistant: unknown,
): (AgentMessage & { role: "assistant" }) | null {
  const messages = evt?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const tail = messages[messages.length - 1];
  if (!isAssistantMessage(tail) || tail.stopReason !== "error" || tail === lastAssistant) {
    return null;
  }
  return tail;
}

/**
 * Magister fork: the classification the HTTP surface (openai-http.ts) puts
 * on the terminal `event: error` frame. A friendly lifecycle message loses the
 * provider's HTTP status, so it is read off the raw assistant error here and
 * carried as `status`. A settled model error is a `provider_error` when it
 * carries a status (the Gateway keys retry/paywall on it) and a
 * `terminal_result_error` otherwise; without this stamp the surface could only
 * call it "run ended without result", which the Gateway treats as a lost run
 * and the workflow orchestrator retries (2026-09-21: an OpenAI 522 relayed by
 * the LLM proxy mid-stream).
 */
export function resolveTerminalErrorStamp(rawErrorMessage: string | undefined): {
  terminalCode: "provider_error" | "terminal_result_error";
  status?: number;
} {
  const status = extractPrefixedHttpStatus(rawErrorMessage ?? "");
  return status !== undefined
    ? { terminalCode: "provider_error", status }
    : { terminalCode: "terminal_result_error" };
}

export function handleAgentEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt?: { messages?: unknown },
): void | Promise<void> {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  const isAborted = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "aborted";
  const swallowedFailure =
    isError || isAborted ? null : resolveSwallowedRunFailure(evt, lastAssistant);
  let lifecycleErrorText: string | undefined;
  const hasAssistantVisibleText =
    Array.isArray(ctx.state.assistantTexts) &&
    ctx.state.assistantTexts.some((text) => hasAssistantVisibleReply({ text }));
  const hadDeterministicSideEffect =
    ctx.state.hadDeterministicSideEffect === true ||
    hasCommittedMessagingToolDeliveryEvidence(ctx.state) ||
    (ctx.state.successfulCronAdds ?? 0) > 0;
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText,
    lastAssistant: isAssistantMessage(lastAssistant) ? lastAssistant : null,
  });
  const replayInvalid =
    ctx.state.replayState.replayInvalid || incompleteTerminalAssistant ? true : undefined;
  // Tool-use terminal guard: when the last assistant message ended with a
  // tool-call stop reason, the turn is incomplete even when pre-tool text
  // exists — mark as abandoned so lifecycle consumers do not see a working
  // end state for an interrupted tool chain. (#76477)
  const derivedWorkingTerminalState =
    isError || isAborted
      ? "blocked"
      : replayInvalid &&
          !hadDeterministicSideEffect &&
          (!hasAssistantVisibleText || incompleteTerminalAssistant)
        ? "abandoned"
        : ctx.state.livenessState;
  const livenessState =
    ctx.state.livenessState === "working" ? derivedWorkingTerminalState : ctx.state.livenessState;

  if (isError && lastAssistant) {
    const friendlyError = formatAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
    });
    const rawError = lastAssistant.errorMessage?.trim();
    const failoverReason = classifyFailoverReason(rawError ?? "", {
      provider: lastAssistant.provider,
    });
    const errorText = (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim();
    const observedError = buildApiErrorObservationFields(rawError, {
      provider: lastAssistant.provider,
    });
    const safeErrorText =
      buildTextObservationFields(errorText, {
        provider: lastAssistant.provider,
      }).textPreview ?? "LLM request failed.";
    lifecycleErrorText = safeErrorText;
    const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
    const safeModel = sanitizeForConsole(lastAssistant.model) ?? "unknown";
    const safeProvider = sanitizeForConsole(lastAssistant.provider) ?? "unknown";
    const safeRawErrorPreview = sanitizeForConsole(observedError.rawErrorPreview);
    const shouldSuppressRawErrorConsoleSuffix =
      observedError.providerRuntimeFailureKind === "auth_html_403" ||
      observedError.providerRuntimeFailureKind === "auth_scope" ||
      observedError.providerRuntimeFailureKind === "auth_refresh";
    const rawErrorConsoleSuffix =
      safeRawErrorPreview && !shouldSuppressRawErrorConsoleSuffix
        ? ` rawError=${safeRawErrorPreview}`
        : "";
    ctx.log.warn("embedded run agent end", {
      event: "embedded_run_agent_end",
      tags: ["error_handling", "lifecycle", "agent_end", "assistant_error"],
      runId: ctx.params.runId,
      isError: true,
      error: safeErrorText,
      failoverReason,
      model: lastAssistant.model,
      provider: lastAssistant.provider,
      ...observedError,
      consoleMessage: `embedded run agent end: runId=${safeRunId} isError=true model=${safeModel} provider=${safeProvider} error=${safeErrorText}${rawErrorConsoleSuffix}`,
    });
  } else {
    ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);
  }

  const emitLifecycleTerminal = () => {
    if (ctx.params.suppressLifecycleTerminal === true) {
      ctx.log.debug(
        `suppressing internal attempt lifecycle terminal: runId=${ctx.params.runId} ` +
          `(outer run owns final payload ordering)`,
      );
      return;
    }
    const terminalMeta = {
      ...(ctx.params.getDraftVerificationReceipt
        ? { draftVerification: { ...ctx.params.getDraftVerificationReceipt() } }
        : {}),
      ...(ctx.state.terminalStopReason ? { stopReason: ctx.state.terminalStopReason } : {}),
      ...(isAborted ? { stopReason: "aborted", aborted: true } : {}),
      ...(ctx.state.yielded === true ? { yielded: true } : {}),
    };
    // Magister fork: a context-overflow attempt error the run loop will
    // compact-and-retry is not terminal for the run — emitting `error` here
    // would close HTTP/WS subscribers while the retried prompt keeps working
    // headless. The run loop emits the terminal error itself if recovery
    // gives up (see attempt-retry-registry.ts).
    if (isError) {
      const overflowProbeText =
        (isAssistantMessage(lastAssistant)
          ? lastAssistant.errorMessage?.trim() || undefined
          : undefined) ?? lifecycleErrorText;
      if (shouldSuppressTerminalOverflowError(ctx.params.runId, overflowProbeText)) {
        ctx.log.warn(
          `suppressing terminal lifecycle error for recoverable context overflow: ` +
            `runId=${ctx.params.runId} (run loop owns overflow recovery)`,
        );
        return;
      }
    }
    if (isError || isAborted) {
      // Cancellation is terminal, not successful completion. Keep it out of
      // provider-error warnings and retry/empty-answer recovery above/below.
      const terminalError = isAborted
        ? "Request aborted."
        : (lifecycleErrorText ?? "LLM request failed.");
      // A sessions_yield ends the attempt as a synthetic abort; it keeps its
      // `yielded` mark and no code, so the HTTP surface closes it as an
      // intentional end rather than a stop or a lost run.
      const terminalStamp = isAborted
        ? ctx.state.yielded === true
          ? {}
          : { terminalCode: "aborted" as const }
        : resolveTerminalErrorStamp(
            isAssistantMessage(lastAssistant) ? lastAssistant.errorMessage : undefined,
          );
      emitAgentEvent({
        runId: ctx.params.runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          error: terminalError,
          ...terminalMeta,
          ...terminalStamp,
          ...(livenessState ? { livenessState } : {}),
          ...(replayInvalid ? { replayInvalid } : {}),
          endedAt: Date.now(),
        },
      });
      void ctx.params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "error",
          error: terminalError,
          ...terminalMeta,
          ...terminalStamp,
          ...(livenessState ? { livenessState } : {}),
          ...(replayInvalid ? { replayInvalid } : {}),
        },
      });
      return;
    }
    const endData = {
      ...terminalMeta,
      ...(livenessState ? { livenessState } : {}),
      ...(replayInvalid ? { replayInvalid } : {}),
    };
    // Magister fork: a loop error the SDK swallowed (see
    // resolveSwallowedRunFailure) gets the same treatment a streamed error
    // would have: a recoverable context overflow is the run loop's to retry,
    // so its terminal is suppressed exactly like the `isError` branch above.
    if (swallowedFailure) {
      const swallowedText = swallowedFailure.errorMessage?.trim() || undefined;
      if (shouldSuppressTerminalOverflowError(ctx.params.runId, swallowedText)) {
        ctx.log.warn(
          `suppressing terminal lifecycle error for recoverable context overflow ` +
            `swallowed by the agent loop: runId=${ctx.params.runId} (run loop owns overflow recovery)`,
        );
        return;
      }
    }
    // Magister fork: an attempt that produced no visible answer is not
    // terminal for the run while the run loop can still retry it — the
    // planning-only, reasoning-only, empty-response, and compaction-
    // continuation retries all `continue` under this same runId. Emitting
    // `end` here closes HTTP/WS subscribers, and the retried attempt's real
    // answer then goes nowhere (2026-08-07: GPT-5.6 returned empty, the retry
    // answered 13s later, the user got "Agent didn't return a response").
    // The same holds for an attempt cut mid tool chain (#76477's
    // `incompleteTerminalAssistant`): its pre-tool narration is not an
    // answer, and the retry that finishes the chain reuses this runId
    // (2026-08-25: one sentence, 8 reads, 24 headless minutes). The run loop
    // emits what we withhold, in its finally.
    const endedMidToolChain = incompleteTerminalAssistant || swallowedFailure !== null;
    if (
      withholdTerminalForPendingRetry(ctx.params.runId, {
        hasAssistantVisibleText,
        endedMidToolChain,
        terminalData: endData,
      })
    ) {
      ctx.log.debug(
        `withholding terminal lifecycle end for a retryable ${
          endedMidToolChain ? "cut-tool-chain" : "empty"
        } attempt: runId=${ctx.params.runId} (run loop owns the terminal)`,
      );
      return;
    }
    if (swallowedFailure) {
      // No retry budget is left to finish this attempt, so its swallowed
      // failure is the run's real outcome: surface it as an error rather
      // than a clean `end` that hides a cut tool chain behind narration.
      const swallowedErrorText =
        buildTextObservationFields((swallowedFailure.errorMessage || "Agent run failed.").trim(), {
          provider: swallowedFailure.provider,
        }).textPreview ?? "Agent run failed.";
      ctx.log.warn(
        `embedded run agent end: runId=${sanitizeForConsole(ctx.params.runId) ?? "-"} ` +
          `isError=true (swallowed by agent loop) error=${swallowedErrorText}`,
      );
      const swallowedStamp = resolveTerminalErrorStamp(swallowedFailure.errorMessage);
      emitAgentEvent({
        runId: ctx.params.runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          error: swallowedErrorText,
          ...endData,
          ...swallowedStamp,
          endedAt: Date.now(),
        },
      });
      void ctx.params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "error",
          error: swallowedErrorText,
          ...endData,
          ...swallowedStamp,
        },
      });
      return;
    }
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        ...endData,
        endedAt: Date.now(),
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "end",
        ...endData,
      },
    });
  };

  const finalizeAgentEnd = () => {
    ctx.state.blockState.thinking = false;
    ctx.state.blockState.final = false;
    ctx.state.blockState.inlineCode = createInlineCodeState();

    if (ctx.state.pendingCompactionRetry > 0) {
      ctx.resolveCompactionRetry();
    } else {
      ctx.maybeResolveCompactionWait();
    }
  };

  const flushPendingMediaAndChannel = () => {
    if (ctx.params.onBlockReply) {
      const pendingToolMediaReply = consumePendingToolMediaReply(ctx.state);
      if (pendingToolMediaReply && hasAssistantVisibleReply(pendingToolMediaReply)) {
        ctx.emitBlockReply(pendingToolMediaReply);
      }
    }

    const postMediaFlushResult = ctx.flushBlockReplyBuffer();
    if (isPromiseLike<void>(postMediaFlushResult)) {
      return postMediaFlushResult.then(() => {
        const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
        if (isPromiseLike<void>(onBlockReplyFlushResult)) {
          return onBlockReplyFlushResult;
        }
        return undefined;
      });
    }

    const onBlockReplyFlushResult = ctx.params.onBlockReplyFlush?.();
    if (isPromiseLike<void>(onBlockReplyFlushResult)) {
      return onBlockReplyFlushResult;
    }
    return undefined;
  };

  let lifecycleTerminalEmitted = false;
  const emitLifecycleTerminalOnce = (): void | Promise<void> => {
    if (lifecycleTerminalEmitted) {
      return;
    }
    lifecycleTerminalEmitted = true;
    let beforeLifecycleTerminal: void | Promise<void> = undefined;
    try {
      beforeLifecycleTerminal = ctx.params.onBeforeLifecycleTerminal?.();
    } catch (err) {
      ctx.log.debug(`before lifecycle terminal failed: ${String(err)}`);
    }
    if (isPromiseLike<void>(beforeLifecycleTerminal)) {
      return Promise.resolve(beforeLifecycleTerminal)
        .catch((err) => {
          ctx.log.debug(`before lifecycle terminal failed: ${String(err)}`);
        })
        .then(() => {
          emitLifecycleTerminal();
        });
    }
    emitLifecycleTerminal();
  };

  try {
    const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer();
    finalizeAgentEnd();
    const flushPendingMediaAndChannelResult = isPromiseLike<void>(flushBlockReplyBufferResult)
      ? Promise.resolve(flushBlockReplyBufferResult).then(() => flushPendingMediaAndChannel())
      : flushPendingMediaAndChannel();

    if (isPromiseLike<void>(flushPendingMediaAndChannelResult)) {
      return Promise.resolve(flushPendingMediaAndChannelResult).then(
        () => emitLifecycleTerminalOnce(),
        (error) => {
          const emitted = emitLifecycleTerminalOnce();
          if (isPromiseLike<void>(emitted)) {
            return Promise.resolve(emitted).then(() => {
              throw error;
            });
          }
          throw error;
        },
      );
    }
  } catch (error) {
    const emitted = emitLifecycleTerminalOnce();
    if (isPromiseLike<void>(emitted)) {
      return Promise.resolve(emitted).then(() => {
        throw error;
      });
    }
    throw error;
  }

  return emitLifecycleTerminalOnce();
}
