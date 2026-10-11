/** Narrow, request-grounded checks. Unknown is never a successful check. */
export const MAX_DRAFT_REQUEST_CHARS = 16_000;
export const MAX_DRAFT_CHARS = 32_000;

export type DraftCheckKind =
  | "json_only"
  | "bullet_count"
  | "allocation_count"
  | "allocation_total"
  | "figures_grounded";
export type DraftCheck = { kind: DraftCheckKind; status: "pass" | "fail" | "unknown" };
export type DraftContract = {
  jsonOnly?: true;
  bulletCount?: number;
  allocation?: { count: number; cents: number; currency: string };
  /** Every reported figure in the draft must appear in a tool output or in the request. */
  figuresGrounded?: true;
};
/** Prefix of the note the paste materializer puts on a turn that carries a data file. */
export const PASTE_NOTE_MARKER = "[pasted data saved:";
/** Evidence (tool outputs and the request) kept for the figures check, newest first. */
export const MAX_EVIDENCE_CHARS = 2_000_000;
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

/**
 * A pasted-data turn carries the request-side checks like any other, plus the
 * figures check: the deliverable computes from a file, so every figure it
 * states has an exec output or the request itself to be quoted from. The
 * marker is read on the raw request, which is usually far over
 * MAX_DRAFT_REQUEST_CHARS because the pasted data is inline.
 */
export function deriveDraftContract(request: string): DraftContract {
  const contract = deriveRequestContract(request);
  return request.includes(PASTE_NOTE_MARKER) ? { ...contract, figuresGrounded: true } : contract;
}

/** Do not reinterpret examples, quotes, fenced code, or delimited source material as policy. */
function deriveRequestContract(request: string): DraftContract {
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
    contract.allocation !== undefined ||
    contract.figuresGrounded === true
  );
}

// ---------------------------------------------------------------- figures

// A number as a report states it: optional currency, thousands groups, a
// fraction, a percent or multiplier suffix. Not part of a word or identifier
// (W11, r2, v3). A grouped number is consumed whole from its first digit, so
// no match starts inside one; a CSV delimiter before a number is fine, which
// is how most tool output arrives, and so is a sentence-ending period.
const FIGURE_RE = /(?<![\w.])([$€£])?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%|x)?(?!\w|\.\d)/g;

type Figure = {
  text: string;
  value: number;
  decimals: number;
  currency: boolean;
  percent: boolean;
};

function parseFigure(match: RegExpMatchArray): Figure | undefined {
  const [text, currency, whole, fraction = "", suffix] = match;
  const value = Number(whole.replaceAll(",", "") + fraction);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return {
    text,
    value,
    decimals: fraction ? fraction.length - 1 : 0,
    currency: Boolean(currency),
    percent: suffix === "%",
  };
}

/** Digits that carry information: no leading zeros, no trailing zeros. */
function significantDigits(figure: Figure): number {
  const digits = figure.value.toFixed(figure.decimals).replace(".", "").replace(/^0+/, "");
  return digits.replace(/0+$/, "").length;
}

/**
 * Figures a report states as measured, as opposed to the round numbers it
 * proposes (a $1,400 cap, a 50% cut, a 14-day test) and the small counts it
 * narrates: three or more significant digits, and for whole numbers not a
 * multiple of 50. A bare whole number also has to reach 100, and a bare
 * four-digit number in the calendar range is a year.
 */
function isReportedFigure(figure: Figure): boolean {
  const unitless = !figure.currency && !figure.percent;
  if (unitless && figure.decimals === 0 && figure.value >= 1900 && figure.value <= 2100) {
    return false;
  }
  if (significantDigits(figure) < 3) {
    return false;
  }
  if (figure.decimals > 0) {
    return true;
  }
  return figure.value % 50 !== 0 && (!unitless || figure.value >= 100);
}

/** Prose only: code, dates, clock times, list markers and footnotes are not figures. */
function reportProse(draft: string): string {
  return draft
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?\b/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/^\s*(?:#{1,6}\s+)?\d+[.)]\s/gm, " ")
    .replace(/\[\d+\]/g, " ");
}

function figuresIn(text: string): Figure[] {
  const figures: Figure[] = [];
  for (const match of text.matchAll(FIGURE_RE)) {
    const figure = parseFigure(match);
    if (figure) {
      figures.push(figure);
    }
  }
  return figures;
}

/**
 * Every value the evidence states, at the precisions a report may round it
 * to; a ratio also counts as the percentage it expresses.
 */
function evidenceValues(evidence: readonly string[]): Set<string> {
  const values = new Set<string>();
  const add = (value: number) => {
    for (let decimals = 0; decimals <= 4; decimals += 1) {
      values.add(value.toFixed(decimals));
    }
  };
  for (const text of evidence) {
    for (const figure of figuresIn(text)) {
      add(figure.value);
      if (figure.decimals > 0 && figure.value > 0 && figure.value < 1) {
        add(figure.value * 100);
      }
      // "116,310" in a CSV row is two cells as often as one number.
      if (figure.text.includes(",")) {
        for (const cell of figure.text.replace(/^[$€£]/, "").split(",")) {
          add(Number(cell.replace(/[%x]$/, "")));
        }
      }
    }
  }
  return values;
}

const NUMBER = "[$€£]?\\d[\\d,]*(?:\\.\\d+)?%?";
const OPERATOR = "[+\\-−–×*÷/]";
// "$400 + $300 + $630 = $1,330", "630 ÷ 600 = 1.05", "31 / 116 = 26.7%".
const ARITHMETIC_RE = new RegExp(
  `(${NUMBER}(?:\\s*${OPERATOR}\\s*${NUMBER})+)\\s*(?:=|≈|→)\\s*(?:about\\s+|approximately\\s+|roughly\\s+|~\\s*)?(${NUMBER})`,
  "g",
);

function numberValue(text: string): number {
  return Number(text.replace(/[$€£%,]/g, ""));
}

function decimalsOf(text: string): number {
  const fraction = text.match(/\.(\d+)/);
  return fraction ? fraction[1].length : 0;
}

/** Standard precedence over a flat "a op b op c" expression. */
function evaluate(operands: number[], operators: string[]): number {
  const values = [operands[0]];
  const pending: string[] = [];
  for (let i = 0; i < operators.length; i += 1) {
    const operator = operators[i];
    const right = operands[i + 1];
    if (/[×*÷/]/.test(operator)) {
      const left = values.pop() ?? Number.NaN;
      values.push(/[×*]/.test(operator) ? left * right : left / right);
    } else {
      values.push(right);
      pending.push(operator);
    }
  }
  let total = values[0];
  for (let i = 0; i < pending.length; i += 1) {
    total = pending[i] === "+" ? total + values[i + 1] : total - values[i + 1];
  }
  return total;
}

function statesValue(known: Set<string>, value: number, decimals: number): boolean {
  return known.has(value.toFixed(Math.min(decimals, 4)));
}

/**
 * Arithmetic a report shows inline grounds its result when every operand is
 * grounded and the result is right at the stated precision (a percentage
 * result may be the ratio times 100). Tasks ask for exactly this ("show the
 * arithmetic needed to audit every total"), and a correction that may only
 * quote or remove figures drops the subtotals and ratios a brief requires
 * (2026-10-03: "the last-touch paid subtotal is never summed to $1,330").
 */
function groundShownArithmetic(prose: string, known: Set<string>): void {
  for (const match of prose.matchAll(ARITHMETIC_RE)) {
    const [, expression, result] = match;
    const operandTexts = expression.match(new RegExp(NUMBER, "g")) ?? [];
    const operators = expression.match(new RegExp(`\\s*(${OPERATOR})\\s*`, "g")) ?? [];
    if (operandTexts.length < 2 || operators.length !== operandTexts.length - 1) {
      continue;
    }
    const operands = operandTexts.map(numberValue);
    // A reported operand must itself be grounded; a round constant (4 weeks,
    // 28 days, 100) is the reader's arithmetic, not a figure.
    const ungroundedOperand = operandTexts.some((text, index) => {
      const value = operands[index];
      if (!Number.isFinite(value)) {
        return true;
      }
      const figure = figuresIn(text)[0];
      return (
        figure !== undefined &&
        isReportedFigure(figure) &&
        !statesValue(known, value, decimalsOf(text))
      );
    });
    if (ungroundedOperand) {
      continue;
    }
    const computed = evaluate(
      operands,
      operators.map((operator) =>
        operator
          .trim()
          .replace(/[−–]/, "-")
          .replace("*", "×")
          .replace("/", "÷"),
      ),
    );
    const stated = numberValue(result);
    const decimals = decimalsOf(result);
    const candidates = result.endsWith("%") ? [computed, computed * 100] : [computed];
    if (
      Number.isFinite(stated) &&
      candidates.some(
        (value) => Number.isFinite(value) && value.toFixed(decimals) === stated.toFixed(decimals),
      )
    ) {
      for (let k = 0; k <= 4; k += 1) {
        known.add(stated.toFixed(k));
      }
    }
  }
}

/**
 * Reported figures in ``draft`` that no evidence text states, in order of
 * first appearance, as the draft wrote them. A figure is grounded when the
 * evidence holds its value at the draft's precision (so a report may round
 * $1,758.80 to $1,759, or 0.2174 to 21.7%), or when the draft shows correct
 * arithmetic from grounded figures that produces it; never when the evidence
 * only holds inputs and the arithmetic is left to the reader.
 */
export function ungroundedFigures(draft: string, evidence: readonly string[]): string[] {
  const known = evidenceValues(evidence);
  const prose = reportProse(draft);
  groundShownArithmetic(prose, known);
  const flagged: string[] = [];
  const seen = new Set<string>();
  for (const figure of figuresIn(prose)) {
    if (!isReportedFigure(figure) || seen.has(figure.text)) {
      continue;
    }
    seen.add(figure.text);
    if (!statesValue(known, figure.value, figure.decimals)) {
      flagged.push(figure.text);
    }
  }
  return flagged;
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

export function checkDraft(
  contract: DraftContract,
  draft: string,
  evidence: readonly string[] = [],
): DraftCheck[] {
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
  if (contract.figuresGrounded) {
    // Without evidence nothing can be grounded, and that is unknown, not a failure.
    checks.push({
      kind: "figures_grounded",
      status:
        !bounded || evidence.length === 0
          ? "unknown"
          : ungroundedFigures(draft, evidence).length === 0
            ? "pass"
            : "fail",
    });
  }
  return checks;
}

export function draftRepairInstruction(
  contract: DraftContract,
  ungrounded: readonly string[] = [],
): string {
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
  if (contract.figuresGrounded && ungrounded.length > 0) {
    constraints.push(
      `These figures appear in neither a tool output nor the request: ${ungrounded.join(", ")}. For each one, either quote the figure your script printed that it comes from, exactly and with its window and unit, or show the arithmetic that produces it from printed figures inline (for example "$400 + $300 + $630 = $1,330" or "630 ÷ 600 = 1.05"). Keep every figure the request asks for; a figure you can neither quote nor show is removed.`,
    );
  }
  return [
    "Revise only your preceding draft to satisfy these explicit requirements from the current user's request:",
    ...constraints.map((constraint) => `- ${constraint}`),
    "Preserve supported facts and the rest of the request. Do not invent evidence, execute actions, or claim any file or external resource changed. Tools are unavailable. Return the complete corrected answer, not a description of the correction.",
  ].join("\n");
}
