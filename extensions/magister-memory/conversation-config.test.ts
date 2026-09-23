import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONVERSATION_CHECKPOINT_CONFIG,
  resolveConversationCheckpointConfig,
} from "./conversation-config.js";

describe("resolveConversationCheckpointConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to off for third-party plugin installs", () => {
    expect(resolveConversationCheckpointConfig({}, null)).toEqual(
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG,
    );
  });

  it("accepts bounded configured values", () => {
    const config = resolveConversationCheckpointConfig(
      {
        conversationCheckpoints: {
          mode: "shadow",
          idleMinutes: 15,
          recentDays: 45,
          maxInputChars: 20_000,
          maxHeaderChars: 900,
        },
      },
      null,
    );
    expect(config).toMatchObject({
      mode: "shadow",
      idleMinutes: 15,
      recentDays: 45,
      maxInputChars: 20_000,
      maxHeaderChars: 900,
    });
  });

  it("lets the environment override mode and fails invalid overrides closed", () => {
    expect(resolveConversationCheckpointConfig({}, "active").mode).toBe("active");
    expect(
      resolveConversationCheckpointConfig(
        { conversationCheckpoints: { mode: "active" } },
        "surprise",
      ).mode,
    ).toBe("off");
  });

  it("reads the process environment only when no explicit override is supplied", () => {
    vi.stubEnv("MAGISTER_CONVERSATION_MEMORY_MODE", "active");

    expect(resolveConversationCheckpointConfig({}).mode).toBe("active");
    expect(
      resolveConversationCheckpointConfig({ conversationCheckpoints: { mode: "shadow" } }, null)
        .mode,
    ).toBe("shadow");
  });
});
