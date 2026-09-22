// Keep server maxPayload aligned with gateway client maxPayload so high-res canvas snapshots
// don't get disconnected mid-invoke with "Max payload size exceeded".
export const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 50 * 1024 * 1024; // per-connection send buffer limit (2x max payload)
export const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024;

const DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES = 6 * 1024 * 1024; // keep history responses comfortably under client WS limits
let maxChatHistoryMessagesBytes = DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES;

export const getMaxChatHistoryMessagesBytes = () => maxChatHistoryMessagesBytes;

export const __setMaxChatHistoryMessagesBytesForTest = (value?: number) => {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    return;
  }
  if (value === undefined) {
    maxChatHistoryMessagesBytes = DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES;
    return;
  }
  if (Number.isFinite(value) && value > 0) {
    maxChatHistoryMessagesBytes = value;
  }
};
export const TICK_INTERVAL_MS = 30_000;
export const DEFAULT_HEALTH_REFRESH_INTERVAL_MS = 60_000;
// Floor for the override below: probing channel APIs more often than this is
// never useful and only spends provider rate limits.
export const MIN_HEALTH_REFRESH_INTERVAL_MS = 10_000;

/**
 * How often the maintenance loop refreshes the gateway health snapshot with
 * channel probes on (`refreshGatewayHealthSnapshot({ probe: true })`).
 *
 * Every refresh calls each configured channel's probe — for Slack that is an
 * `auth.test` round trip. On a managed fleet those calls go through a shared
 * proxy, so the default minute-by-minute cadence multiplies across every
 * machine. `OPENCLAW_HEALTH_REFRESH_INTERVAL_MS` lets an operator stretch it;
 * anything unparseable or below the floor keeps the default.
 */
export function resolveHealthRefreshIntervalMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return DEFAULT_HEALTH_REFRESH_INTERVAL_MS;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < MIN_HEALTH_REFRESH_INTERVAL_MS) {
    return DEFAULT_HEALTH_REFRESH_INTERVAL_MS;
  }
  return Math.floor(parsed);
}

export const HEALTH_REFRESH_INTERVAL_MS = resolveHealthRefreshIntervalMs(
  process.env.OPENCLAW_HEALTH_REFRESH_INTERVAL_MS,
);
export const DEDUPE_TTL_MS = 5 * 60_000;
export const DEDUPE_MAX = 1000;
