import { describe, expect, it } from "vitest";
import {
  computeEffectiveSettings,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  isActiveContextPruningMode,
  settingsForSession,
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

  it("scopes the completed-turns rule to the configured session keys", () => {
    const s = computeEffectiveSettings({
      mode: "always",
      completedTurns: "clear",
      completedTurnsSessionKeys: ["workflow_run:", "", 7 as unknown as string],
    });
    expect(s?.completedTurnsSessionKeys).toEqual(["workflow_run:"]);
    expect(settingsForSession(s!, "workflow_run:abc").completedTurns).toBe("clear");
    expect(settingsForSession(s!, "webchat:abc").completedTurns).toBe("keep");
    expect(settingsForSession(s!, undefined).completedTurns).toBe("keep");
    // Every other knob is untouched for the excluded session.
    expect(settingsForSession(s!, "webchat:abc").mode).toBe("always");
  });

  it("reads the completed-turns keep list and drops empty entries", () => {
    const s = computeEffectiveSettings({
      mode: "always",
      completedTurns: "clear",
      completedTurnsKeepReads: ["/data/.openclaw/skills/", ""],
    });
    expect(s?.completedTurnsKeepReads).toEqual(["/data/.openclaw/skills/"]);
    expect(computeEffectiveSettings({ mode: "always" })?.completedTurnsKeepReads).toEqual([]);
  });

  it("matches a chat's agent-qualified key against a bare prefix", () => {
    const s = computeEffectiveSettings({
      mode: "always",
      completedTurns: "clear",
      completedTurnsSessionKeys: ["workflow_run:", "webchat:"],
    });
    expect(settingsForSession(s!, "agent:marketing:webchat:abc").completedTurns).toBe("clear");
    expect(settingsForSession(s!, "webchat:abc").completedTurns).toBe("clear");
    expect(settingsForSession(s!, "agent:marketing:workflow_run:run-1").completedTurns).toBe(
      "clear",
    );
    expect(settingsForSession(s!, "workflow_run:run-1").completedTurns).toBe("clear");
    expect(settingsForSession(s!, "agent:marketing:main").completedTurns).toBe("keep");
    expect(settingsForSession(s!, "agent:marketing:slack:channel:c1").completedTurns).toBe("keep");
  });

  it("applies the completed-turns rule everywhere when no session keys are listed", () => {
    const s = computeEffectiveSettings({ mode: "always", completedTurns: "trim" });
    expect(settingsForSession(s!, "webchat:abc")).toBe(s);
  });
});
