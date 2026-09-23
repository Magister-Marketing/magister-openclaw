import type { SecretInput } from "./types.secrets.js";

/**
 * Magister fork: Slack agent-run completion webhook.
 *
 * When set, every `agent_end` event whose session key belongs to the Slack
 * channel (`agent:<agentId>:slack:...`) POSTs to this URL so the Magister
 * gateway can hold the project's turn-queue slot until the run actually
 * finishes (end-to-end Slack serialization). Mirrors
 * `subagent.completionWebhook` (types.subagent.ts) and
 * `cron.completionWebhook` (types.cron.ts).
 */
export type SlackCompletionConfig = {
  /** URL the gateway POSTs to on every Slack-run agent_end event. */
  completionWebhook?: string;
  /** Bearer token sent in Authorization header. */
  webhookToken?: SecretInput;
};
