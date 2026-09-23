// Magister fork: bridge `agent_end` lifecycle events for Slack-triggered runs
// to the Magister gateway. The gateway's Slack forwarder holds the project's
// agent_turns slot after delivering an event; this webhook is what releases
// it, giving Slack the same end-to-end one-turn-per-project serialization as
// web chat. Mirrors `subagent-completion-webhook.ts` and
// `cron.completionWebhook` (src/gateway/server-cron.ts).

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueAndDeliverDurableWebhook } from "../infra/outbound/durable-webhook-outbox.js";
import type { GlobalHookRunnerRegistry } from "../plugins/hook-registry.types.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../plugins/types.js";

const SLACK_COMPLETION_WEBHOOK_PLUGIN_ID = "magister-slack-completion-webhook";

/** Machine-side Slack session keys look like `agent:<agentId>:slack:...`. */
export function isSlackSessionKey(sessionKey: string | undefined): boolean {
  if (!sessionKey) {
    return false;
  }
  return /^agent:[^:]+:slack:/.test(sessionKey);
}

export type SlackCompletionWebhookPayload = {
  /** Machine-side OpenClaw session key of the Slack run. */
  openclaw_session_key: string;
  /** OpenClaw run id — idempotency/debug key on the gateway side. */
  run_id: string;
  success: boolean;
  error?: string;
  duration_ms?: number;
};

/**
 * Persist then POST a Slack-run completion payload. Transport is at-least-once;
 * the gateway deduplicates the stable run event before applying its effect.
 */
export async function sendSlackCompletionWebhook(params: {
  url: string;
  token: string;
  payload: SlackCompletionWebhookPayload;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  stateDir?: string;
}): Promise<void> {
  if (!params.url || !params.token) {
    return;
  }
  try {
    const delivered = await enqueueAndDeliverDurableWebhook({
      eventId: `slack:${params.payload.run_id}`,
      eventType: "slack_completion",
      url: params.url,
      token: params.token,
      payload: { ...params.payload },
      fetchImpl: params.fetchImpl,
      timeoutMs: params.timeoutMs ?? 5_000,
      stateDir: params.stateDir,
    });
    if (!delivered) {
      console.warn(
        `[slack-completion-webhook] delivery queued for retry run=${params.payload.run_id}`,
      );
    }
  } catch (err) {
    console.warn("[slack-completion-webhook] durable enqueue failed:", err);
  }
}

/**
 * Built-in `agent_end` hook that POSTs a completion webhook whenever a
 * Slack-session run finishes (success or error). Idempotent at registration.
 * `webhookToken` supports inline string tokens only, matching how
 * `subagent.webhookToken` is consumed.
 */
export function registerSlackCompletionWebhookHook(
  cfg: OpenClawConfig,
  registryOverride?: GlobalHookRunnerRegistry,
): void {
  const url = cfg.slackCompletion?.completionWebhook?.trim();
  const rawToken = cfg.slackCompletion?.webhookToken;
  const token = typeof rawToken === "string" ? rawToken.trim() : undefined;
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
  if (
    registry.typedHooks.some(
      (h) => h.hookName === "agent_end" && h.pluginId === SLACK_COMPLETION_WEBHOOK_PLUGIN_ID,
    )
  ) {
    return;
  }

  const handler: PluginHookHandlerMap["agent_end"] = async (event, ctx) => {
    try {
      if (!isSlackSessionKey(ctx.sessionKey)) {
        return;
      }
      await sendSlackCompletionWebhook({
        url,
        token,
        payload: {
          openclaw_session_key: ctx.sessionKey ?? "",
          run_id: event.runId ?? ctx.runId ?? "",
          success: event.success,
          ...(event.error ? { error: event.error } : {}),
          ...(typeof event.durationMs === "number" ? { duration_ms: event.durationMs } : {}),
        },
      });
    } catch (err) {
      console.warn("[slack-completion-webhook] hook handler error:", err);
    }
  };

  registry.typedHooks.push({
    pluginId: SLACK_COMPLETION_WEBHOOK_PLUGIN_ID,
    hookName: "agent_end",
    handler,
    priority: 0,
    source: "magister-fork",
  } as (typeof registry.typedHooks)[number]);
}
