import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../pi-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-hooks/compaction-safeguard.js";
import contextPruningExtension from "../pi-hooks/context-pruning.js";
import { getContextPruningRuntime } from "../pi-hooks/context-pruning/runtime.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: () => undefined,
  resolveProviderRuntimePlugin: () => undefined,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: () => undefined,
}));

function buildSafeguardFactories(cfg: OpenClawConfig) {
  const sessionManager = {} as SessionManager;
  const model = {
    id: "claude-sonnet-4-20250514",
    contextWindow: 200_000,
  } as Model<Api>;

  const factories = buildEmbeddedExtensionFactories({
    cfg,
    sessionManager,
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    model,
  });

  return { factories, sessionManager };
}

function expectSafeguardRuntime(
  cfg: OpenClawConfig,
  expectedRuntime: { qualityGuardEnabled: boolean; qualityGuardMaxRetries?: number },
) {
  const { factories, sessionManager } = buildSafeguardFactories(cfg);

  expect(factories).toContain(compactionSafeguardExtension);
  expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject(expectedRuntime);
}

describe("buildEmbeddedExtensionFactories", () => {
  it("enables quality-guard retries by default in safeguard mode", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
    });
  });

  it("honors explicit safeguard quality-guard disablement", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: false,
    });
  });

  it("wires explicit safeguard quality-guard runtime flags", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: true,
              maxRetries: 2,
            },
          },
        },
      },
    } as OpenClawConfig;
    expectSafeguardRuntime(cfg, {
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 2,
    });
  });

  it("enables cache-ttl pruning for custom anthropic-messages providers", () => {
    const factories = buildEmbeddedExtensionFactories({
      cfg: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      } as OpenClawConfig,
      sessionManager: {} as SessionManager,
      provider: "litellm",
      modelId: "claude-sonnet-4-6",
      model: { api: "anthropic-messages", contextWindow: 200_000 } as Model<Api>,
    });

    expect(factories).toContain(contextPruningExtension);
  });

  describe("always mode", () => {
    const cfg = {
      agents: {
        defaults: {
          contextPruning: {
            mode: "always",
            windowTokens: 200_000,
            completedTurns: "clear",
            completedTurnsSessionKeys: ["workflow_run:"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    function build(sessionKey: string) {
      const sessionManager = {} as SessionManager;
      const factories = buildEmbeddedExtensionFactories({
        cfg,
        sessionManager,
        provider: "magister-gateway",
        modelId: "openai/gpt-6-luna",
        model: { id: "openai/gpt-6-luna", contextWindow: 922_000 } as Model<Api>,
        sessionKey,
      });
      return { factories, runtime: getContextPruningRuntime(sessionManager) };
    }

    it("prunes on a provider without a cache TTL and measures against windowTokens", () => {
      const { factories, runtime } = build("workflow_run:run-1");
      expect(factories).toContain(contextPruningExtension);
      expect(runtime?.settings.mode).toBe("always");
      expect(runtime?.contextWindowTokens).toBe(200_000);
      expect(runtime?.lastCacheTouchAt).toBeNull();
      expect(runtime?.settings.completedTurns).toBe("clear");
    });

    it("keeps finished turns in a session the completed-turns keys do not name", () => {
      const { runtime } = build("webchat:chat-1");
      expect(runtime?.settings.mode).toBe("always");
      expect(runtime?.settings.completedTurns).toBe("keep");
    });
  });
});
