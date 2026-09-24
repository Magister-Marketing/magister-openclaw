import type {
  InternalBeforeToolBatchResult,
  InternalToolBatchCall,
  ToolLoopIntervention,
  ToolLoopWarning,
} from "@openclaw/agent-core";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  beforeToolCallLog as log,
  loadBeforeToolCallRuntime,
  shouldEmitLoopWarning,
} from "./agent-tools.before-tool-call.diagnostics.js";
import {
  recordBatchAdmittedToolCall,
  releaseBatchAdmittedToolCalls,
} from "./agent-tools.before-tool-call.state.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { hashToolCall } from "./tool-loop-detection.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

type ToolLoopCall = {
  toolName: string;
  params: unknown;
  toolCallId?: string;
};

type ToolLoopBatchAdmission = InternalBeforeToolBatchResult & {
  commitReadyCalls?: (calls: readonly { toolCallId: string; args: unknown }[]) => void;
  releaseSkippedCalls?: (toolCallIds: readonly string[]) => void;
};

// Magister fork: the runtime resilience guards have their own switch and must
// record and evaluate even when upstream's repeat detectors are off.
function isLoopAdmissionActive(ctx: HookContext): boolean {
  if (!ctx.sessionKey) {
    return false;
  }
  return (
    ctx.loopDetection?.enabled === true || ctx.loopDetection?.runtimeResilience?.enabled === true
  );
}

function loopScopeFor(ctx: HookContext, toolName: string) {
  const sideEffect = ctx.toolSideEffects?.get(toolName);
  return {
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    ...(sideEffect ? { sideEffect } : {}),
  };
}

async function evaluateToolLoopCall(
  call: ToolLoopCall,
  ctx: HookContext,
  stateOverride?: SessionState,
): Promise<ToolLoopIntervention | ToolLoopWarning | undefined> {
  if (!isLoopAdmissionActive(ctx)) {
    return undefined;
  }
  const toolName = normalizeToolPolicyName(call.toolName || "tool");
  const {
    getDiagnosticSessionState,
    logToolLoopAction,
    detectRuntimeResilienceBlock,
    detectToolCallLoop,
  } = await loadBeforeToolCallRuntime();
  // Project history for atomic admission, but keep warning buckets on the session owner.
  const sessionState = getDiagnosticSessionState({
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
  });
  const loopScope = loopScopeFor(ctx, toolName);
  // Magister fork: outcome-based guards decide first; they are independent of the
  // repeat detectors, which stay gated on loopDetection.enabled inside detectToolCallLoop.
  const resilienceResult = detectRuntimeResilienceBlock(
    stateOverride ?? sessionState,
    toolName,
    call.params,
    ctx.loopDetection,
    loopScope,
  );
  const result = resilienceResult.stuck
    ? resilienceResult
    : detectToolCallLoop(
        stateOverride ?? sessionState,
        toolName,
        call.params,
        ctx.loopDetection,
        loopScope,
      );
  if (!result.stuck) {
    return undefined;
  }
  if (result.level === "critical") {
    log.error(`Blocking ${toolName} due to critical loop: ${result.message}`);
    logToolLoopAction({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      toolName,
      level: "critical",
      action: "block",
      detector: result.detector,
      count: result.count,
      message: result.message,
      pairedToolName: result.pairedToolName,
    });
    return {
      kind: "critical-tool-loop",
      toolCallId: call.toolCallId ?? "",
      toolName,
      actionKey: hashToolCall(toolName, call.params),
      detector: result.detector,
      count: result.count,
      reason: result.message,
    };
  }
  const baseWarningKey = result.warningKey ?? `${result.detector}:${toolName}`;
  const warningKey = ctx.runId ? `${ctx.runId}:${baseWarningKey}` : baseWarningKey;
  if (shouldEmitLoopWarning(sessionState, warningKey, result.count)) {
    log.warn(`Loop warning for ${toolName}: ${result.message}`);
    logToolLoopAction({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      toolName,
      level: "warning",
      action: "warn",
      detector: result.detector,
      count: result.count,
      message: result.message,
      pairedToolName: result.pairedToolName,
    });
    return {
      kind: "tool-loop-warning",
      toolCallId: call.toolCallId ?? "",
      count: result.count,
    };
  }
  return undefined;
}

async function recordToolLoopCall(call: ToolLoopCall, ctx: HookContext): Promise<void> {
  if (!isLoopAdmissionActive(ctx)) {
    return;
  }
  const { getDiagnosticSessionState, recordToolCall } = await loadBeforeToolCallRuntime();
  const toolName = normalizeToolPolicyName(call.toolName || "tool");
  recordToolCall(
    getDiagnosticSessionState({ sessionKey: ctx.sessionKey, sessionId: ctx.sessionId }),
    toolName,
    call.params,
    call.toolCallId,
    ctx.loopDetection,
    loopScopeFor(ctx, toolName),
  );
}

/** Preserve the existing single-call admission path for harnesses without batch control. */
export async function admitSingleToolCallLoop(
  call: ToolLoopCall,
  ctx: HookContext,
): Promise<ToolLoopIntervention | ToolLoopWarning | undefined> {
  const intervention = await evaluateToolLoopCall(call, ctx);
  if (intervention?.kind !== "critical-tool-loop") {
    await recordToolLoopCall(call, ctx);
  }
  return intervention;
}

/**
 * Admit an assistant tool batch atomically. Successful calls reserve exact
 * markers here, then agent-core commits their history in assistant order at
 * the final launch boundary. A later veto still records only denial evidence.
 */
export async function admitToolCallBatch(
  calls: InternalToolBatchCall[],
  ctx: HookContext,
): Promise<ToolLoopBatchAdmission> {
  if (!isLoopAdmissionActive(ctx)) {
    return {};
  }
  const {
    getDiagnosticSessionState,
    markDiagnosticArgumentChurnObservation,
    reconcileToolCallExecutionParams,
    recordToolCall,
    resolveToolLoopWarningThreshold,
  } = await loadBeforeToolCallRuntime();
  const warningThreshold = resolveToolLoopWarningThreshold();
  const sessionState = getDiagnosticSessionState({
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
  });
  const projectedState: SessionState = {
    ...sessionState,
    toolCallHistory: [...(sessionState.toolCallHistory ?? [])],
  };
  const recordLoopVeto = (state: SessionState, call: InternalToolBatchCall) => {
    const vetoToolName = normalizeToolPolicyName(call.toolCall.name || "tool");
    recordToolCall(
      state,
      vetoToolName,
      call.args,
      call.toolCall.id,
      ctx.loopDetection,
      loopScopeFor(ctx, vetoToolName),
    );
    const projectedCall = state.toolCallHistory?.at(-1);
    if (projectedCall) {
      projectedCall.outcomeKind = "tool-loop-veto";
    }
  };
  const projectLoopVeto = (call: InternalToolBatchCall) => {
    // A batch is admitted atomically, so unrelated siblings must not evict the
    // real pre-batch history before a later candidate is checked. Build each
    // synthetic record through the canonical recorder, then append it to the
    // unbounded projection used only for this admission pass.
    const scratchState: SessionState = {
      ...sessionState,
      toolCallHistory: [],
    };
    recordLoopVeto(scratchState, call);
    const projectedCall = scratchState.toolCallHistory?.at(-1);
    if (projectedCall) {
      projectedState.toolCallHistory?.push(projectedCall);
    }
  };
  const warnings: ToolLoopWarning[] = [];
  for (const call of calls) {
    const toolName = normalizeToolPolicyName(call.toolCall.name || "tool");
    const intervention = await evaluateToolLoopCall(
      {
        toolName,
        params: call.args,
        toolCallId: call.toolCall.id,
      },
      ctx,
      projectedState,
    );
    if (intervention?.kind === "critical-tool-loop") {
      // Preserve only denial evidence. No call in this batch executed, but a
      // recovery retry must still see same-action siblings that crossed the
      // threshold. Unrelated skipped actions remain valid recovery choices.
      for (const rejectedCall of calls) {
        const rejectedActionKey = hashToolCall(
          normalizeToolPolicyName(rejectedCall.toolCall.name || "tool"),
          rejectedCall.args,
        );
        if (rejectedActionKey === intervention.actionKey) {
          recordLoopVeto(sessionState, rejectedCall);
        }
      }
      return { intervention };
    }
    if (intervention) {
      warnings.push(intervention);
    }
    // A later sibling must assume this candidate makes no progress.
    projectLoopVeto(call);
  }
  for (const call of calls) {
    recordBatchAdmittedToolCall(call.toolCall.id, ctx.runId);
  }
  const admittedById = new Map(
    calls.map((call) => [
      call.toolCall.id,
      { toolName: normalizeToolPolicyName(call.toolCall.name || "tool") },
    ]),
  );
  const committedIds = new Set<string>();
  const commitReadyCall = (readyCall: { toolCallId: string; args: unknown }) => {
    const admitted = admittedById.get(readyCall.toolCallId);
    if (!admitted || committedIds.has(readyCall.toolCallId)) {
      return;
    }
    recordToolCall(
      sessionState,
      admitted.toolName,
      readyCall.args,
      readyCall.toolCallId,
      ctx.loopDetection,
      loopScopeFor(ctx, admitted.toolName),
    );
    const churn = reconcileToolCallExecutionParams(sessionState, {
      toolName: admitted.toolName,
      toolParams: readyCall.args,
      toolCallId: readyCall.toolCallId,
      runId: ctx.runId,
      warningThreshold,
    });
    markDiagnosticArgumentChurnObservation({
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      active: churn.active,
    });
    committedIds.add(readyCall.toolCallId);
  };
  return {
    warnings,
    commitReadyCalls(readyCalls) {
      if (readyCalls.length === 1 && readyCalls[0]) {
        commitReadyCall(readyCalls[0]);
        return;
      }
      const readyById = new Map(readyCalls.map((call) => [call.toolCallId, call]));
      for (const call of calls) {
        const readyCall = readyById.get(call.toolCall.id);
        if (readyCall) {
          commitReadyCall(readyCall);
        }
      }
    },
    releaseSkippedCalls(toolCallIds) {
      // Agent-core only supplies admitted prepared calls suppressed at a steering checkpoint.
      releaseBatchAdmittedToolCalls(toolCallIds, ctx.runId);
    },
  };
}
