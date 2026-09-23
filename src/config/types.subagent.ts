import type { SecretInput } from "./types.secrets.js";

/**
 * Magister fork: subagent completion webhook for headless deployments where
 * there is no deliverable channel (e.g. webchat-only Magister machines).
 *
 * When set, every `subagent_ended` event POSTs to this URL using
 * `webhookToken` for auth. Mirrors `cron.completionWebhook` (see
 * `src/gateway/server-cron.ts:415-432` and `types.cron.ts:48`).
 */
export type SubagentConfig = {
  /** URL the gateway POSTs to on every subagent_ended event. */
  completionWebhook?: string;
  /** Bearer token sent in Authorization header. */
  webhookToken?: SecretInput;
};
