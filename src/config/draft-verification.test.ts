import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("draft verification configuration", () => {
  it.each(["off", "shadow", "repair"])("accepts global and per-agent %s modes", (mode) => {
    expect(OpenClawSchema.safeParse({ tools: { draftVerification: { mode } } }).success).toBe(true);
    expect(
      OpenClawSchema.safeParse({
        agents: { list: [{ id: "main", tools: { draftVerification: { mode } } }] },
      }).success,
    ).toBe(true);
  });
  it.each([{ mode: "always" }, { mode: "repair", maxRepairs: 99 }, { enabled: true }])(
    "rejects undeclared controls",
    (draftVerification) => {
      expect(OpenClawSchema.safeParse({ tools: { draftVerification } }).success).toBe(false);
    },
  );
});
