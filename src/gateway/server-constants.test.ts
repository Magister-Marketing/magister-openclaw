import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEALTH_REFRESH_INTERVAL_MS,
  MIN_HEALTH_REFRESH_INTERVAL_MS,
  resolveHealthRefreshIntervalMs,
} from "./server-constants.js";

describe("resolveHealthRefreshIntervalMs", () => {
  it("defaults when the override is absent or blank", () => {
    expect(resolveHealthRefreshIntervalMs(undefined)).toBe(DEFAULT_HEALTH_REFRESH_INTERVAL_MS);
    expect(resolveHealthRefreshIntervalMs("")).toBe(DEFAULT_HEALTH_REFRESH_INTERVAL_MS);
    expect(resolveHealthRefreshIntervalMs("   ")).toBe(DEFAULT_HEALTH_REFRESH_INTERVAL_MS);
  });

  it("accepts a longer interval so managed fleets can probe channels less often", () => {
    expect(resolveHealthRefreshIntervalMs("900000")).toBe(900_000);
    expect(resolveHealthRefreshIntervalMs(" 120000 ")).toBe(120_000);
  });

  it("floors fractional values", () => {
    expect(resolveHealthRefreshIntervalMs("60000.9")).toBe(60_000);
  });

  it("ignores values that would probe faster than the floor or are not numbers", () => {
    expect(resolveHealthRefreshIntervalMs("5000")).toBe(DEFAULT_HEALTH_REFRESH_INTERVAL_MS);
    expect(resolveHealthRefreshIntervalMs("0")).toBe(DEFAULT_HEALTH_REFRESH_INTERVAL_MS);
    expect(resolveHealthRefreshIntervalMs("-1")).toBe(DEFAULT_HEALTH_REFRESH_INTERVAL_MS);
    expect(resolveHealthRefreshIntervalMs("soon")).toBe(DEFAULT_HEALTH_REFRESH_INTERVAL_MS);
    expect(resolveHealthRefreshIntervalMs("Infinity")).toBe(DEFAULT_HEALTH_REFRESH_INTERVAL_MS);
    expect(MIN_HEALTH_REFRESH_INTERVAL_MS).toBeLessThanOrEqual(DEFAULT_HEALTH_REFRESH_INTERVAL_MS);
  });
});
