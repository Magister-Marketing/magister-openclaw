import { describe, expect, it } from "vitest";
import {
  computeEffectiveSettings,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  isActiveContextPruningMode,
} from "./settings.js";

describe("computeEffectiveSettings", () => {
  it("is off unless the mode is cache-ttl or always", () => {
    expect(computeEffectiveSettings(undefined)).toBeNull();
    expect(computeEffectiveSettings({})).toBeNull();
    expect(computeEffectiveSettings({ mode: "off" })).toBeNull();
    expect(isActiveContextPruningMode("off")).toBe(false);
    expect(isActiveContextPruningMode("always")).toBe(true);
  });

  it("keeps the defaults for cache-ttl", () => {
    const s = computeEffectiveSettings({ mode: "cache-ttl" });
    expect(s).toEqual(DEFAULT_CONTEXT_PRUNING_SETTINGS);
  });

  it("reads the always mode with its window and completed-turn rule", () => {
    const s = computeEffectiveSettings({
      mode: "always",
      windowTokens: 200_000,
      completedTurns: "clear",
      softTrimRatio: 0.4,
      hardClearRatio: 0.6,
    });
    expect(s?.mode).toBe("always");
    expect(s?.windowTokens).toBe(200_000);
    expect(s?.completedTurns).toBe("clear");
    expect(s?.softTrimRatio).toBe(0.4);
    expect(s?.hardClearRatio).toBe(0.6);
  });

  it("ignores an invalid window or completed-turn rule", () => {
    const s = computeEffectiveSettings({
      mode: "always",
      windowTokens: -1,
      completedTurns: "sometimes",
    });
    expect(s?.windowTokens).toBeNull();
    expect(s?.completedTurns).toBe("keep");
  });
});
