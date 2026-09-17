import { Agent, type AgentEvent, type StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftVerificationStream } from "./draft-verification-stream.js";
import { MAX_DRAFT_CHARS } from "./draft-verification.js";

const model: Model<"openai-completions"> = {
  api: "openai-completions",
  provider: "openai",
  id: "test-only",
  name: "Test only",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 128_000,
  maxTokens: 16_000,
};
const prompt = "Return only valid JSON describing the selected color.";
const context: Context = {
  systemPrompt: "Keep supported facts intact.",
  messages: [{ role: "user", content: prompt, timestamp: 1 }],
  tools: [{ name: "publish", description: "Publish content", parameters: Type.Object({}) }],
};

function message(
  text: string,
  tokens = 10,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text }],
    timestamp: 2,
    stopReason,
    ...(stopReason === "error" || stopReason === "aborted"
      ? { errorMessage: "Provider failed" }
      : {}),
    usage: {
      input: tokens,
      output: tokens * 2,
      cacheRead: tokens * 3,
      cacheWrite: tokens * 4,
      totalTokens: tokens * 10,
      cost: {
        input: tokens / 10,
        output: tokens / 5,
        cacheRead: tokens / 3,
        cacheWrite: tokens / 4,
        total: tokens,
      },
    },
  };
}

function completed(value: AssistantMessage, events?: AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  const sent: AssistantMessageEvent[] = events ?? [
    { type: "start", partial: { ...value, content: [] } },
    ...value.content.flatMap((block, contentIndex): AssistantMessageEvent[] =>
      block.type === "text"
        ? [{ type: "text_delta", contentIndex, delta: block.text, partial: value }]
        : [],
    ),
    value.stopReason === "error" || value.stopReason === "aborted"
      ? { type: "error", reason: value.stopReason, error: value }
      : { type: "done", reason: value.stopReason, message: value },
  ];
  for (const event of sent) {
    stream.push(event);
  }
  stream.end();
  return { stream, events: sent };
}

function state(overrides: Partial<ConstructorParameters<typeof DraftVerificationStream>[0]> = {}) {
  return new DraftVerificationStream({
    mode: "repair",
    prompt,
    deadline: Date.now() + 60_000,
    repairAllowed: true,
    ...overrides,
  });
}

async function collect(stream: Awaited<ReturnType<StreamFn>>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, result: await stream.result() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pre-persistence draft stream selection", () => {
  it.each(["off", "shadow"] as const)(
    "%s preserves event identities and makes no extra call",
    async (mode) => {
      const original = message("Not JSON");
      const source = completed(original);
      const inner = vi.fn<StreamFn>(() => source.stream);
      const verification = state({ mode });
      const result = await collect(await verification.wrap(inner)(model, context));
      expect(result.result).toBe(original);
      expect(result.events).toHaveLength(source.events.length);
      result.events.forEach((event, index) => {
        expect(event).toBe(source.events[index]);
      });
      expect(inner).toHaveBeenCalledTimes(1);
      expect(verification.receipt.outcome).toBe(mode === "off" ? "unchecked" : "failed");
      expect(verification.receipt.stop_reason).toBe("stop");
    },
  );

  it("returns only the selected stream/result and keeps actual per-call usage separate", async () => {
    const original = message("The color is teal.", 10);
    const correction = message('{"color":"teal"}', 4);
    const inner = vi
      .fn<StreamFn>()
      .mockImplementationOnce(() => completed(original).stream)
      .mockImplementationOnce(() => completed(correction).stream);
    const verification = state();
    const result = await collect(
      await verification.wrap(inner)(model, context, {
        apiKey: "test-key",
        headers: { "X-Session-Id": "synthetic" },
        maxTokens: 900,
      }),
    );
    expect(result.result).toBe(correction);
    expect(result.events.filter((event) => event.type === "text_delta")).toEqual([
      expect.objectContaining({ delta: '{"color":"teal"}' }),
    ]);
    expect(result.events.at(-1)).toEqual({ type: "done", reason: "stop", message: correction });
    expect(verification.receipt).toMatchObject({
      outcome: "repaired",
      repair_attempts: 1,
      checks: [{ kind: "json_only", status: "pass" }],
    });
    expect(verification.takeAdditionalUsage()).toBe(original.usage);
    expect(verification.takeAdditionalUsage()).toBeUndefined();
    expect(verification.lastProviderUsage).toBe(correction.usage);
    const [repairModel, repairContext, repairOptions] = inner.mock.calls[1];
    expect(repairModel).toMatchObject({ ...model, maxTokens: 900 });
    expect(model.maxTokens).toBe(16_000);
    expect(repairContext.tools).toEqual([]);
    expect(repairContext.systemPrompt).toBe(context.systemPrompt);
    expect(repairContext.messages.slice(0, -2)).toEqual(context.messages);
    expect(repairContext.messages.at(-2)).toBe(original);
    expect(repairOptions).toMatchObject({
      apiKey: "test-key",
      headers: { "X-Session-Id": "synthetic" },
      toolChoice: "none",
      maxRetries: 0,
      maxTokens: 900,
      timeoutMs: 30_000,
    });
    expect(context.messages).toHaveLength(1);
    expect(context.tools).toHaveLength(1);
  });

  it("caps both model and option budgets even when reasoning is enabled", async () => {
    const inner = vi
      .fn<StreamFn>()
      .mockImplementationOnce(() => completed(message("No")).stream)
      .mockImplementationOnce(() => completed(message("{}")).stream);
    await collect(
      await state().wrap(inner)(model, context, { maxTokens: 12_000, reasoning: "high" }),
    );
    expect(inner.mock.calls[1][0].maxTokens).toBe(2_048);
    expect(inner.mock.calls[1][2]).toMatchObject({ maxTokens: 2_048, reasoning: "high" });
  });

  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
    "%s payload guard runs after custom policy, strips native tools and caps actual tokens",
    async (api) => {
      let sent: Record<string, unknown> | undefined;
      const requestModel = { ...model, api };
      const inner = vi
        .fn<StreamFn>()
        .mockImplementationOnce(() => completed(message("No JSON")).stream)
        .mockImplementationOnce(async (repairModel, _repairContext, options) => {
          sent = (await options?.onPayload?.(
            { model: repairModel.id, metadata: { keep: true } },
            repairModel,
          )) as Record<string, unknown>;
          return completed(message("{}")).stream;
        });
      const onPayload = vi.fn(async (payload: unknown) => ({
        ...(payload as Record<string, unknown>),
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        parallel_tool_calls: true,
        functions: [{ name: "publish" }],
        function_call: "auto",
        mcp_servers: [{ name: "native" }],
        web_search_options: {},
        max_tokens: 99_999,
        max_completion_tokens: 99_999,
        max_output_tokens: 99_999,
        store: false,
        service_tier: "default",
      }));
      await collect(await state().wrap(inner)(requestModel, context, { onPayload }));
      expect(onPayload).toHaveBeenCalledTimes(1);
      expect(sent).toMatchObject({
        metadata: { keep: true },
        store: false,
        service_tier: "default",
      });
      for (const key of [
        "tools",
        "parallel_tool_calls",
        "functions",
        "function_call",
        "mcp_servers",
        "web_search_options",
      ]) {
        expect(sent).not.toHaveProperty(key);
      }
      if (api === "anthropic-messages") {
        expect(sent).not.toHaveProperty("tool_choice");
      } else {
        expect(sent?.tool_choice).toBe("none");
      }
      const key =
        api === "openai-responses"
          ? "max_output_tokens"
          : api === "openai-completions"
            ? "max_completion_tokens"
            : "max_tokens";
      expect(sent?.[key]).toBe(2_048);
      expect(
        ["max_tokens", "max_completion_tokens", "max_output_tokens"].filter(
          (entry) => entry in sent!,
        ),
      ).toEqual([key]);
    },
  );

  it("an invalid repair payload callback fails closed without exposing the correction", async () => {
    const original = message("Original");
    const inner = vi
      .fn<StreamFn>()
      .mockImplementationOnce(() => completed(original).stream)
      .mockImplementationOnce(async (repairModel, _context, options) => {
        await options?.onPayload?.({}, repairModel);
        return completed(message("{}")).stream;
      });
    const verification = state();
    const result = await collect(
      await verification.wrap(inner)(model, context, { onPayload: () => [] }),
    );
    expect(result.result).toBe(original);
    expect(verification.receipt.outcome).toBe("repair_failed");
  });

  it.each(["stop", "length", "error", "aborted"] as const)(
    "rejected %s correction never escapes; observed usage/stop remain truthful",
    async (stopReason) => {
      const original = message("Original draft", 11);
      const correction = message("Rejected draft", 3, stopReason);
      const inner = vi
        .fn<StreamFn>()
        .mockImplementationOnce(() => completed(original).stream)
        .mockImplementationOnce(() => completed(correction).stream);
      const verification = state();
      const result = await collect(await verification.wrap(inner)(model, context));
      expect(result.result).toBe(original);
      expect(result.events.filter((event) => event.type === "text_delta")).toEqual([
        expect.objectContaining({ delta: "Original draft" }),
      ]);
      expect(verification.receipt).toMatchObject({
        outcome: "repair_failed",
        repair_attempts: 1,
        stop_reason: stopReason,
      });
      expect(verification.takeAdditionalUsage()).toBe(correction.usage);
      expect(verification.lastProviderUsage).toBe(correction.usage);
    },
  );

  it("real Pi Agent emits and stores only the selected assistant, with one normal terminal", async () => {
    const original = message("Original, not JSON");
    const selected = message('{"color":"teal"}');
    const inner = vi
      .fn<StreamFn>()
      .mockImplementationOnce(() => completed(original).stream)
      .mockImplementationOnce(() => completed(selected).stream);
    const agent = new Agent({
      initialState: { model, systemPrompt: context.systemPrompt },
      streamFn: state().wrap(inner),
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
      events.push(event);
    });
    await agent.prompt(prompt);
    expect(agent.state.messages.filter((item) => item.role === "assistant")).toEqual([selected]);
    expect(
      events.filter((event) => event.type === "message_end" && event.message.role === "assistant"),
    ).toEqual([{ type: "message_end", message: selected }]);
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Original, not JSON");
  });

  it("a tool-call correction cannot execute or enter Pi Agent history", async () => {
    const original = message("Original draft");
    const malicious = {
      ...message("{}"),
      content: [{ type: "toolCall" as const, id: "call-1", name: "publish", arguments: {} }],
    };
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const inner = vi
      .fn<StreamFn>()
      .mockImplementationOnce(() => completed(original).stream)
      .mockImplementationOnce(() => completed(malicious).stream);
    const verification = state();
    const agent = new Agent({
      initialState: { model, tools: [{ ...context.tools![0], label: "Publish", execute }] },
      streamFn: verification.wrap(inner),
    });
    await agent.prompt(prompt);
    expect(execute).not.toHaveBeenCalled();
    expect(verification.hadToolActivity).toBe(true);
    expect(agent.state.messages.filter((item) => item.role === "assistant")).toEqual([original]);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("any observed tool activity excludes later correction in the same outer run", async () => {
    const tool = {
      ...message(""),
      stopReason: "toolUse" as const,
      content: [{ type: "toolCall" as const, id: "call-1", name: "publish", arguments: {} }],
    };
    const inner = vi
      .fn<StreamFn>()
      .mockImplementationOnce(() => completed(tool).stream)
      .mockImplementationOnce(() => completed(message("No JSON")).stream);
    const verification = state();
    const wrapped = verification.wrap(inner);
    expect((await collect(await wrapped(model, context))).result).toBe(tool);
    await collect(await wrapped(model, context));
    expect(inner).toHaveBeenCalledTimes(2);
    expect(verification.receipt).toMatchObject({ outcome: "excluded", repair_attempts: 0 });
  });

  it("has one correction budget across all lower attempts and resets last provider usage", async () => {
    const inner = vi.fn<StreamFn>(() => completed(message("Still not JSON")).stream);
    const verification = state();
    await collect(await verification.wrap(inner)(model, context));
    await collect(await verification.wrap(inner)(model, context));
    expect(inner).toHaveBeenCalledTimes(3);
    expect(verification.receipt.repair_attempts).toBe(1);
  });

  it("never repairs a follow-up after the first selected answer was released", async () => {
    const inner = vi
      .fn<StreamFn>()
      .mockImplementationOnce(() => completed(message("{}")).stream)
      .mockImplementationOnce(() => completed(message("Follow-up, not JSON")).stream);
    const verification = state();
    await collect(await verification.wrap(inner)(model, context));
    await collect(await verification.wrap(inner)(model, context));
    expect(inner).toHaveBeenCalledTimes(2);
    expect(verification.receipt).toMatchObject({ outcome: "excluded", repair_attempts: 0 });
  });

  it.each(["error", "aborted", "length"] as const)(
    "preserves original %s terminal without correction",
    async (stopReason) => {
      const original = message("Original partial", 10, stopReason);
      const inner = vi.fn<StreamFn>(() => completed(original).stream);
      const verification = state();
      const result = await collect(await verification.wrap(inner)(model, context));
      expect(result.result).toBe(original);
      expect(result.events.at(-1)?.type).toBe(stopReason === "length" ? "done" : "error");
      expect(verification.receipt.stop_reason).toBe(stopReason);
      expect(inner).toHaveBeenCalledTimes(1);
    },
  );

  it("oversized output remains unchanged/unknown with no extra call", async () => {
    const original = message("x".repeat(MAX_DRAFT_CHARS + 1));
    const inner = vi.fn<StreamFn>(() => completed(original).stream);
    const verification = state();
    expect((await collect(await verification.wrap(inner)(model, context))).result).toBe(original);
    expect(verification.receipt.checks).toEqual([{ kind: "json_only", status: "unknown" }]);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it.each([
    message("MEDIA:https://example.invalid/file.png\nNot JSON"),
    message("[[audio_as_voice]] Not JSON"),
    {
      ...message("Not JSON"),
      content: [
        {
          type: "text" as const,
          text: "Not JSON",
          textSignature: '{"v":1,"id":"item","phase":"commentary"}',
        },
      ],
    },
    {
      ...message("First"),
      content: [
        { type: "text" as const, text: "First" },
        { type: "text" as const, text: "Second" },
      ],
    },
  ])("does not repair media, commentary or multi-text responses", async (original) => {
    const inner = vi.fn<StreamFn>(() => completed(original).stream);
    const verification = state();
    expect((await collect(await verification.wrap(inner)(model, context))).result).toBe(original);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(verification.receipt.checks).toEqual([{ kind: "json_only", status: "unknown" }]);
  });

  it.each([{ repairAllowed: false }, { maxRepairMs: 1_000 }])(
    "attempt-level restrictions cannot be widened (%j)",
    async (restriction) => {
      const inner = vi.fn<StreamFn>(() => completed(message("No JSON")).stream);
      const verification = state();
      await collect(await verification.wrap(inner, restriction)(model, context));
      expect(inner).toHaveBeenCalledTimes(1);
      expect(verification.receipt.outcome).toBe("excluded");
    },
  );

  it("globally excluded runs cannot be re-enabled by an attempt", async () => {
    const inner = vi.fn<StreamFn>(() => completed(message("No JSON")).stream);
    await collect(
      await state({ repairAllowed: false }).wrap(inner, { repairAllowed: true })(model, context),
    );
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it.each([
    { transport: "websocket" },
    { cachedContent: "cache" },
    { tools: [{ type: "web_search" }] },
  ])("excludes cached/native/non-HTTP option surfaces (%j)", async (options) => {
    const inner = vi.fn<StreamFn>(() => completed(message("No JSON")).stream);
    await collect(await state().wrap(inner)(model, context, options as Parameters<StreamFn>[2]));
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("passes valid complete HTML unchanged for an unsupported request", async () => {
    const original = message("<!doctype html><html><body>Unchanged</body></html>");
    const inner = vi.fn<StreamFn>(() => completed(original).stream);
    const result = await collect(
      await state({ prompt: "Make a complete HTML document." }).wrap(inner)(model, context),
    );
    expect(result.result).toBe(original);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it.each(["creation", "iteration", "result"] as const)(
    "bounds repair %s even when transport ignores abort",
    async (phase) => {
      vi.useFakeTimers();
      let repairSignal: AbortSignal | undefined;
      const hanging = createAssistantMessageEventStream();
      if (phase === "result") {
        hanging.end();
      }
      const inner = vi
        .fn<StreamFn>()
        .mockImplementationOnce(() => completed(message("Original")).stream)
        .mockImplementationOnce((_model, _context, options) => {
          repairSignal = options?.signal;
          return phase === "creation" ? new Promise(() => {}) : hanging;
        });
      const verification = state({ maxRepairMs: 2_000 });
      const pending = collect(await verification.wrap(inner)(model, context));
      await vi.advanceTimersByTimeAsync(2_001);
      const result = await pending;
      expect(repairSignal?.aborted).toBe(true);
      expect(result.result.content).toEqual([{ type: "text", text: "Original" }]);
      expect(verification.receipt).toMatchObject({
        outcome: "repair_failed",
        repair_attempts: 1,
        stop_reason: null,
      });
      expect(verification.takeAdditionalUsage()).toBeUndefined();
      expect(inner).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["constructor", "call"] as const)(
    "%s parent cancellation suppresses original and rejected partials",
    async (source) => {
      const abort = new AbortController();
      let started!: () => void;
      const repairStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const hanging = createAssistantMessageEventStream();
      const inner = vi
        .fn<StreamFn>()
        .mockImplementationOnce(() => completed(message("Original")).stream)
        .mockImplementationOnce(() => {
          started();
          return hanging;
        });
      const verification = state(source === "constructor" ? { abortSignal: abort.signal } : {});
      const pending = collect(
        await verification.wrap(inner)(
          model,
          context,
          source === "call" ? { signal: abort.signal } : {},
        ),
      );
      await repairStarted;
      abort.abort();
      const result = await pending;
      expect(result.result.stopReason).toBe("aborted");
      expect(result.result.content).toEqual([]);
      expect(result.events.filter((event) => event.type === "text_delta")).toEqual([]);
      expect(result.events.at(-1)?.type).toBe("error");
      expect(verification.receipt.stop_reason).toBe("aborted");
      const usage = verification.lastProviderUsage;
      hanging.push({ type: "done", reason: "stop", message: message('{"late":true}', 99) });
      hanging.end();
      await Promise.resolve();
      await Promise.resolve();
      expect(verification.lastProviderUsage).toBe(usage);
    },
  );

  it("never starts a call after parent cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const inner = vi.fn<StreamFn>(() => completed(message("Never deliver")).stream);
    const result = await collect(
      await state({ abortSignal: abort.signal }).wrap(inner)(model, context),
    );
    expect(inner).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ stopReason: "aborted", content: [] });
  });

  it("correction cannot extend the original outer-run deadline", async () => {
    vi.useFakeTimers();
    const inner = vi
      .fn<StreamFn>()
      .mockImplementationOnce(() => completed(message("Original")).stream)
      .mockImplementationOnce(() => createAssistantMessageEventStream());
    const verification = state({ deadline: Date.now() + 1_500 });
    const pending = collect(await verification.wrap(inner)(model, context));
    await vi.advanceTimersByTimeAsync(1_501);
    expect((await pending).result.content).toEqual([{ type: "text", text: "Original" }]);
    expect(inner.mock.calls[1][2]?.timeoutMs).toBe(1_500);
  });

  it("encodes thrown original stream failures instead of rejecting or hanging", async () => {
    const inner = vi.fn<StreamFn>(() => {
      throw new Error("Private provider failure");
    });
    const verification = state();
    const result = await collect(await verification.wrap(inner)(model, context));
    expect(result.result).toMatchObject({
      stopReason: "error",
      content: [],
      errorMessage: "Provider stream failed",
    });
    expect(verification.receipt.stop_reason).toBeNull();
    expect(verification.lastProviderUsage).toBeUndefined();
  });
});
