// Magister fork: bridge OpenClaw `subagent_ended` lifecycle events to the
// Magister gateway, which inserts a `chat_messages` row so webchat users see
// sub-agent results without re-prompting. Mirrors `cron.completionWebhook`
// (see `src/gateway/server-cron.ts:415-432`).
//
// We send the OPAQUE OpenClaw session key (the parent/requester session key
// from the hook ctx). The gateway resolves it to `chat_sessions.id` via the
// `openclaw_session_key` column, avoiding any brittle UUID-extraction regex.

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueAndDeliverDurableWebhook } from "../infra/outbound/durable-webhook-outbox.js";
import type { GlobalHookRunnerRegistry } from "../plugins/hook-registry.types.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../plugins/types.js";
import { captureSubagentCompletionReply } from "./subagents/announce/subagent-announce-output.js";

// Upstream 2026.9.x no longer exports the subagent hook payload types; derive
// them from the handler map so this stays in step with the hook contract.
type PluginHookSubagentEndedEvent = Parameters<
  NonNullable<PluginHookHandlerMap["subagent_ended"]>
>[0];
type PluginHookSubagentContext = Parameters<NonNullable<PluginHookHandlerMap["subagent_ended"]>>[1];

function trimToOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type SubagentCompletionWebhookOutcome = "ok" | "error" | "timeout";

export type SubagentCompletionWebhookPayload = {
  /** Opaque OpenClaw session key for the PARENT chat session (requesterSessionKey). */
  openclaw_session_key: string;
  /** OpenClaw subagent runId — used as the gateway-side idempotency key. */
  run_id: string;
  /** Opaque session key of the sub-agent itself (targetSessionKey). */
  child_session_key: string;
  outcome: SubagentCompletionWebhookOutcome;
  summary: string;
  runtime_ms: number;
  error?: string;
  input_tokens?: number;
  output_tokens?: number;
};

export function normalizeSubagentCompletionWebhookOutcome(
  rawOutcome: PluginHookSubagentEndedEvent["outcome"],
): SubagentCompletionWebhookOutcome {
  if (rawOutcome === "timeout") {
    return "timeout";
  }
  if (
    rawOutcome === "error" ||
    rawOutcome === "killed" ||
    rawOutcome === "reset" ||
    rawOutcome === "deleted"
  ) {
    return "error";
  }
  return "ok";
}

function resolveSubagentCompletionWebhookError(
  rawOutcome: PluginHookSubagentEndedEvent["outcome"],
  rawError: string | undefined,
): string | undefined {
  const error = trimToOptionalString(rawError);
  if (error) {
    return error;
  }
  if (rawOutcome === "killed") {
    return "Subagent was killed.";
  }
  if (rawOutcome === "reset") {
    return "Subagent session was reset.";
  }
  if (rawOutcome === "deleted") {
    return "Subagent session was deleted.";
  }
  return undefined;
}

/**
 * Persist then POST a sub-agent completion payload. A failed send remains in
 * the local outbox and is retried after restart with the current token.
 */
export async function sendSubagentCompletionWebhook(params: {
  url: string;
  token: string;
  payload: SubagentCompletionWebhookPayload;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  stateDir?: string;
}): Promise<void> {
  if (!params.url || !params.token) {
    return;
  }
  try {
    // SPIKE / REDESIGN: the fork also recorded a completion "intent" on the task
    // record so a restart could reconcile an undelivered webhook from the task
    // registry. Upstream 2026.9.x replaced the monolithic task registry with
    // task-registry-delivery.ts (maybeDeliverTaskTerminalUpdate); that seam is
    // re-expressed there, not here. The disk-backed outbox below still
    // survives restarts on its own.
    const delivered = await enqueueAndDeliverDurableWebhook({
      eventId: `subagent:${params.payload.run_id}`,
      eventType: "subagent_completion",
      url: params.url,
      token: params.token,
      payload: { ...params.payload },
      fetchImpl: params.fetchImpl,
      timeoutMs: params.timeoutMs ?? 5_000,
      stateDir: params.stateDir,
    });
    if (!delivered) {
      console.warn(
        `[subagent-completion-webhook] delivery queued for retry run=${params.payload.run_id}`,
      );
    }
  } catch (err) {
    console.warn("[subagent-completion-webhook] durable enqueue failed:", err);
  }
}

/**
 * Built-in `subagent_ended` hook that POSTs a completion webhook on every
 * sub-agent termination. Idempotent at registration: returns early if config
 * is missing or the hook is already registered.
 *
 * The hook receives `event: PluginHookSubagentEndedEvent` and
 * `ctx: PluginHookSubagentContext`. The PARENT session key lives on
 * `ctx.requesterSessionKey` (verified in `subagent-registry-completion.ts:84`,
 * which constructs the ctx). The CHILD/target session key is on
 * `event.targetSessionKey`. Token usage / startedAt are not exposed by the
 * registry's public reader API, so we omit them — runtime_ms defaults to 0.
 */
export function registerSubagentCompletionWebhookHook(
  cfg: OpenClawConfig,
  registryOverride?: GlobalHookRunnerRegistry,
): void {
  const url = trimToOptionalString(cfg.subagent?.completionWebhook);
  // webhookToken is SecretInput (string | SecretRef). Only inline string tokens
  // are supported here, matching how `cron.webhookToken` is consumed in
  // `server-cron.ts`. SecretRef values are unsupported (would need runtime
  // resolution); the webhook simply stays unconfigured in that case.
  const token = trimToOptionalString(cfg.subagent?.webhookToken);
  if (!url || !token) {
    return;
  }
  // Gateway startup can defer plugin loading until after the HTTP listener is
  // attached. In that path the global registry does not exist when core
  // startup first runs, so accept the freshly loaded registry explicitly.
  const registry = registryOverride ?? getGlobalPluginRegistry();
  if (!registry) {
    return;
  }
  // Guard against duplicate registrations on hot-reload / test rebuilds.
  if (
    registry.typedHooks.some(
      (h) => h.hookName === "subagent_ended" && h.pluginId === SUBAGENT_WEBHOOK_PLUGIN_ID,
    )
  ) {
    return;
  }

  const handler: PluginHookHandlerMap["subagent_ended"] = async (event, ctx) => {
    try {
      await deliverSubagentCompletionWebhook({ event, ctx, url, token });
    } catch (err) {
      console.warn("[subagent-completion-webhook] hook handler error:", err);
    }
  };

  registry.typedHooks.push({
    pluginId: SUBAGENT_WEBHOOK_PLUGIN_ID,
    hookName: "subagent_ended",
    handler,
    priority: 0,
    source: "magister-fork",
  } as (typeof registry.typedHooks)[number]);
}

const SUBAGENT_WEBHOOK_PLUGIN_ID = "magister-subagent-completion-webhook";

/**
 * A child the requester killed itself (`subagents kill`) is a deliberate
 * control action, not a task outcome: the requester already knows, and the
 * gateway would otherwise render it as a "Background task failed" card in the
 * user's chat — which the model then re-reads as a failure next turn.
 */
export function shouldSkipSubagentCompletionWebhook(
  // SPIKE / REDESIGN: `killedByRequester` was a fork-added stamp on the
  // subagent_ended event (set by the fork's subagent registry). Upstream
  // 2026.9.x's event has no such field; until the registry seam is re-expressed
  // the flag simply reads as absent, so a requester kill counts as "killed".
  event: Pick<PluginHookSubagentEndedEvent, "outcome"> & { killedByRequester?: boolean },
): boolean {
  return event.outcome === "killed" && event.killedByRequester === true;
}

async function deliverSubagentCompletionWebhook(params: {
  event: PluginHookSubagentEndedEvent;
  ctx: PluginHookSubagentContext;
  url: string;
  token: string;
}): Promise<void> {
  if (shouldSkipSubagentCompletionWebhook(params.event)) {
    return;
  }
  // The PARENT session is the user's chat session — what we map to chat_sessions.id.
  const openclawSessionKey = params.ctx.requesterSessionKey?.trim();
  if (!openclawSessionKey) {
    return;
  }
  const childSessionKey = params.event.targetSessionKey;
  const runId = params.event.runId?.trim();
  if (!runId) {
    return;
  }

  const summaryRaw = await captureSubagentCompletionReply(childSessionKey).catch(() => undefined);
  const summary = (summaryRaw ?? "(no output)").trim();

  const rawOutcome = params.event.outcome;
  const outcome = normalizeSubagentCompletionWebhookOutcome(rawOutcome);

  await sendSubagentCompletionWebhook({
    url: params.url,
    token: params.token,
    payload: {
      openclaw_session_key: openclawSessionKey,
      run_id: runId,
      child_session_key: childSessionKey,
      outcome,
      summary,
      // Token usage and startedAt are not exposed via a public reader on the
      // subagent registry today. The gateway treats these as nice-to-haves;
      // omit cleanly rather than fabricate.
      runtime_ms: 0,
      error: resolveSubagentCompletionWebhookError(rawOutcome, params.event.error),
    },
  });
}
