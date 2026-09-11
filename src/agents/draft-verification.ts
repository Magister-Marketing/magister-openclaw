/** Narrow, request-grounded checks. Unknown is never a successful check. */
export const MAX_DRAFT_REQUEST_CHARS = 16_000;
export const MAX_DRAFT_CHARS = 32_000;

export type DraftCheckKind = "json_only" | "bullet_count" | "allocation_count" | "allocation_total";
export type DraftCheck = { kind: DraftCheckKind; status: "pass" | "fail" | "unknown" };
export type DraftContract = {
  jsonOnly?: true;
  bulletCount?: number;
  allocation?: { count: number; cents: number; currency: string };
};
export type DraftVerificationReceipt = {
  version: 1;
  mode: "off" | "shadow" | "repair";
  outcome: "unchecked" | "passed" | "failed" | "repaired" | "repair_failed" | "excluded";
  checks: DraftCheck[];
  repair_attempts: 0 | 1;
  stop_reason: DraftStopReason | null;
  ceiling_retried: null;
  skill_reads: null;
};

export const DRAFT_STOP_REASONS = [
  "stop",
  "end_turn",
  "length",
  "max_tokens",
  "toolUse",
  "tool_calls",
  "error",
  "aborted",
  "retry_limit",
] as const;
export type DraftStopReason = (typeof DRAFT_STOP_REASONS)[number];
export function draftStopReason(value: unknown): DraftStopReason | null {
  return DRAFT_STOP_REASONS.find((reason) => reason === value) ?? null;
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
const COUNT = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";
const MONEY = /(?<![-\w])([$€£])\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\w.,])/g;

function countValue(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : NUMBER_WORDS.indexOf(value.toLowerCase());
}

function explicitCount(text: string, noun: string): number | undefined {
  const matches = [...text.matchAll(new RegExp(`\\bexactly\\s+${COUNT}\\s+(?:${noun})\\b`, "gi"))];
  if (matches.length !== 1) {
    return undefined;
  }
  const count = countValue(matches[0][1]);
  return count >= 1 && count <= 20 ? count : undefined;
}

/** Do not reinterpret examples, quotes, fenced code, or delimited source material as policy. */
export function deriveDraftContract(request: string): DraftContract {
  if (!request || request.length > MAX_DRAFT_REQUEST_CHARS) {
    return {};
  }
  const instructions = request
    .split(/\n\s*(?:---+|<[^>]+>|(?:#{1,6}\s+)?(?:source|reference|attachment)(?:\s*:\s*|\b))/i)[0]
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
    .replace(/^\s*>.*$/gm, "")
    .replace(/"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'(?!\w)|‘[^’\n]*’|`[^`\n]*`/g, "");
  const contract: DraftContract = {};
  if (/\b(?:if|unless|except|alternatively)\b/i.test(instructions)) {
    return {};
  }
  // Negative, conditional, and example instructions are not an unconditional contract.
  if (
    /\b(?:not|don't|never|avoid|unless|if|example)\b[^\n.!?;]{0,80}\b(?:return|respond|output|exactly)\b/i.test(
      instructions,
    )
  ) {
    return {};
  }
  if (
    /\b(?:return|respond|output)\s+(?:with\s+)?only\s+(?:valid\s+)?json\b|\b(?:return|respond|output)\s+(?:with\s+)?(?:valid\s+)?json\s+only\b/i.test(
      instructions,
    )
  ) {
    contract.jsonOnly = true;
  }
  const bulletCount = explicitCount(instructions, "bullet(?:\\s+points?|\\s+items?)?s?");
  if (bulletCount !== undefined) {
    contract.bulletCount = bulletCount;
  }
  const categoryCount = explicitCount(instructions, "channels|categories|allocations");
  const amounts = [...instructions.matchAll(MONEY)];
  const flexible =
    /\b(?:up to|at most|maximum|capped|limit|approximately|about|around|contingency|reserve|buffer|optional)\b/i.test(
      instructions,
    );
  if (
    categoryCount !== undefined &&
    amounts.length === 1 &&
    /\bbudget\b/i.test(instructions) &&
    !flexible
  ) {
    const amount = amounts[0];
    if (
      /^\s*(?:k|m|million|thousand|billion)\b/i.test(
        instructions.slice((amount.index ?? 0) + amount[0].length),
      )
    ) {
      return contract;
    }
    const cents =
      Number(amount[2].replaceAll(",", "")) * 100 + Number((amount[3] ?? "").padEnd(2, "0"));
    if (Number.isSafeInteger(cents) && cents > 0 && cents <= 100_000_000_00) {
      contract.allocation = { count: categoryCount, cents, currency: amount[1] };
    }
  }
  // Mixed exclusive formats are ambiguous; do not manufacture a satisfiable contract.
  return contract.jsonOnly && (contract.bulletCount !== undefined || contract.allocation)
    ? {}
    : contract;
}

export function hasDraftChecks(contract: DraftContract): boolean {
  return (
    contract.jsonOnly === true ||
    contract.bulletCount !== undefined ||
    contract.allocation !== undefined
  );
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.replace(/\*\*|__/g, "").trim());
}

function amountCents(text: string, currency: string): number | undefined {
  const value = text.trim();
  if (/[$€£]/.test(value) && !value.startsWith(currency)) {
    return undefined;
  }
  const numeric = value.startsWith(currency) ? value.slice(1).trim() : value;
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(numeric)) {
    return undefined;
  }
  const [whole, fractional = ""] = numeric.replaceAll(",", "").split(".");
  const result = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : undefined;
}

function allocationRows(draft: string, currency: string): number[] | undefined {
  const lines = draft.split(/\r?\n/);
  const candidates: number[][] = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i].includes("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      continue;
    }
    const header = cells(lines[i]);
    const amountColumns = header.flatMap((cell, index) =>
      /^(?:budget|amount|allocation|spend)(?:\s*\([^)]*\))?$/i.test(cell) ? [index] : [],
    );
    const labelColumns = header.flatMap((cell, index) =>
      /^(?:channel|category|item)$/i.test(cell) ? [index] : [],
    );
    if (amountColumns.length !== 1 || labelColumns.length !== 1) {
      continue;
    }
    const headerUnit = header[amountColumns[0]].match(/\(([^)]*)\)/)?.[1].trim();
    if (headerUnit && headerUnit !== currency) {
      return undefined;
    }
    const amounts: number[] = [];
    const labels = new Set<string>();
    let valid = true;
    i += 2;
    for (; i < lines.length && lines[i].includes("|"); i += 1) {
      const row = cells(lines[i]);
      const label = row[labelColumns[0]]?.toLowerCase();
      if (row.length !== header.length || !label || labels.has(label)) {
        valid = false;
        continue;
      }
      if (/^(?:grand\s+)?total(?:\s+(?:budget|allocation|allocated|spend))?$/.test(label)) {
        continue;
      }
      labels.add(label);
      const amount = amountCents(row[amountColumns[0]], currency);
      if (amount === undefined || amounts.length >= 100) {
        valid = false;
      } else {
        amounts.push(amount);
      }
    }
    i -= 1;
    if (!valid || amounts.length === 0) {
      return undefined;
    }
    candidates.push(amounts);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function checkDraft(contract: DraftContract, draft: string): DraftCheck[] {
  const checks: DraftCheck[] = [];
  const bounded = draft.length > 0 && draft.length <= MAX_DRAFT_CHARS;
  if (contract.jsonOnly) {
    let status: DraftCheck["status"] = "unknown";
    if (bounded) {
      try {
        JSON.parse(draft);
        status = "pass";
      } catch {
        status = "fail";
      }
    }
    checks.push({ kind: "json_only", status });
  }
  if (contract.bulletCount !== undefined) {
    const count = [...draft.matchAll(/^(?:[-*+]\s+|\d+[.)]\s+)\S/gm)].length;
    checks.push({
      kind: "bullet_count",
      status:
        !bounded || /```|~~~/.test(draft)
          ? "unknown"
          : count === contract.bulletCount
            ? "pass"
            : "fail",
    });
  }
  if (contract.allocation) {
    const rows =
      bounded && !/```|~~~/.test(draft)
        ? allocationRows(draft, contract.allocation.currency)
        : undefined;
    checks.push({
      kind: "allocation_count",
      status: !rows ? "unknown" : rows.length === contract.allocation.count ? "pass" : "fail",
    });
    checks.push({
      kind: "allocation_total",
      status: !rows
        ? "unknown"
        : rows.reduce((sum, amount) => sum + amount, 0) === contract.allocation.cents
          ? "pass"
          : "fail",
    });
  }
  return checks;
}

export function draftRepairInstruction(contract: DraftContract): string {
  const constraints: string[] = [];
  if (contract.jsonOnly) {
    constraints.push("Return only valid JSON, without markdown fences or surrounding prose.");
  }
  if (contract.bulletCount !== undefined) {
    constraints.push(`Use exactly ${contract.bulletCount} top-level bullet items.`);
  }
  if (contract.allocation) {
    constraints.push(
      `The allocation table must contain exactly ${contract.allocation.count} categories totaling ${contract.allocation.currency}${(contract.allocation.cents / 100).toFixed(2)}; do not count the total row as a category.`,
    );
  }
  return [
    "Revise only your preceding draft to satisfy these explicit requirements from the current user's request:",
    ...constraints.map((constraint) => `- ${constraint}`),
    "Preserve supported facts and the rest of the request. Do not invent evidence, execute actions, or claim any file or external resource changed. Tools are unavailable. Return the complete corrected answer, not a description of the correction.",
  ].join("\n");
}
