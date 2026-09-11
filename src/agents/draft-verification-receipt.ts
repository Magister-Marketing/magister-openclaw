import { z } from "zod";
import { DRAFT_STOP_REASONS, type DraftVerificationReceipt } from "./draft-verification.js";

const receiptSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["off", "shadow", "repair"]),
    outcome: z.enum(["unchecked", "passed", "failed", "repaired", "repair_failed", "excluded"]),
    checks: z
      .array(
        z
          .object({
            kind: z.enum(["json_only", "bullet_count", "allocation_count", "allocation_total"]),
            status: z.enum(["pass", "fail", "unknown"]),
          })
          .strict(),
      )
      .max(4),
    repair_attempts: z.union([z.literal(0), z.literal(1)]),
    stop_reason: z.enum(DRAFT_STOP_REASONS).nullable(),
    ceiling_retried: z.null(),
    skill_reads: z.null(),
  })
  .strict()
  .refine(
    (receipt) => new Set(receipt.checks.map((check) => check.kind)).size === receipt.checks.length,
  );

/** Strict allowlist at the export boundary, including events emitted by extensions. */
export function parseDraftVerificationReceipt(
  value: unknown,
): DraftVerificationReceipt | undefined {
  const parsed = receiptSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
