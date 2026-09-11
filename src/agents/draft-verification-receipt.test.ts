import { describe, expect, it } from "vitest";
import { parseDraftVerificationReceipt } from "./draft-verification-receipt.js";

const receipt = {
  version: 1,
  mode: "shadow",
  outcome: "failed",
  checks: [{ kind: "json_only", status: "fail" }],
  repair_attempts: 0,
  stop_reason: "stop",
  ceiling_retried: null,
  skill_reads: null,
};
describe("receipt export boundary", () => {
  it("preserves bounded observed evidence", () => {
    expect(parseDraftVerificationReceipt(receipt)).toEqual(receipt);
  });
  it.each([
    { prompt: "secret" },
    { stop_reason: "private provider error" },
    { version: true },
    { repair_attempts: 2 },
    { ceiling_retried: false },
    { skill_reads: ["private/path"] },
    { checks: Array.from({ length: 5 }, () => receipt.checks[0]) },
    { checks: [receipt.checks[0], receipt.checks[0]] },
    { checks: [{ ...receipt.checks[0], answer: "private" }] },
  ])("rejects malformed or injected metadata", (overrides) => {
    expect(parseDraftVerificationReceipt({ ...receipt, ...overrides })).toBeUndefined();
  });
});
