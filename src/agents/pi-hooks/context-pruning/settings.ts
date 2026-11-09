import { parseDurationMs } from "../../../cli/parse-duration.js";
import { toAgentRequestSessionKey } from "../../../routing/session-key.js";

export type ContextPruningToolMatch = {
  allow?: string[];
  deny?: string[];
};
/**
 * - `cache-ttl`: prune only once the provider's prompt cache has expired (Anthropic/Google style
 *   caches), so a warm cache is never invalidated by a prune.
 * - `always`: prune on every request, for any provider. Meant for long tool-heavy sessions
 *   (workflow runs) where the context would otherwise carry every fetched page to the end. Inside
 *   the turn still in progress it prunes in batches (see `batch`), never one result per request.
 */
export type ContextPruningMode = "off" | "cache-ttl" | "always";
/**
 * What happens to tool results from turns that closed with an assistant reply, once the next user
 * message arrives: `keep` leaves them to the ratio rules, `trim` soft-trims them on every request,
 * `clear` replaces them with the placeholder. The reply that closed each turn always stays, and a
 * turn that ended without one (stopped, failed, or ended on an approval card) keeps its results.
 */
export type ContextPruningCompletedTurns = "keep" | "trim" | "clear";

export type ContextPruningConfig = {
  mode?: ContextPruningMode;
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  /** Token budget the ratios are measured against (default: the model's context window). */
  windowTokens?: number;
  completedTurns?: ContextPruningCompletedTurns;
  /**
   * Session key prefixes the completed-turns rule applies to (for example `workflow_run:` or
   * `webchat:`), matched without the `agent:<id>:` qualifier a stored key carries. Empty means
   * every session. Other sessions keep only the ratio rules.
   */
  completedTurnsSessionKeys?: string[];
  /**
   * Path prefixes whose `read` results the completed-turns rule keeps: reference files such as
   * skills, which the agent reuses turn after turn and would otherwise read again.
   */
  completedTurnsKeepReads?: string[];
  /**
   * Tool names whose long string arguments the completed-turns rule clears (for example `write`,
   * whose `content` is the whole file). The call already ran and its file is on disk, yet the
   * argument would otherwise ride along in every later request. No effect while
   * `completedTurns` is `keep`, the default.
   */
  completedTurnsClearArgs?: string[];
  /**
   * `always` mode: how tool results inside the turn still in progress are pruned. A request whose
   * prompt would pass `triggerTokens` prunes every older result of the turn in one batch, and the
   * result is then sent unchanged until the next batch, so the prompt only grows at its end and a
   * provider's prompt cache keeps hitting. The newest `keepLastAssistants` rounds are never touched.
   */
  batch?: {
    /**
     * Prompt size in tokens that starts a batch (default: `softTrimRatio` of the window). Set it
     * just under the size where the model's price changes, when it has one.
     */
    triggerTokens?: number;
    /** A batch that would free fewer tokens than this is skipped (default 20000). */
    minFreedTokens?: number;
    /** What replaces a result once a later batch clears it (default: `hardClear.placeholder`). */
    placeholder?: string;
  };
  keepLastAssistants?: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
  minPrunableToolChars?: number;
  tools?: ContextPruningToolMatch;
  softTrim?: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  };
  hardClear?: {
    enabled?: boolean;
    placeholder?: string;
  };
};

export type EffectiveContextPruningSettings = {
  mode: Exclude<ContextPruningMode, "off">;
  ttlMs: number;
  windowTokens: number | null;
  completedTurns: ContextPruningCompletedTurns;
  completedTurnsSessionKeys: string[];
  completedTurnsKeepReads: string[];
  completedTurnsClearArgs: string[];
  batch: {
    triggerTokens: number | null;
    minFreedTokens: number;
    placeholder: string | null;
  };
  keepLastAssistants: number;
  softTrimRatio: number;
  hardClearRatio: number;
  minPrunableToolChars: number;
  tools: ContextPruningToolMatch;
  softTrim: {
    maxChars: number;
    headChars: number;
    tailChars: number;
  };
  hardClear: {
    enabled: boolean;
    placeholder: string;
  };
};

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: EffectiveContextPruningSettings = {
  mode: "cache-ttl",
  ttlMs: 5 * 60 * 1000,
  windowTokens: null,
  completedTurns: "keep",
  completedTurnsSessionKeys: [],
  completedTurnsKeepReads: [],
  completedTurnsClearArgs: [],
  batch: {
    triggerTokens: null,
    minFreedTokens: 20_000,
    placeholder: null,
  },
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 50_000,
  tools: {},
  softTrim: {
    maxChars: 4_000,
    headChars: 1_500,
    tailChars: 1_500,
  },
  hardClear: {
    enabled: true,
    placeholder: "[Old tool result content cleared]",
  },
};

export function isActiveContextPruningMode(
  mode: unknown,
): mode is Exclude<ContextPruningMode, "off"> {
  return mode === "cache-ttl" || mode === "always";
}

export function computeEffectiveSettings(raw: unknown): EffectiveContextPruningSettings | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const cfg = raw as ContextPruningConfig;
  if (!isActiveContextPruningMode(cfg.mode)) {
    return null;
  }

  const s: EffectiveContextPruningSettings = structuredClone(DEFAULT_CONTEXT_PRUNING_SETTINGS);
  s.mode = cfg.mode;

  if (typeof cfg.ttl === "string") {
    try {
      s.ttlMs = parseDurationMs(cfg.ttl, { defaultUnit: "m" });
    } catch {
      // keep default ttl
    }
  }

  if (
    typeof cfg.windowTokens === "number" &&
    Number.isFinite(cfg.windowTokens) &&
    cfg.windowTokens > 0
  ) {
    s.windowTokens = Math.floor(cfg.windowTokens);
  }
  if (
    cfg.completedTurns === "keep" ||
    cfg.completedTurns === "trim" ||
    cfg.completedTurns === "clear"
  ) {
    s.completedTurns = cfg.completedTurns;
  }
  if (Array.isArray(cfg.completedTurnsSessionKeys)) {
    s.completedTurnsSessionKeys = cfg.completedTurnsSessionKeys.filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    );
  }
  if (Array.isArray(cfg.completedTurnsKeepReads)) {
    s.completedTurnsKeepReads = cfg.completedTurnsKeepReads.filter(
      (prefix): prefix is string => typeof prefix === "string" && prefix.length > 0,
    );
  }
  if (Array.isArray(cfg.completedTurnsClearArgs)) {
    s.completedTurnsClearArgs = cfg.completedTurnsClearArgs.filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    );
  }
  if (cfg.batch) {
    const positiveTokens = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    s.batch.triggerTokens = positiveTokens(cfg.batch.triggerTokens);
    if (typeof cfg.batch.minFreedTokens === "number" && Number.isFinite(cfg.batch.minFreedTokens)) {
      s.batch.minFreedTokens = Math.max(0, Math.floor(cfg.batch.minFreedTokens));
    }
    if (typeof cfg.batch.placeholder === "string" && cfg.batch.placeholder.trim()) {
      s.batch.placeholder = cfg.batch.placeholder.trim();
    }
  }
  if (typeof cfg.keepLastAssistants === "number" && Number.isFinite(cfg.keepLastAssistants)) {
    s.keepLastAssistants = Math.max(0, Math.floor(cfg.keepLastAssistants));
  }
  if (typeof cfg.softTrimRatio === "number" && Number.isFinite(cfg.softTrimRatio)) {
    s.softTrimRatio = Math.min(1, Math.max(0, cfg.softTrimRatio));
  }
  if (typeof cfg.hardClearRatio === "number" && Number.isFinite(cfg.hardClearRatio)) {
    s.hardClearRatio = Math.min(1, Math.max(0, cfg.hardClearRatio));
  }
  if (typeof cfg.minPrunableToolChars === "number" && Number.isFinite(cfg.minPrunableToolChars)) {
    s.minPrunableToolChars = Math.max(0, Math.floor(cfg.minPrunableToolChars));
  }
  if (cfg.tools) {
    s.tools = cfg.tools;
  }
  if (cfg.softTrim) {
    if (typeof cfg.softTrim.maxChars === "number" && Number.isFinite(cfg.softTrim.maxChars)) {
      s.softTrim.maxChars = Math.max(0, Math.floor(cfg.softTrim.maxChars));
    }
    if (typeof cfg.softTrim.headChars === "number" && Number.isFinite(cfg.softTrim.headChars)) {
      s.softTrim.headChars = Math.max(0, Math.floor(cfg.softTrim.headChars));
    }
    if (typeof cfg.softTrim.tailChars === "number" && Number.isFinite(cfg.softTrim.tailChars)) {
      s.softTrim.tailChars = Math.max(0, Math.floor(cfg.softTrim.tailChars));
    }
  }
  if (cfg.hardClear) {
    if (typeof cfg.hardClear.enabled === "boolean") {
      s.hardClear.enabled = cfg.hardClear.enabled;
    }
    if (typeof cfg.hardClear.placeholder === "string" && cfg.hardClear.placeholder.trim()) {
      s.hardClear.placeholder = cfg.hardClear.placeholder.trim();
    }
  }

  return s;
}

/**
 * The settings for one session: the completed-turns rule only where its session keys say so. A
 * chat's key arrives agent-qualified (`agent:marketing:webchat:<id>`) while a workflow run's is
 * bare (`workflow_run:<id>`), so prefixes match the key with that qualifier removed.
 */
export function settingsForSession(
  settings: EffectiveContextPruningSettings,
  sessionKey: string | undefined,
): EffectiveContextPruningSettings {
  if (settings.completedTurns === "keep" || settings.completedTurnsSessionKeys.length === 0) {
    return settings;
  }
  const requestKey = toAgentRequestSessionKey(sessionKey);
  const applies =
    requestKey !== undefined &&
    settings.completedTurnsSessionKeys.some((prefix) => requestKey.startsWith(prefix));
  return applies ? settings : { ...settings, completedTurns: "keep" };
}
