import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../../infra/agent-events.js";
import type { DraftVerificationStream } from "../draft-verification-stream.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  mockedPickFallbackThinkingLevel,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
const model: Model<"anthropic-messages"> = {
  id: "test-model",
  name: "test-model",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(text: string, tokens: number): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: tokens,
      output: tokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens * 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("Pi draft stream integration", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });
  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockImplementation(({ assistantTexts }) =>
      assistantTexts.map((text) => ({ text })),
    );
  });

  it.each(["summary", "throws"])(
    "does not reuse earlier verification for a finalizer that %s",
    async (kind) => {
      let verification: DraftVerificationStream | undefined;
      const terminals: Record<string, unknown>[] = [];
      const unsubscribe = onAgentEvent((event) => {
        if (event.runId === overflowBaseRunParams.runId && event.stream === "lifecycle") {
          terminals.push(event.data);
        }
      });
      mockedPickFallbackThinkingLevel.mockReturnValue("low");
      mockedRunEmbeddedAttempt.mockImplementation(async (raw) => {
        const params = raw as EmbeddedRunAttemptParams;
        if (mockedRunEmbeddedAttempt.mock.calls.length <= 32) {
          verification = params.draftVerification;
          expect(verification?.receipt.stop_reason).toBeNull();
          expect(verification?.receipt.checks).toEqual([]);
          expect(verification?.lastProviderUsage).toBeUndefined();
          if (!verification) {
            throw new Error("missing test verifier");
          }
          verification.lastProviderUsage = message("earlier", 7).usage;
          verification.receipt.stop_reason = "stop";
          verification.receipt.outcome = "passed";
          verification.receipt.checks = [{ kind: "json_only", status: "pass" }];
          return makeAttemptResult({
            promptError: new Error("unsupported reasoning mode"),
            lastAssistant: message("earlier", 7),
          });
        }
        expect(params.draftVerification).toBeUndefined();
        expect(verification?.receipt).toMatchObject({
          outcome: "excluded",
          checks: [],
          stop_reason: null,
        });
        expect(verification?.lastProviderUsage).toBeUndefined();
        if (kind === "throws") {
          throw new Error("finalizer unavailable");
        }
        return makeAttemptResult({
          assistantTexts: ["partial summary"],
          lastAssistant: { ...message("partial summary", 11), stopReason: "length" },
        });
      });
      try {
        const result = await runEmbeddedPiAgent({
          ...overflowBaseRunParams,
          prompt: "Return only JSON.",
          isFinalFallbackCandidate: true,
          config: {
            tools: {
              draftVerification: { mode: "shadow" },
              loopDetection: { runtimeResilience: { enabled: true } },
            },
          },
        });
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(33);
        expect(result.meta.error?.kind).toBe("retry_limit");
        expect(terminals.at(-1)).toMatchObject({
          phase: "error",
          draftVerification: {
            outcome: "excluded",
            checks: [],
            stop_reason: kind === "summary" ? "length" : null,
          },
        });
        if (kind === "summary") {
          expect(result.meta.agentMeta?.promptTokens).toBe(11);
          expect(result.meta.agentMeta?.usage).toMatchObject({ input: 32 * 7 + 11 });
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it.each(["off", "shadow", "repair", "rejected"] as const)(
    "%s keeps normal attempt lifecycle and truthful usage",
    async (kind) => {
      const provider = vi.fn(() => {
        const stream = createAssistantMessageEventStream();
        const secondCall = provider.mock.calls.length === 2;
        const assistant = message(
          secondCall && kind === "repair" ? '{"ok":true}' : "not JSON",
          secondCall ? 11 : 7,
        );
        stream.push({ type: "start", partial: assistant });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: assistant.content[0].type === "text" ? assistant.content[0].text : "",
          partial: assistant,
        });
        stream.push({ type: "done", reason: "stop", message: assistant });
        return stream;
      });
      mockedRunEmbeddedAttempt.mockImplementation(async (raw) => {
        const params = raw as EmbeddedRunAttemptParams;
        expect(params.suppressAssistantDelivery).toBe(false);
        expect(params.suppressLifecycleTerminal).toBe(false);
        const streamFn = params.draftVerification?.wrap(provider) ?? provider;
        const stream = await streamFn(model, {
          messages: [{ role: "user", content: "Return only JSON.", timestamp: 1 }],
        });
        for await (const _event of stream) {
          /* drain the real provider event protocol */
        }
        const assistant = await stream.result();
        return makeAttemptResult({
          lastAssistant: assistant,
          assistantTexts: assistant.content.flatMap((block) =>
            block.type === "text" ? [block.text] : [],
          ),
        });
      });
      const mode = kind === "rejected" ? "repair" : kind;
      const result = await runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        prompt: "Return only JSON.",
        config: { tools: { draftVerification: { mode } } },
      });
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      expect(provider).toHaveBeenCalledTimes(mode === "repair" ? 2 : 1);
      expect(result.payloads?.[0].text).toBe(kind === "repair" ? '{"ok":true}' : "not JSON");
      expect(result.meta.agentMeta?.usage).toMatchObject({
        input: mode === "repair" ? 18 : 7,
        output: mode === "repair" ? 18 : 7,
      });
      expect(result.meta.agentMeta?.lastCallUsage).toMatchObject({
        input: mode === "repair" ? 11 : 7,
      });
      if (mode === "off") {
        expect(result.meta.draftVerification).toBeUndefined();
      } else {
        expect(result.meta.draftVerification).toMatchObject({
          mode,
          outcome:
            kind === "rejected" ? "repair_failed" : kind === "repair" ? "repaired" : "failed",
        });
      }
    },
  );
});
