import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { pruneContextMessages } from "./pruner.js";
import {
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  type EffectiveContextPruningSettings,
} from "./settings.js";

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
    windowTokens: DEFAULT_CONTEXT_PRUNING_SETTINGS.windowTokens,
    completedTurns: DEFAULT_CONTEXT_PRUNING_SETTINGS.completedTurns,
    completedTurnsSessionKeys: DEFAULT_CONTEXT_PRUNING_SETTINGS.completedTurnsSessionKeys,
    keepLastAssistants: 1,
    softTrimRatio: 0.5,
    hardClearRatio: DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClearRatio,
    minPrunableToolChars: DEFAULT_CONTEXT_PRUNING_SETTINGS.minPrunableToolChars,
    tools: DEFAULT_CONTEXT_PRUNING_SETTINGS.tools,
    completedTurnsKeepReads: DEFAULT_CONTEXT_PRUNING_SETTINGS.completedTurnsKeepReads,
    completedTurnsClearArgs: DEFAULT_CONTEXT_PRUNING_SETTINGS.completedTurnsClearArgs,
    batch: structuredClone(DEFAULT_CONTEXT_PRUNING_SETTINGS.batch),
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

    it("clear: keeps reads under completedTurnsKeepReads and clears the rest", () => {
      const call = (id: string, name: string, path: string) =>
        ({ type: "toolCall", id, name, arguments: { path } }) as const;
      const result = (id: string, toolName: string) =>
        ({
          role: "toolResult",
          toolCallId: id,
          toolName,
          content: [{ type: "text", text: BIG }],
          timestamp: Date.now(),
        }) as unknown as AgentMessage;
      const messages = [
        makeUser("turn 1"),
        makeAssistant([
          call("c1", "read", "/data/.openclaw/skills/cro/SKILL.md"),
          call("c2", "read", "/data/.openclaw/workspace/BRAND.md"),
          call("c3", "web_fetch", "/data/.openclaw/skills/not-a-read"),
        ]),
        result("c1", "read"),
        result("c2", "read"),
        result("c3", "web_fetch"),
        makeAssistant([{ type: "text", text: "turn 1 reply" }]),
        makeUser("turn 2"),
      ];
      const pruned = pruneContextMessages({
        messages,
        settings: {
          ...settings,
          completedTurns: "clear" as const,
          completedTurnsKeepReads: ["/data/.openclaw/skills/"],
        },
        ctx: CONTEXT_WINDOW_1M,
      });
      const text = (i: number) =>
        (
          (pruned[i] as Extract<AgentMessage, { role: "toolResult" }>).content[0] as {
            text: string;
          }
        ).text;
      expect(text(2)).toBe(BIG);
      expect(text(3)).toBe(settings.hardClear.placeholder);
      expect(text(4)).toBe(settings.hardClear.placeholder);
    });

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

    describe("a turn that ended without a reply keeps its results", () => {
      const fetchCall = { type: "toolCall", id: "c1", name: "web_fetch", arguments: {} } as const;
      const stopped = (stopReason: "aborted" | "error", text?: string): AgentMessage => ({
        ...(makeAssistant(text ? [{ type: "text", text }] : [fetchCall]) as AssistantMessage),
        stopReason,
      });
      const clearAll = (messages: AgentMessage[]) =>
        pruneContextMessages({
          messages,
          settings: { ...settings, completedTurns: "clear" as const },
          ctx: CONTEXT_WINDOW_1M,
        });
      const resultText = (messages: AgentMessage[], i: number) =>
        (
          (messages[i] as Extract<AgentMessage, { role: "toolResult" }>).content[0] as {
            text: string;
          }
        ).text;

      it("after Stop, so 'give me what you have' still sees what the turn found", () => {
        const messages = [
          makeUser("research competitors"),
          makeAssistant([fetchCall]),
          makeToolResult([{ type: "text", text: BIG }]),
          stopped("aborted"),
          makeUser("just give me what you have"),
        ];
        expect(clearAll(messages)).toBe(messages);
      });

      it("after a failed reply, even one the transcript repair gave fallback text", () => {
        const messages = [
          makeUser("research competitors"),
          makeToolResult([{ type: "text", text: BIG }]),
          stopped("error", "The model failed to respond."),
          makeUser("try again"),
        ];
        expect(clearAll(messages)).toBe(messages);
      });

      it("when an approval decision arrives after a turn that ended on its card", () => {
        const messages = [
          makeUser("post it"),
          makeAssistant([fetchCall]),
          makeToolResult([{ type: "text", text: BIG }]),
          // The approval card is the last thing in the turn: nothing is written after it.
          makeAssistant([]),
          makeUser("Approved: Instagram post. Published.\nReceipt: url=https://instagram.com/p/1"),
        ];
        expect(clearAll(messages)).toBe(messages);
      });

      it("when a subagent result is steered into the turn after a tool result", () => {
        const messages = [
          makeUser("audit the site"),
          makeAssistant([{ type: "text", text: "Checking the pages now." }, fetchCall]),
          makeToolResult([{ type: "text", text: BIG }]),
          makeUser("[Subagent result] The competitor scan finished: ..."),
          makeAssistant([fetchCall]),
        ];
        expect(clearAll(messages)).toBe(messages);
      });

      it("until a later turn replies, then both turns' results clear", () => {
        const messages = [
          makeUser("research competitors"),
          makeToolResult([{ type: "text", text: BIG }]),
          stopped("aborted"),
          makeUser("just give me what you have"),
          makeAssistant([{ type: "text", text: "Here is what I found so far." }]),
          makeUser("thanks, now draft the post"),
        ];
        const result = clearAll(messages);
        expect(resultText(result, 1)).toBe(settings.hardClear.placeholder);
      });
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

  describe("hard clear", () => {
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
  });

  describe("completedTurnsClearArgs", () => {
    const FILE = "F".repeat(5_000);
    const settings = {
      ...buildToolTrimSettings(),
      softTrimRatio: 1,
      hardClearRatio: 1,
      completedTurns: "clear" as const,
      completedTurnsClearArgs: ["write"],
    };
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      ({ type: "toolCall", id, name, arguments: args }) as const;
    const argsAt = (messages: AgentMessage[], index: number, block = 0) =>
      (
        (messages[index] as AssistantMessage).content[block] as {
          arguments: Record<string, string>;
        }
      ).arguments;
    const messages = () => [
      makeUser("step 1"),
      makeAssistant([
        call("w1", "write", { path: "resources/report.md", content: FILE }),
        call("e1", "exec", { command: FILE }),
        call("w2", "write", { path: "resources/note.md", content: "short" }),
      ]),
      makeAssistant([{ type: "text", text: "step 1 report" }]),
      makeUser("step 2"),
      makeAssistant([call("w3", "write", { path: "resources/draft.md", content: FILE })]),
    ];

    it("clears the long arguments of the named tools once their turn has a reply", () => {
      const pruned = pruneContextMessages({
        messages: messages(),
        settings,
        ctx: CONTEXT_WINDOW_1M,
      });
      const written = argsAt(pruned, 1, 0);
      expect(written.path).toBe("resources/report.md");
      expect(written.content).toContain("5000 characters cleared from context");
      // Another tool's argument, a short argument, and the turn still in progress all stay.
      expect(argsAt(pruned, 1, 1).command).toBe(FILE);
      expect(argsAt(pruned, 1, 2).content).toBe("short");
      expect(argsAt(pruned, 4).content).toBe(FILE);
    });

    it("leaves every argument alone when no tool is named", () => {
      const input = messages();
      const pruned = pruneContextMessages({
        messages: input,
        settings: { ...settings, completedTurnsClearArgs: [] },
        ctx: CONTEXT_WINDOW_1M,
      });
      expect(pruned).toBe(input);
    });

    it("is idempotent, so the cleared call is sent the same way on every later request", () => {
      const once = pruneContextMessages({ messages: messages(), settings, ctx: CONTEXT_WINDOW_1M });
      const twice = pruneContextMessages({ messages: once, settings, ctx: CONTEXT_WINDOW_1M });
      expect(twice).toEqual(once);
    });
  });

  describe("always mode: batches in the turn still in progress", () => {
    const PAGE = "P".repeat(8_000);
    const SKILL = "S".repeat(8_000);
    const SYSTEM_TOKENS = 5_000;
    const settings: EffectiveContextPruningSettings = {
      ...buildToolTrimSettings(),
      mode: "always",
      completedTurns: "clear",
      completedTurnsKeepReads: ["/data/.openclaw/skills/"],
      keepLastAssistants: 2,
      softTrim: { maxChars: 400, headChars: 100, tailChars: 100 },
      hardClear: { enabled: true, placeholder: "[cleared between turns]" },
      // Each request adds two 2K-token pages. System prompt, skill and the two newest rounds
      // are about 15K tokens that no batch touches, so a batch buys about six requests.
      batch: {
        triggerTokens: 40_000,
        minFreedTokens: 8_000,
        placeholder: "[cleared in this turn]",
      },
    };

    const chars = (messages: AgentMessage[]) =>
      messages.reduce((sum, message) => {
        if (message.role === "user" && typeof message.content === "string") {
          return sum + message.content.length;
        }
        if (message.role !== "assistant" && message.role !== "toolResult") {
          return sum;
        }
        let inner = 0;
        for (const block of message.content) {
          if (block.type === "text") {
            inner += block.text.length;
          } else if (block.type === "toolCall") {
            inner += JSON.stringify(block.arguments).length;
          }
        }
        return sum + inner;
      }, 0);
    const assistant = (
      calls: Array<{ id: string; name: string; path: string }>,
      promptTokens: number,
    ): AgentMessage => {
      const message = makeAssistant(
        calls.map((c) => ({
          type: "toolCall",
          id: c.id,
          name: c.name,
          arguments: { path: c.path },
        })),
      ) as AssistantMessage;
      return {
        ...message,
        usage: { ...message.usage, input: 500, cacheRead: promptTokens - 500 },
        stopReason: "toolUse",
      };
    };
    const result = (id: string, toolName: string, text: string) =>
      ({
        role: "toolResult",
        toolCallId: id,
        toolName,
        content: [{ type: "text", text }],
        timestamp: 0,
      }) as unknown as AgentMessage;
    const textOf = (message: AgentMessage) =>
      ((message as Extract<AgentMessage, { role: "toolResult" }>).content[0] as { text: string })
        .text;

    /**
     * One turn as a provider sees it: every request is pruned from the whole transcript, and
     * the prompt size of what was sent goes on the reply, as a provider reports it.
     */
    function runTurn(params: {
      requests: number;
      settings?: EffectiveContextPruningSettings;
      ctx?: ExtensionContext;
      reportUsage?: boolean;
    }) {
      const use = params.settings ?? settings;
      const messages: AgentMessage[] = [makeUser("run the step")];
      const sent: AgentMessage[][] = [];
      const promptTokens: number[] = [];
      for (let request = 0; request < params.requests; request++) {
        const prompt = pruneContextMessages({
          messages,
          settings: use,
          ctx: params.ctx ?? CONTEXT_WINDOW_1M,
        });
        // A copy: an unpruned prompt is the transcript array itself, which keeps growing.
        sent.push([...prompt]);
        const tokens = SYSTEM_TOKENS + Math.ceil(chars(prompt) / 4);
        promptTokens.push(tokens);
        const calls =
          request === 0
            ? [{ id: "skill", name: "read", path: "/data/.openclaw/skills/seo/SKILL.md" }]
            : [
                { id: `r${request}a`, name: "web_fetch", path: `https://example.com/${request}/a` },
                { id: `r${request}b`, name: "web_fetch", path: `https://example.com/${request}/b` },
              ];
        messages.push(assistant(calls, params.reportUsage === false ? 0 : tokens));
        for (const c of calls) {
          messages.push(result(c.id, c.name, c.name === "read" ? SKILL : PAGE));
        }
      }
      return { messages, sent, promptTokens };
    }
    /** The requests that changed a message an earlier request had already sent. */
    const rewrites = (sent: AgentMessage[][]) =>
      sent
        .map((prompt, request) => ({ prompt, request }))
        .filter(({ prompt, request }) => {
          if (request === 0) {
            return false;
          }
          const before = sent[request - 1];
          return before.some(
            (message, index) => JSON.stringify(message) !== JSON.stringify(prompt[index]),
          );
        })
        .map(({ request }) => request);

    it("sends every request as the one before it plus new messages, except at a batch", () => {
      const { sent, promptTokens } = runTurn({ requests: 30 });
      const batches = rewrites(sent);
      // 30 requests: a handful of batches several requests apart, never one per request.
      expect(batches.length).toBeGreaterThanOrEqual(2);
      expect(batches.length).toBeLessThanOrEqual(6);
      for (let i = 1; i < batches.length; i++) {
        expect(batches[i] - batches[i - 1]).toBeGreaterThanOrEqual(4);
      }
      // And the batches hold the prompt at the trigger, give or take one request's results.
      expect(Math.max(...promptTokens)).toBeLessThanOrEqual(40_000 + 4_500);
    });

    it("finds the same batches from the transcript alone, whenever it is asked", () => {
      const { messages, sent } = runTurn({ requests: 30 });
      const boundaries = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.role === "assistant")
        .map(({ index }) => index);
      // A fresh call per request, as a machine builds a fresh pruner per run.
      boundaries.forEach((boundary, request) => {
        const replayed = pruneContextMessages({
          messages: messages.slice(0, boundary),
          settings,
          ctx: CONTEXT_WINDOW_1M,
        });
        expect(replayed).toEqual(sent[request]);
      });
    });

    it("trims the newest batch, clears the ones before it, and leaves the newest rounds whole", () => {
      const { sent } = runTurn({ requests: 30 });
      const last = sent.at(-1) as AgentMessage[];
      const fetched = last.filter(
        (message) => message.role === "toolResult" && message.toolName === "web_fetch",
      );
      const texts = fetched.map(textOf);
      expect(texts[0]).toBe("[cleared in this turn]");
      expect(texts.some((text) => text.includes("[Tool result trimmed:"))).toBe(true);
      // keepLastAssistants is 2: the last two rounds of two pages each are untouched.
      expect(texts.slice(-4)).toEqual([PAGE, PAGE, PAGE, PAGE]);
      // Cleared results come first, then trimmed ones, then whole ones: nothing interleaves.
      const kind = (text: string) =>
        text === "[cleared in this turn]" ? 0 : text.includes("[Tool result trimmed:") ? 1 : 2;
      const kinds = texts.map(kind);
      expect(kinds).toEqual([...kinds].toSorted((a, b) => a - b));
    });

    it("keeps a skill read whole through every batch", () => {
      const { sent } = runTurn({ requests: 30 });
      for (const prompt of sent.slice(1)) {
        const skill = prompt.find(
          (message) => message.role === "toolResult" && message.toolCallId === "skill",
        ) as AgentMessage;
        expect(textOf(skill)).toBe(SKILL);
      }
    });

    it("skips a batch that would free too little to be worth a full-price request", () => {
      const { sent } = runTurn({
        requests: 12,
        settings: { ...settings, batch: { ...settings.batch, minFreedTokens: 1_000_000 } },
      });
      expect(rewrites(sent)).toEqual([]);
    });

    it("falls back to softTrimRatio of the window when no trigger is set", () => {
      const byRatio = { ...settings, batch: { ...settings.batch, triggerTokens: null } };
      // softTrimRatio is 0.5: 40K tokens of an 80K window, the same trigger as above.
      const small = { model: { contextWindow: 80_000 } } as unknown as ExtensionContext;
      expect(rewrites(runTurn({ requests: 12, settings: byRatio, ctx: small }).sent)).not.toEqual(
        [],
      );
      // Of a 1M window it is 500K tokens, which twelve requests never reach.
      expect(rewrites(runTurn({ requests: 12, settings: byRatio }).sent)).toEqual([]);
    });

    it("starts no batch from a reply that reported no prompt size", () => {
      const { sent } = runTurn({ requests: 12, reportUsage: false });
      expect(rewrites(sent)).toEqual([]);
    });

    it("never prunes a turn's first request, whatever earlier turns left behind", () => {
      const earlier = runTurn({ requests: 6 }).messages;
      const messages = [
        ...earlier,
        makeAssistant([{ type: "text", text: "step 1 report" }]),
        makeUser("step 2"),
      ];
      const pruned = pruneContextMessages({ messages, settings, ctx: CONTEXT_WINDOW_1M });
      // The finished turn is cleared by the completed-turns rule, with its own placeholder.
      const fetched = pruned.filter(
        (message) => message.role === "toolResult" && message.toolName === "web_fetch",
      );
      expect(fetched.map(textOf)).toEqual(fetched.map(() => "[cleared between turns]"));
    });
  });
});
