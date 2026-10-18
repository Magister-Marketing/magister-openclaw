import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { pruneContextMessages } from "./pruner.js";
import { DEFAULT_CONTEXT_PRUNING_SETTINGS } from "./settings.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContentBlock = AssistantMessage["content"][number];

const CONTEXT_WINDOW_1M = {
  model: { contextWindow: 1_000_000 },
} as unknown as ExtensionContext;
const CONTEXT_WINDOW_5K = {
  model: { contextWindow: 5_000 },
} as unknown as ExtensionContext;

function makeUser(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

function makeAssistant(content: AssistantMessage["content"]): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeToolResult(
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >,
): AgentMessage {
  return {
    role: "toolResult",
    toolName: "read",
    content,
    timestamp: Date.now(),
  } as AgentMessage;
}

function pruneWithOversizedAssistantThinking(params: {
  assistantBlock: AssistantContentBlock;
  dropThinkingBlocksForEstimate?: boolean;
}) {
  return pruneContextMessages({
    messages: [
      makeUser("hello"),
      makeToolResult([{ type: "text", text: "X".repeat(2_000) }]),
      makeAssistant([params.assistantBlock, { type: "text", text: "done" }]),
    ],
    settings: {
      ...buildToolTrimSettings(),
    },
    ctx: CONTEXT_WINDOW_5K,
    isToolPrunable: () => true,
    ...(params.dropThinkingBlocksForEstimate ? { dropThinkingBlocksForEstimate: true } : {}),
  });
}

function buildToolTrimSettings() {
  return {
    mode: DEFAULT_CONTEXT_PRUNING_SETTINGS.mode,
    ttlMs: DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs,
    keepLastAssistants: 1,
    softTrimRatio: 0.5,
    hardClearRatio: DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClearRatio,
    minPrunableToolChars: DEFAULT_CONTEXT_PRUNING_SETTINGS.minPrunableToolChars,
    tools: DEFAULT_CONTEXT_PRUNING_SETTINGS.tools,
    softTrim: { maxChars: 200, headChars: 100, tailChars: 50 },
    hardClear: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear, enabled: false },
  };
}

function expectToolResultWasTrimmed(result: AgentMessage[]) {
  const toolResult = result.find((message) => message.role === "toolResult") as Extract<
    AgentMessage,
    { role: "toolResult" }
  >;
  const textBlock = toolResult.content[0] as { type: "text"; text: string };
  expect(textBlock.text).toContain("[Tool result trimmed:");
}

describe("pruneContextMessages", () => {
  it("does not crash on assistant message with malformed thinking block (missing thinking string)", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "thinking" } as unknown as AssistantContentBlock,
        { type: "text", text: "ok" },
      ]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with null content entries", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([null as unknown as AssistantContentBlock, { type: "text", text: "world" }]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with malformed text block (missing text string)", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "text" } as unknown as AssistantContentBlock,
        { type: "thinking", thinking: "still fine" },
      ]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("does not crash on toolResult with malformed text block (missing text string)", () => {
    // Regression: a plugin returning undefined produces {type: "text"} with no text property,
    // which crashed estimateTextAndImageChars / collectTextSegments / collectPrunableToolResultSegments.
    // See https://github.com/openclaw/openclaw/issues/34979
    const malformedToolResult = {
      role: "toolResult",
      toolName: "sentinel_control",
      content: [{ type: "text" }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const messages: AgentMessage[] = [
      makeUser("remove sentinel"),
      makeAssistant([
        { type: "toolCall", toolCallId: "call_1", toolName: "sentinel_control", arguments: {} },
      ] as unknown as AssistantContentBlock[]),
      malformedToolResult,
      makeUser("follow up"),
      makeAssistant([{ type: "text", text: "done" }]),
    ];

    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("does not crash on toolResult with malformed text block during soft-trim (image path)", () => {
    // The collectPrunableToolResultSegments path is exercised when the tool result
    // contains image blocks alongside a malformed text block.
    const malformedToolResult = {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text" }, { type: "image", data: "img", mimeType: "image/png" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const messages: AgentMessage[] = [
      makeUser("show image"),
      malformedToolResult,
      makeAssistant([{ type: "text", text: "here it is" }]),
    ];

    expect(() =>
      pruneContextMessages({
        messages,
        settings: {
          ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
          keepLastAssistants: 1,
          softTrimRatio: 0,
          hardClear: {
            ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear,
            enabled: false,
          },
          softTrim: {
            maxChars: 5_000,
            headChars: 2_000,
            tailChars: 2_000,
          },
        },
        ctx: CONTEXT_WINDOW_1M,
        isToolPrunable: () => true,
        contextWindowTokensOverride: 1,
      }),
    ).not.toThrow();
  });

  it("counts malformed non-string text blocks when deciding to trim tool results", () => {
    const malformedToolResult = {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: { payload: "X".repeat(5_000) } }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const result = pruneContextMessages({
      messages: [
        makeUser("show data"),
        malformedToolResult,
        makeAssistant([{ type: "text", text: "done" }]),
      ],
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        keepLastAssistants: 1,
        softTrimRatio: 0,
        hardClear: {
          ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear,
          enabled: false,
        },
        softTrim: {
          maxChars: 200,
          headChars: 80,
          tailChars: 40,
        },
      },
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      contextWindowTokensOverride: 1,
    });

    const toolResult = result.find((message) => message.role === "toolResult") as Extract<
      AgentMessage,
      { role: "toolResult" }
    >;
    const textBlock = toolResult.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("[Tool result trimmed:");
  });

  it("does not crash on toolResult with null content entries", () => {
    const malformedToolResult = {
      role: "toolResult",
      toolName: "read",
      content: [null, { type: "text", text: "ok" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const messages: AgentMessage[] = [
      makeUser("hello"),
      malformedToolResult,
      makeAssistant([{ type: "text", text: "done" }]),
    ];

    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("handles well-formed thinking blocks correctly", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "here is the answer" },
      ]),
    ];
    const result = pruneContextMessages({
      messages,
      settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
      ctx: CONTEXT_WINDOW_1M,
    });
    expect(result).toHaveLength(2);
  });

  it("counts thinkingSignature bytes when estimating assistant message size", () => {
    const result = pruneWithOversizedAssistantThinking({
      assistantBlock: {
        type: "thinking",
        thinking: "[redacted]",
        thinkingSignature: "S".repeat(40_000),
        redacted: true,
      } as unknown as AssistantContentBlock,
    });
    expectToolResultWasTrimmed(result);
  });

  it("counts redacted_thinking data bytes when estimating assistant message size", () => {
    const result = pruneWithOversizedAssistantThinking({
      assistantBlock: {
        type: "redacted_thinking",
        data: "D".repeat(40_000),
        thinkingSignature: "sig",
      } as unknown as AssistantContentBlock,
    });
    expectToolResultWasTrimmed(result);
  });

  it("ignores non-latest thinking signatures that will be dropped before send", () => {
    const messages: AgentMessage[] = [
      makeUser("first"),
      makeAssistant([
        {
          type: "thinking",
          thinking: "internal",
          thinkingSignature: "S".repeat(40_000),
        } as unknown as AssistantContentBlock,
        { type: "text", text: "older reply" },
      ]),
      makeToolResult([{ type: "text", text: "X".repeat(2_000) }]),
      makeUser("latest"),
      makeAssistant([{ type: "text", text: "latest reply" }]),
    ];

    const result = pruneContextMessages({
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ...buildToolTrimSettings(),
      },
      ctx: CONTEXT_WINDOW_5K,
      isToolPrunable: () => true,
      dropThinkingBlocksForEstimate: true,
    });

    expect(result).toBe(messages);
  });

  it("soft-trims image-containing tool results by replacing image blocks with placeholders", () => {
    const messages: AgentMessage[] = [
      makeUser("summarize this"),
      makeToolResult([
        { type: "text", text: "A".repeat(120) },
        { type: "image", data: "img", mimeType: "image/png" },
        { type: "text", text: "B".repeat(120) },
      ]),
      makeAssistant([{ type: "text", text: "done" }]),
    ];

    const result = pruneContextMessages({
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        keepLastAssistants: 1,
        softTrimRatio: 0,
        hardClear: {
          ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear,
          enabled: false,
        },
        softTrim: {
          maxChars: 200,
          headChars: 170,
          tailChars: 30,
        },
      },
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      contextWindowTokensOverride: 16,
    });

    const toolResult = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0]).toMatchObject({ type: "text" });
    const textBlock = toolResult.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("[image removed during context pruning]");
    expect(textBlock.text).toContain(
      "[Tool result trimmed: kept first 170 chars and last 30 chars",
    );
  });

  it("replaces image-only tool results with placeholders even when text trimming is not needed", () => {
    const messages: AgentMessage[] = [
      makeUser("summarize this"),
      makeToolResult([{ type: "image", data: "img", mimeType: "image/png" }]),
      makeAssistant([{ type: "text", text: "done" }]),
    ];

    const result = pruneContextMessages({
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        keepLastAssistants: 1,
        softTrimRatio: 0,
        hardClearRatio: 10,
        hardClear: {
          ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear,
          enabled: false,
        },
        softTrim: {
          maxChars: 5_000,
          headChars: 2_000,
          tailChars: 2_000,
        },
      },
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      contextWindowTokensOverride: 1,
    });

    const toolResult = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.content).toEqual([
      { type: "text", text: "[image removed during context pruning]" },
    ]);
  });

  it("hard-clears image-containing tool results once ratios require clearing", () => {
    const messages: AgentMessage[] = [
      makeUser("summarize this"),
      makeToolResult([
        { type: "text", text: "small text" },
        { type: "image", data: "img", mimeType: "image/png" },
      ]),
      makeAssistant([{ type: "text", text: "done" }]),
    ];

    const placeholder = "[hard cleared test placeholder]";
    const result = pruneContextMessages({
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        keepLastAssistants: 1,
        softTrimRatio: 0,
        hardClearRatio: 0,
        minPrunableToolChars: 1,
        softTrim: {
          maxChars: 5_000,
          headChars: 2_000,
          tailChars: 2_000,
        },
        hardClear: {
          enabled: true,
          placeholder,
        },
      },
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      contextWindowTokensOverride: 8,
    });

    const toolResult = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.content).toEqual([{ type: "text", text: placeholder }]);
  });

  describe("completedTurns", () => {
    const BIG = "P".repeat(5_000);
    // Ratios at 1 so only the completed-turn rule can change anything.
    const settings = {
      ...buildToolTrimSettings(),
      softTrimRatio: 1,
      hardClearRatio: 1,
    };
    const twoTurns = () => [
      makeUser("step 1"),
      makeToolResult([{ type: "text", text: BIG }]),
      makeAssistant([{ type: "text", text: "step 1 report" }]),
      makeUser("step 2"),
      makeToolResult([{ type: "text", text: BIG }]),
      makeAssistant([{ type: "text", text: "working" }]),
    ];

    it("keep: leaves finished turns to the ratios", () => {
      const messages = twoTurns();
      const result = pruneContextMessages({
        messages,
        settings: { ...settings, completedTurns: "keep" as const },
        ctx: CONTEXT_WINDOW_1M,
      });
      expect(result).toBe(messages);
    });

    it("clear: replaces the tool results of finished turns and keeps the current turn", () => {
      const messages = twoTurns();
      const result = pruneContextMessages({
        messages,
        settings: { ...settings, completedTurns: "clear" as const },
        ctx: CONTEXT_WINDOW_1M,
      });
      const first = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
      const second = result[4] as Extract<AgentMessage, { role: "toolResult" }>;
      expect((first.content[0] as { text: string }).text).toBe(settings.hardClear.placeholder);
      expect((second.content[0] as { text: string }).text).toBe(BIG);
      // The reply that closed the turn is untouched.
      expect(result[2]).toBe(messages[2]);
    });

    it("trim: soft-trims the tool results of finished turns", () => {
      const result = pruneContextMessages({
        messages: twoTurns(),
        settings: { ...settings, completedTurns: "trim" as const },
        ctx: CONTEXT_WINDOW_1M,
      });
      const first = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
      const second = result[4] as Extract<AgentMessage, { role: "toolResult" }>;
      expect((first.content[0] as { text: string }).text).toContain("[Tool result trimmed:");
      expect((second.content[0] as { text: string }).text).toBe(BIG);
    });

    it("is idempotent, so a pruned context keeps the same prefix on the next request", () => {
      const once = pruneContextMessages({
        messages: twoTurns(),
        settings: { ...settings, completedTurns: "clear" as const },
        ctx: CONTEXT_WINDOW_1M,
      });
      const twice = pruneContextMessages({
        messages: once,
        settings: { ...settings, completedTurns: "clear" as const },
        ctx: CONTEXT_WINDOW_1M,
      });
      expect(twice).toBe(once);
    });

    it("respects the tool allow/deny match", () => {
      const result = pruneContextMessages({
        messages: twoTurns(),
        settings: { ...settings, completedTurns: "clear" as const },
        ctx: CONTEXT_WINDOW_1M,
        isToolPrunable: () => false,
      });
      const first = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
      expect((first.content[0] as { text: string }).text).toBe(BIG);
    });

    it("counts the cleared turns before deciding whether the ratios apply", () => {
      // 5K window = 20K chars. Two 5K-char results plus text sit at ~50% of it; clearing the
      // finished turn brings the context under the soft-trim ratio, so the current turn's result
      // is left whole even though the raw total was over the line.
      const result = pruneContextMessages({
        messages: twoTurns(),
        settings: {
          ...settings,
          completedTurns: "clear" as const,
          keepLastAssistants: 0,
          softTrimRatio: 0.4,
        },
        ctx: CONTEXT_WINDOW_5K,
      });
      const second = result[4] as Extract<AgentMessage, { role: "toolResult" }>;
      expect((second.content[0] as { text: string }).text).toBe(BIG);
    });
  });

  describe("hard clear in always mode", () => {
    const BIG = "Q".repeat(3_000);
    // 5K window = 20K chars. Soft trim is switched off (nothing exceeds maxChars) so the
    // hard-clear line, 50% of the window, is what the five 3K results cross.
    const settings = {
      ...buildToolTrimSettings(),
      softTrimRatio: 0.1,
      hardClearRatio: 0.5,
      minPrunableToolChars: 0,
      softTrim: { maxChars: 100_000, headChars: 1, tailChars: 1 },
      hardClear: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear, enabled: true },
    };
    const messages = () => [
      makeUser("go"),
      makeToolResult([{ type: "text", text: BIG }]),
      makeAssistant([{ type: "text", text: "a" }]),
      makeToolResult([{ type: "text", text: BIG }]),
      makeAssistant([{ type: "text", text: "b" }]),
      makeToolResult([{ type: "text", text: BIG }]),
      makeAssistant([{ type: "text", text: "c" }]),
      makeToolResult([{ type: "text", text: BIG }]),
      makeAssistant([{ type: "text", text: "d" }]),
      makeToolResult([{ type: "text", text: BIG }]),
      makeAssistant([{ type: "text", text: "e" }]),
    ];
    const clearedCount = (result: AgentMessage[]) =>
      result.filter(
        (m) =>
          m.role === "toolResult" &&
          (m.content[0] as { text?: string }).text === settings.hardClear.placeholder,
      ).length;

    it("cache-ttl clears one old result at a time, until the ratio is back under the line", () => {
      const result = pruneContextMessages({
        messages: messages(),
        settings: { ...settings, mode: "cache-ttl" as const },
        ctx: CONTEXT_WINDOW_5K,
      });
      // 15K of 20K chars: the first clear leaves 12K (still 60%), the second 9K, under 50%.
      expect(clearedCount(result)).toBe(2);
    });

    it("always clears every prunable result before the tail, so the prefix stays stable", () => {
      const result = pruneContextMessages({
        messages: messages(),
        settings: { ...settings, mode: "always" as const },
        ctx: CONTEXT_WINDOW_5K,
      });
      // keepLastAssistants is 1, so every result before the last assistant is prunable.
      expect(clearedCount(result)).toBe(5);
    });
  });
});
