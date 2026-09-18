import { extractPrefixedHttpStatus } from "../../shared/assistant-error-format.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { sanitizeForLog } from "../../terminal/ansi.js";

const MAX_COMPACTION_REASON_DETAIL_CHARS = 100;

function isGenericCompactionCancelledReason(reason: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(reason);
  return normalized === "compaction cancelled" || normalized === "error: compaction cancelled";
}

export function resolveCompactionFailureReason(params: {
  reason: string;
  safeguardCancelReason?: string | null;
}): string {
  if (isGenericCompactionCancelledReason(params.reason) && params.safeguardCancelReason) {
    return params.safeguardCancelReason;
  }
  return params.reason;
}

export function classifyCompactionReason(reason?: string): string {
  const text = normalizeLowercaseStringOrEmpty(reason);
  if (!text) {
    return "unknown";
  }
  if (text.includes("nothing to compact")) {
    return "no_compactable_entries";
  }
  if (text.includes("below threshold")) {
    return "below_threshold";
  }
  if (text.includes("already compacted")) {
    return "already_compacted_recently";
  }
  if (text.includes("still exceeds target")) {
    return "live_context_still_exceeds_target";
  }
  if (text.includes("guard")) {
    return "guard_blocked";
  }
  if (text.includes("summary")) {
    return "summary_failed";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return "timeout";
  }
  // A status is only a status when it leads the message (after an optional
  // "error:"/"http" prefix). A byte count, request id, or timestamp that
  // happens to contain "502" is not a provider failure.
  const status = extractPrefixedHttpStatus(text);
  if (status !== undefined && status >= 400 && status < 500) {
    return "provider_error_4xx";
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return "provider_error_5xx";
  }
  return "unknown";
}

export function formatUnknownCompactionReasonDetail(reason?: string): string | undefined {
  const sanitized = sanitizeForLog((reason ?? "").replace(/\s+/g, " "))
    .trim()
    .replace(/[^A-Za-z0-9._:@/+~-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!sanitized) {
    return undefined;
  }
  return sanitized.slice(0, MAX_COMPACTION_REASON_DETAIL_CHARS);
}
