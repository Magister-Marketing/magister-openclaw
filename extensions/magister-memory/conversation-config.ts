import type { ConversationCheckpointConfig, ConversationMemoryMode } from "./conversation-types.js";
import { isRecord } from "./file-utils.js";

export const DEFAULT_CONVERSATION_CHECKPOINT_CONFIG: ConversationCheckpointConfig = {
  mode: "off",
  model: "magister-gateway/anthropic/claude-haiku-4-5",
  idleMinutes: 10,
  recentDays: 30,
  maxInputChars: 12_000,
  maxCheckpointChars: 800,
  maxHeaderChars: 800,
};

export function resolveConversationCheckpointConfig(
  pluginConfig: unknown,
  environmentMode: string | null | undefined = process.env.MAGISTER_CONVERSATION_MEMORY_MODE,
): ConversationCheckpointConfig {
  const root = isRecord(pluginConfig) ? pluginConfig : {};
  const configured = isRecord(root.conversationCheckpoints) ? root.conversationCheckpoints : {};
  const configuredMode = readMode(configured.mode) ?? DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.mode;
  const mode = environmentMode == null ? configuredMode : (readMode(environmentMode) ?? "off");
  return {
    mode,
    model: readString(configured.model) ?? DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.model,
    idleMinutes:
      readNumber(configured.idleMinutes, 1, 1_440) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.idleMinutes,
    recentDays:
      readNumber(configured.recentDays, 1, 365) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.recentDays,
    maxInputChars:
      readNumber(configured.maxInputChars, 2_000, 100_000) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.maxInputChars,
    maxCheckpointChars:
      readNumber(configured.maxCheckpointChars, 200, 5_000) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.maxCheckpointChars,
    maxHeaderChars:
      readNumber(configured.maxHeaderChars, 200, 1_000) ??
      DEFAULT_CONVERSATION_CHECKPOINT_CONFIG.maxHeaderChars,
  };
}

function readMode(value: unknown): ConversationMemoryMode | undefined {
  return value === "off" || value === "shadow" || value === "active" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    return undefined;
  }
  return Math.floor(value);
}
