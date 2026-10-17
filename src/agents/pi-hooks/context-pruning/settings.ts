import { parseDurationMs } from "../../../cli/parse-duration.js";

export type ContextPruningToolMatch = {
  allow?: string[];
  deny?: string[];
};
/**
 * - `cache-ttl`: prune only once the provider's prompt cache has expired (Anthropic/Google style
 *   caches), so a warm cache is never invalidated by a prune.
 * - `always`: prune on every request, for any provider. Meant for long tool-heavy sessions
 *   (workflow runs) where the context would otherwise carry every fetched page to the end.
 */
export type ContextPruningMode = "off" | "cache-ttl" | "always";
/**
 * What happens to tool results from turns before the latest user message: `keep` leaves them to
 * the ratio rules, `trim` soft-trims them on every request, `clear` replaces them with the
 * placeholder. The assistant reply that closed each turn always stays.
 */
export type ContextPruningCompletedTurns = "keep" | "trim" | "clear";

export type ContextPruningConfig = {
  mode?: ContextPruningMode;
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  /** Token budget the ratios are measured against (default: the model's context window). */
  windowTokens?: number;
  completedTurns?: ContextPruningCompletedTurns;
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
