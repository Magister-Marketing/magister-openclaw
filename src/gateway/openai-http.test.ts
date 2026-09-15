import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "../agents/pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "../agents/pi-embedded-subscribe.js";
import { HISTORY_CONTEXT_MARKER } from "../auto-reply/reply/history.js";
import { CURRENT_MESSAGE_MARKER } from "../auto-reply/reply/mentions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { buildAssistantDeltaResult } from "./test-helpers.agent-results.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let enabledServer: Awaited<ReturnType<typeof startServer>>;
let enabledPort: number;

beforeAll(async () => {
  ({ startGatewayServer } = await import("./server.js"));
  const started = await startGatewayServerWithRetries({
    port: await getFreePort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
    },
  });
  enabledPort = started.port;
  enabledServer = started.server;
});

afterAll(async () => {
  await enabledServer?.close({ reason: "openai http enabled suite done" });
});

async function startServer(port: number, opts?: { openAiChatCompletionsEnabled?: boolean }) {
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "none" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? true,
  });
}

async function startTokenServer(port: number, opts?: { openAiChatCompletionsEnabled?: boolean }) {
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? true,
  });
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway config tests");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function postChatCompletions(port: number, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return res;
}

function parseSseDataLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

describe("OpenAI-compatible HTTP API (e2e)", () => {
  it("handles request validation and routing", async () => {
    const port = enabledPort;
    const mockAgentOnce = (payloads: Array<{ text: string }>) => {
      agentCommand.mockClear();
      agentCommand.mockResolvedValueOnce({ payloads } as never);
    };
    const expectAgentSessionKeyMatch = async (request: {
      body: unknown;
      headers?: Record<string, string>;
      matcher: RegExp;
    }) => {
      mockAgentOnce([{ text: "hello" }]);
      const res = await postChatCompletions(port, request.body, request.headers);
      expect(res.status).toBe(200);
      expect(agentCommand).toHaveBeenCalledTimes(1);
      const opts = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
      expect((opts as { sessionKey?: string } | undefined)?.sessionKey ?? "").toMatch(
        request.matcher,
      );
      await res.text();
    };
    const expectMessageContext = (
      message: string,
      expected: { history: string[]; current: string[] },
    ) => {
      expect(message).toContain(HISTORY_CONTEXT_MARKER);
      for (const line of expected.history) {
        expect(message).toContain(line);
      }
      expect(message).toContain(CURRENT_MESSAGE_MARKER);
      for (const line of expected.current) {
        expect(message).toContain(line);
      }
    };
    const getFirstAgentCall = () =>
      (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
        | {
            sessionKey?: string;
            messageChannel?: string;
            message?: string;
            extraSystemPrompt?: string;
            images?: Array<{ type: string; data: string; mimeType: string }>;
            senderIsOwner?: boolean;
          }
        | undefined;
    const getFirstAgentMessage = () => getFirstAgentCall()?.message ?? "";
    const expectInvalidRequestNoDispatch = async (messages: unknown[]) => {
      agentCommand.mockClear();
      const res = await postChatCompletions(port, {
        model: "openclaw",
        messages,
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect((json.error as Record<string, unknown> | undefined)?.type).toBe(
        "invalid_request_error",
      );
      expect(agentCommand).toHaveBeenCalledTimes(0);
    };
    const postSyncUserMessage = async (message: string) => {
      const res = await postChatCompletions(port, {
        stream: false,
        model: "openclaw",
        messages: [{ role: "user", content: message }],
      });
      expect(res.status).toBe(200);
      expect(getFirstAgentCall()?.senderIsOwner).toBe(false);
      return (await res.json()) as Record<string, unknown>;
    };

    try {
      {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "GET",
          headers: { authorization: "Bearer secret" },
        });
        expect(res.status).toBe(405);
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        expect(agentCommand).toHaveBeenCalledTimes(1);
        expect(getFirstAgentCall()?.messageChannel).toBe("webchat");
        await res.text();
      }

      await expectAgentSessionKeyMatch({
        body: { model: "openclaw", messages: [{ role: "user", content: "hi" }] },
        headers: { "x-openclaw-agent-id": "beta" },
        matcher: /^agent:beta:/,
      });

      await expectAgentSessionKeyMatch({
        body: {
          model: "openclaw/beta",
          messages: [{ role: "user", content: "hi" }],
        },
        matcher: /^agent:beta:/,
      });

      await expectAgentSessionKeyMatch({
        body: {
          model: "openclaw/default",
          messages: [{ role: "user", content: "hi" }],
        },
        matcher: /^agent:main:/,
      });

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          { model: "openclaw", messages: [{ role: "user", content: "hi" }] },
          {
            "x-openclaw-agent-id": "beta",
            "x-openclaw-session-key": "agent:beta:openai:custom",
          },
        );
        expect(res.status).toBe(200);

        const opts = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
        expect((opts as { sessionKey?: string } | undefined)?.sessionKey).toBe(
          "agent:beta:openai:custom",
        );
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          user: "alice",
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(200);

        const opts = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
        expect((opts as { sessionKey?: string } | undefined)?.sessionKey ?? "").toContain(
          "openai-user:alice",
        );
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          {
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          { "x-openclaw-message-channel": "custom-client-channel" },
        );
        expect(res.status).toBe(200);
        expect(getFirstAgentCall()?.messageChannel).toBe("custom-client-channel");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          {
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          {
            "x-openclaw-model": "openai/gpt-5.4",
          },
        );
        expect(res.status).toBe(200);
        const opts = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
        expect((opts as { model?: string } | undefined)?.model).toBe("openai/gpt-5.4");
        await res.text();
      }

      {
        await writeGatewayConfig({
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.4" },
              models: {
                "openai/gpt-5.4": {},
              },
            },
          },
        });
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(
          port,
          {
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          {
            "x-openclaw-model": "gpt-5.4",
          },
        );
        expect(res.status).toBe(200);
        const opts = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
        expect((opts as { model?: string } | undefined)?.model).toBe("gpt-5.4");
        await res.text();
        await writeGatewayConfig({});
      }

      {
        agentCommand.mockClear();
        const res = await postChatCompletions(port, {
          model: "openai/",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe(
          "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
        );
        expect(agentCommand).toHaveBeenCalledTimes(0);
      }

      {
        agentCommand.mockClear();
        const res = await postChatCompletions(
          port,
          {
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          },
          { "x-openclaw-model": "openai/" },
        );
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error?: { type?: string; message?: string } };
        expect(json.error?.type).toBe("invalid_request_error");
        expect(json.error?.message).toBe("Invalid `x-openclaw-model`.");
        expect(agentCommand).toHaveBeenCalledTimes(0);
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hello" },
                { type: "input_text", text: "world" },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        const opts = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0];
        expect((opts as { message?: string } | undefined)?.message).toBe("hello\nworld");
        await res.text();
      }

      {
        const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA";
        mockAgentOnce([{ text: "looks good" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe this" },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${imageData}` },
                },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.message).toBe("describe this");
        expect(firstCall?.images).toEqual([
          { type: "image", data: imageData, mimeType: "image/png" },
        ]);
        await res.text();
      }

      {
        const imageData = "QUJDRA==";
        mockAgentOnce([{ text: "supports data-uri params" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "with metadata params" },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;charset=utf-8;base64,${imageData}` },
                },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.images).toEqual([
          { type: "image", data: imageData, mimeType: "image/png" },
        ]);
        await res.text();
      }

      await expectInvalidRequestNoDispatch([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/image.png" },
            },
          ],
        },
      ]);

      {
        mockAgentOnce([{ text: "I can see the image" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "data:image/jpeg;base64,QUJDRA==" },
                },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.message).toContain("User sent image(s) with no text.");
        expect(firstCall?.images).toEqual([
          { type: "image", data: "QUJDRA==", mimeType: "image/jpeg" },
        ]);
        await res.text();
      }

      {
        mockAgentOnce([{ text: "follow up answer" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } },
              ],
            },
            { role: "assistant", content: "I can see it." },
            { role: "user", content: "What color was it?" },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.images).toBeUndefined();
        expect(firstCall?.message ?? "").not.toContain("User sent image(s) with no text.");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "latest image only" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "first" },
                { type: "image_url", image_url: { url: "data:image/png;base64,QUFBQQ==" } },
              ],
            },
            { role: "assistant", content: "noted" },
            {
              role: "user",
              content: [
                { type: "text", text: "second" },
                { type: "image_url", image_url: { url: "data:image/png;base64,QkJCQg==" } },
              ],
            },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.images).toEqual([
          { type: "image", data: "QkJCQg==", mimeType: "image/png" },
        ]);
        await res.text();
      }

      {
        const largeMessage = "x".repeat(1_200_000);
        mockAgentOnce([{ text: "accepted" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [{ role: "user", content: largeMessage }],
        });
        expect(res.status).toBe(200);
        await res.text();
      }

      await expectInvalidRequestNoDispatch([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:application/pdf;base64,QUJDRA==" },
            },
          ],
        },
      ]);

      {
        const manyImageParts = Array.from({ length: 9 }).map(() => ({
          type: "image_url",
          image_url: { url: "data:image/png;base64,QUJDRA==" },
        }));
        await expectInvalidRequestNoDispatch([
          {
            role: "user",
            content: manyImageParts,
          },
        ]);
      }

      {
        mockAgentOnce([{ text: "I am Claude" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello, who are you?" },
            { role: "assistant", content: "I am Claude." },
            { role: "user", content: "What did I just ask you?" },
          ],
        });
        expect(res.status).toBe(200);

        const message = getFirstAgentMessage();
        expectMessageContext(message, {
          history: ["User: Hello, who are you?", "Assistant: I am Claude."],
          current: ["User: What did I just ask you?"],
        });
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello" },
          ],
        });
        expect(res.status).toBe(200);

        const message = getFirstAgentMessage();
        expect(message).not.toContain(HISTORY_CONTEXT_MARKER);
        expect(message).not.toContain(CURRENT_MESSAGE_MARKER);
        expect(message).toBe("Hello");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "developer", content: "You are a helpful assistant." },
            { role: "user", content: "Hello" },
          ],
        });
        expect(res.status).toBe(200);

        const extraSystemPrompt = getFirstAgentCall()?.extraSystemPrompt ?? "";
        expect(extraSystemPrompt).toBe("You are a helpful assistant.");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "ok" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "What's the weather?" },
            { role: "assistant", content: "Checking the weather." },
            { role: "tool", content: "Sunny, 70F." },
          ],
        });
        expect(res.status).toBe(200);

        const message = getFirstAgentMessage();
        expectMessageContext(message, {
          history: ["User: What's the weather?", "Assistant: Checking the weather."],
          current: ["Tool: Sunny, 70F."],
        });
        await res.text();
      }

      {
        mockAgentOnce([{ text: "tool follow-up ok" }]);
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look at this" },
                { type: "image_url", image_url: { url: "https://example.com/image.png" } },
              ],
            },
            { role: "assistant", content: "Checking the image." },
            { role: "tool", content: "Vision tool says it is blue." },
          ],
        });
        expect(res.status).toBe(200);

        const firstCall = getFirstAgentCall();
        expect(firstCall?.images).toBeUndefined();
        const message = getFirstAgentMessage();
        expectMessageContext(message, {
          history: ["User: look at this", "Assistant: Checking the image."],
          current: ["Tool: Vision tool says it is blue."],
        });
        expect(message).not.toContain("User sent image(s) with no text.");
        await res.text();
      }

      {
        mockAgentOnce([{ text: "hello" }]);
        const json = await postSyncUserMessage("hi");
        expect(json.object).toBe("chat.completion");
        expect(Array.isArray(json.choices)).toBe(true);
        const choice0 = (json.choices as Array<Record<string, unknown>>)[0] ?? {};
        const msg = (choice0.message as Record<string, unknown> | undefined) ?? {};
        expect(msg.role).toBe("assistant");
        expect(msg.content).toBe("hello");
      }

      {
        agentCommand.mockClear();
        agentCommand.mockImplementationOnce((async (opts: unknown) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          const { session, emit } = createStubSessionHarness();
          subscribeEmbeddedPiSession({ session, runId });
          emit({ type: "message_start", message: { role: "assistant" } });
          for (const delta of ["<", "final>Title\n", "Line one\nLine two</", "final>"]) {
            emitAssistantTextDelta({ emit, delta });
          }
          return { payloads: [{ text: "Title\nLine one\nLine two" }] };
        }) as never);

        const splitFinalRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(splitFinalRes.status).toBe(200);
        const splitFinalText = await splitFinalRes.text();
        const splitFinalData = parseSseDataLines(splitFinalText);
        const splitFinalChunks = splitFinalData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const splitFinalContent = splitFinalChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
          .filter((v): v is string => typeof v === "string")
          .join("");
        expect(splitFinalContent).toBe("Title\nLine one\nLine two");
        expect(splitFinalContent).not.toContain("<");
        expect(splitFinalContent).not.toContain("final>");
      }

      {
        agentCommand.mockClear();
        agentCommand.mockResolvedValueOnce({
          payloads: [{ text: "usage basic" }],
          meta: {
            agentMeta: {
              usage: {
                input: 42,
                output: 17,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 42,
          completion_tokens: 17,
          total_tokens: 59,
        });
      }

      {
        agentCommand.mockClear();
        agentCommand.mockResolvedValueOnce({
          payloads: [{ text: "usage cache" }],
          meta: {
            agentMeta: {
              usage: {
                input: 10,
                output: 5,
                cacheRead: 20,
                cacheWrite: 3,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 30,
          completion_tokens: 5,
          total_tokens: 35,
        });
      }

      {
        agentCommand.mockClear();
        agentCommand.mockResolvedValueOnce({
          payloads: [{ text: "usage total" }],
          meta: {
            agentMeta: {
              usage: {
                input: 10,
                output: 5,
                total: 100,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 100,
        });
      }

      {
        agentCommand.mockClear();
        agentCommand.mockResolvedValueOnce({
          payloads: [{ text: "usage total only" }],
          meta: {
            agentMeta: {
              usage: {
                total: 123,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 123,
        });
      }

      {
        agentCommand.mockClear();
        agentCommand.mockResolvedValueOnce({
          payloads: [{ text: "usage non-finite" }],
          meta: {
            agentMeta: {
              usage: {
                input: Number.POSITIVE_INFINITY,
                output: Number.NaN,
                cacheRead: 2,
                cacheWrite: Number.POSITIVE_INFINITY,
                total: Number.NaN,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 2,
          completion_tokens: 0,
          total_tokens: 2,
        });
      }

      {
        agentCommand.mockClear();
        agentCommand.mockResolvedValueOnce({
          payloads: [{ text: "usage non-finite aggregate fallback" }],
          meta: {
            agentMeta: {
              usage: {
                input: Number.POSITIVE_INFINITY,
                output: Number.NaN,
                total: 123,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 123,
        });
      }

      {
        agentCommand.mockClear();
        agentCommand.mockResolvedValueOnce({
          payloads: [{ text: "usage cache-write only" }],
          meta: {
            agentMeta: {
              usage: {
                cacheWrite: 10,
                total: 10,
              },
            },
          },
        } as never);
        const json = await postSyncUserMessage("usage");
        expect(json.usage).toEqual({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 10,
        });
      }

      {
        agentCommand.mockClear();
        agentCommand.mockResolvedValueOnce({ payloads: [{ text: "" }] } as never);
        const json = await postSyncUserMessage("hi");
        const choice0 = (json.choices as Array<Record<string, unknown>>)[0] ?? {};
        const msg = (choice0.message as Record<string, unknown> | undefined) ?? {};
        expect(msg.content).toBe("No response from OpenClaw.");
      }

      {
        const res = await postChatCompletions(port, {
          model: "openclaw",
          messages: [{ role: "system", content: "yo" }],
        });
        expect(res.status).toBe(400);
        const missingUserJson = (await res.json()) as Record<string, unknown>;
        expect((missingUserJson.error as Record<string, unknown> | undefined)?.type).toBe(
          "invalid_request_error",
        );
      }
    } finally {
      // shared server
    }
  });

  it("returns 429 for repeated failed auth when gateway.auth.rateLimit is configured", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: { maxAttempts: 1, windowMs: 60_000, lockoutMs: 60_000, exemptLoopback: false },
    } as any;
    await withGatewayServer(
      async ({ port }) => {
        const headers = {
          "content-type": "application/json",
          authorization: "Bearer wrong",
        };
        const body = {
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        };

        const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(first.status).toBe(401);

        const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(second.status).toBe(429);
        expect(second.headers.get("retry-after")).toBeTruthy();
      },
      {
        serverOptions: {
          host: "127.0.0.1",
          controlUiEnabled: false,
          openAiChatCompletionsEnabled: true,
        },
      },
    );
  });

  it("streams SSE chunks when stream=true", async () => {
    const port = enabledPort;
    try {
      {
        agentCommand.mockClear();
        agentCommand.mockImplementationOnce((async (opts: unknown) =>
          buildAssistantDeltaResult({
            opts,
            emit: emitAgentEvent,
            deltas: ["he", "llo"],
            text: "hello",
          })) as never);

        const res = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

        const text = await res.text();
        const data = parseSseDataLines(text);
        expect(data[data.length - 1]).toBe("[DONE]");

        const jsonChunks = data
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        expect(jsonChunks.some((c) => c.object === "chat.completion.chunk")).toBe(true);
        const allContent = jsonChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
          .filter((v): v is string => typeof v === "string")
          .join("");
        expect(allContent).toBe("hello");
        const usageChunks = jsonChunks.filter((c) => "usage" in c);
        expect(usageChunks).toHaveLength(0);
      }

      {
        agentCommand.mockClear();
        agentCommand.mockImplementationOnce((async (opts: unknown) =>
          buildAssistantDeltaResult({
            opts,
            emit: emitAgentEvent,
            deltas: ["hi", "hi"],
            text: "hihi",
          })) as never);

        const repeatedRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(repeatedRes.status).toBe(200);
        const repeatedText = await repeatedRes.text();
        const repeatedData = parseSseDataLines(repeatedText);
        const repeatedChunks = repeatedData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const repeatedContent = repeatedChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
          .filter((v): v is string => typeof v === "string")
          .join("");
        expect(repeatedContent).toBe("hihi");
      }

      {
        agentCommand.mockClear();
        agentCommand.mockResolvedValueOnce({
          payloads: [{ text: "hello" }],
        } as never);

        const fallbackRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(fallbackRes.status).toBe(200);
        const fallbackText = await fallbackRes.text();
        expect(fallbackText).toContain("[DONE]");
        expect(fallbackText).toContain("hello");
      }

      {
        agentCommand.mockClear();
        agentCommand.mockRejectedValueOnce(new Error("boom"));

        const errorRes = await postChatCompletions(port, {
          stream: true,
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(errorRes.status).toBe(200);
        const errorText = await errorRes.text();
        const errorData = parseSseDataLines(errorText);
        expect(errorData[errorData.length - 1]).toBe("[DONE]");

        const errorChunks = errorData
          .filter((d) => d !== "[DONE]")
          .map((d) => JSON.parse(d) as Record<string, unknown>);
        const stopChoice = errorChunks
          .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
          .find((choice) => choice.finish_reason === "stop");
        expect(stopChoice).toBeDefined();
        expect(errorText).toContain("event: error");
        expect(errorText).toContain('"code":"terminal_result_error"');
        expect(errorText).not.toContain("Error: internal error");
      }
    } finally {
      // shared server
    }
  });

  it(
    "sends an initial SSE chunk before a streaming agent run settles",
    { timeout: 15_000 },
    async () => {
      const port = enabledPort;
      let serverAbortSignal: AbortSignal | undefined;

      agentCommand.mockClear();
      agentCommand.mockImplementationOnce(
        (opts: unknown) =>
          new Promise<undefined>((resolve) => {
            const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            serverAbortSignal = signal;
            if (signal?.aborted) {
              resolve(undefined);
              return;
            }
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      );

      let settled = false;
      const firstChunk = new Promise<string>((resolve, reject) => {
        const clientReq = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer secret",
            },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"] ?? "").toContain("text/event-stream");
            res.setEncoding("utf8");
            res.once("data", (chunk) => {
              settled = true;
              resolve(String(chunk));
              clientReq.destroy();
            });
          },
        );
        clientReq.on("error", (err) => {
          if (!settled) {
            reject(err);
          }
        });
        clientReq.setTimeout(2_000, () => {
          if (!settled) {
            settled = true;
            clientReq.destroy(new Error("timed out waiting for first SSE chunk"));
          }
        });
        clientReq.end(
          JSON.stringify({
            stream: true,
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          }),
        );
      });

      await expect(firstChunk).resolves.toContain('"role":"assistant"');
      await vi.waitFor(() => {
        expect(agentCommand).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(
        () => {
          expect(serverAbortSignal?.aborted).toBe(true);
        },
        { timeout: 5_000, interval: 50 },
      );
    },
  );

  it("includes usage in final stream chunk when stream_options.include_usage=true", async () => {
    const port = enabledPort;
    agentCommand.mockClear();
    agentCommand.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "he" } });
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "llo" } });
      return {
        payloads: [{ text: "hello" }],
        meta: {
          agentMeta: {
            usage: {
              input: 12,
              output: 5,
              cacheRead: 3,
              cacheWrite: 0,
              total: 20,
            },
          },
        },
      };
    }) as never);

    const res = await postChatCompletions(port, {
      stream: true,
      stream_options: { include_usage: true },
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
    const jsonChunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);

    const usageChunk = jsonChunks.find((chunk) => "usage" in chunk);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 5,
      total_tokens: 20,
    });
    expect(usageChunk?.choices).toEqual([]);
  });

  it("keeps aggregate-only usage total in final stream usage chunk", async () => {
    const port = enabledPort;
    agentCommand.mockClear();
    agentCommand.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
      emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
      return {
        payloads: [{ text: "hello" }],
        meta: {
          agentMeta: {
            usage: {
              total: 123,
            },
          },
        },
      };
    }) as never);

    const res = await postChatCompletions(port, {
      stream: true,
      stream_options: { include_usage: true },
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
    const jsonChunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    const usageChunk = jsonChunks.find((chunk) => "usage" in chunk);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 123,
    });
  });

  it.each([false, true])(
    "keeps a final non-streamed answer after lifecycle end (usage=%s)",
    async (usage) => {
      agentCommand.mockClear();
      agentCommand.mockImplementationOnce((async (opts: unknown) => {
        const runId = (opts as { runId: string }).runId;
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { payloads: [{ text: "Recovered final answer" }], meta: {} };
      }) as never);
      const response = await postChatCompletions(enabledPort, {
        stream: true,
        ...(usage ? { stream_options: { include_usage: true } } : {}),
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      const text = await response.text();
      expect(text).toContain("Recovered final answer");
      expect(parseSseDataLines(text).at(-1)).toBe("[DONE]");
      expect(agentCommand).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "surfaces terminal errors after optional narration (narration=%s)",
    async (narration) => {
      agentCommand.mockClear();
      agentCommand.mockImplementationOnce((async (opts: unknown) => {
        const runId = (opts as { runId: string }).runId;
        if (narration) {
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "Working on this." } });
        }
        emitAgentEvent({
          runId,
          stream: "tool",
          data: { phase: "result", name: "write", toolCallId: "write-1" },
        });
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          payloads: [{ text: "private provider failure token=secret", isError: true }],
          meta: {},
        };
      }) as never);
      const response = await postChatCompletions(enabledPort, {
        stream: true,
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      const text = await response.text();
      expect(text).toContain("event: error");
      expect(text).toContain("Agent couldn't generate a response. Please try again.");
      expect(text).toContain('"code":"terminal_result_error"');
      expect(text).not.toContain("private provider failure");
      expect(text).not.toContain("secret");
      expect(parseSseDataLines(text).at(-1)).toBe("[DONE]");
      expect(agentCommand).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "keeps a thrown final failure after lifecycle end (narration=%s)",
    async (narration) => {
      agentCommand.mockClear();
      agentCommand.mockImplementationOnce((async (opts: unknown) => {
        const runId = (opts as { runId: string }).runId;
        if (narration) {
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "Working on this." } });
        }
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("private exhausted provider failure");
      }) as never);
      const response = await postChatCompletions(enabledPort, {
        stream: true,
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      const text = await response.text();
      expect(text.match(/event: error/g)).toHaveLength(1);
      expect(text).toContain('"code":"terminal_result_error"');
      expect(text).not.toContain("private exhausted provider failure");
      expect(text).not.toContain("Error: internal error");
      expect(parseSseDataLines(text).at(-1)).toBe("[DONE]");
      expect(agentCommand).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ stopReason: "error" }, { error: { kind: "retry_limit" } }])(
    "retains non-error partial payloads without completing explicit terminal failures (%j)",
    async (meta) => {
      agentCommand.mockClear();
      agentCommand.mockImplementationOnce((async (opts: unknown) => {
        const runId = (opts as { runId: string }).runId;
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
        return {
          payloads: [
            { text: "private provider details", isError: true },
            { text: "Verified partial work." },
          ],
          meta,
        };
      }) as never);
      const response = await postChatCompletions(enabledPort, {
        stream: true,
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      const text = await response.text();
      expect(text).toContain("Verified partial work.");
      expect(text.indexOf("Verified partial work.")).toBeLessThan(text.indexOf("event: error"));
      expect(text).not.toContain("private provider details");
      expect(text.match(/event: error/g)).toHaveLength(1);
      expect(text).toContain('"code":"terminal_result_error"');
      expect(agentCommand).toHaveBeenCalledTimes(1);
    },
  );

  it("delivers a lifecycle error once when usage arrives with error-only payloads", async () => {
    agentCommand.mockClear();
    agentCommand.mockImplementationOnce((async (opts: unknown) => {
      const runId = (opts as { runId: string }).runId;
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error", error: "Safe terminal failure" },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        payloads: [{ text: "private provider details", isError: true }],
        meta: { agentMeta: { usage: { input: 7, output: 3, total: 10 } } },
      };
    }) as never);
    const response = await postChatCompletions(enabledPort, {
      stream: true,
      stream_options: { include_usage: true },
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    const text = await response.text();
    expect(text.match(/event: error/g)).toHaveLength(1);
    expect(text).toContain("Safe terminal failure");
    expect(text).not.toContain("private provider details");
    expect(text).toContain('"total_tokens":10');
    expect(parseSseDataLines(text).at(-1)).toBe("[DONE]");
  });

  it("finalizes stream when lifecycle end arrives before usage is available", async () => {
    const port = enabledPort;
    agentCommand.mockClear();
    agentCommand.mockImplementationOnce(
      ((opts: unknown) =>
        new Promise((resolve) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          setTimeout(() => {
            resolve({
              payloads: [{ text: "hello" }],
              meta: {
                agentMeta: {
                  usage: { input: 7, output: 3, total: 10 },
                },
              },
            });
          }, 100);
        })) as never,
    );

    const res = await postChatCompletions(port, {
      stream: true,
      stream_options: { include_usage: true },
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
    const jsonChunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    const usageChunk = jsonChunks.find((chunk) => "usage" in chunk);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
  });

  it("forwards compaction events as custom SSE events (Magister fork)", async () => {
    const port = enabledPort;
    agentCommand.mockClear();
    agentCommand.mockImplementationOnce(
      ((opts: unknown) =>
        new Promise((resolve) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({
            runId,
            stream: "compaction",
            data: { phase: "start", trigger: "overflow" },
          });
          emitAgentEvent({
            runId,
            stream: "compaction",
            data: {
              phase: "end",
              trigger: "overflow",
              willRetry: true,
              tokensBefore: 180_000,
              tokensAfter: 40_000,
            },
          });
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "recovered" } });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          setTimeout(() => {
            resolve({ payloads: [{ text: "recovered" }], meta: {} });
          }, 50);
        })) as never,
    );

    const res = await postChatCompletions(port, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain("event: compaction");
    expect(text).toContain('"phase":"start"');
    expect(text).toContain('"trigger":"overflow"');
    expect(text).toContain('"willRetry":true');
    expect(text).toContain('"tokensAfter":40000');
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
  });

  it("forwards assistant media once even when the final event has no text delta (Magister fork)", async () => {
    const port = enabledPort;
    const mediaUrl = "https://media.zernio.com/media/generated-image.jpg";
    agentCommand.mockClear();
    agentCommand.mockImplementationOnce(
      ((opts: unknown) =>
        new Promise((resolve) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "Here it is:" } });
          emitAgentEvent({
            runId,
            stream: "assistant",
            data: { text: "Here it is:", delta: "", mediaUrls: [mediaUrl, mediaUrl] },
          });
          emitAgentEvent({
            runId,
            stream: "assistant",
            data: { text: "Here it is:", delta: "", mediaUrls: [mediaUrl] },
          });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          setTimeout(() => resolve({ payloads: [{ text: "Here it is:" }], meta: {} }), 50);
        })) as never,
    );

    const res = await postChatCompletions(port, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "show me the image" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text.match(/event: media/g)).toHaveLength(1);
    expect(text).toContain(`data: ${JSON.stringify({ urls: [mediaUrl] })}`);
    expect(parseSseDataLines(text).at(-1)).toBe("[DONE]");
  });

  it("writes an error SSE event before finalizing on terminal lifecycle error (Magister fork)", async () => {
    const port = enabledPort;
    agentCommand.mockClear();
    agentCommand.mockImplementationOnce(
      ((opts: unknown) =>
        new Promise((resolve) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "partial" } });
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: { phase: "error", error: "Context overflow: recovery exhausted" },
          });
          setTimeout(() => {
            resolve({ payloads: [{ text: "partial" }], meta: {} });
          }, 50);
        })) as never,
    );

    const res = await postChatCompletions(port, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("Context overflow: recovery exhausted");
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
  });

  it("streams the retry-limit summary before closing on its terminal error", async () => {
    const port = enabledPort;
    const summary =
      "I couldn't complete the task before the retry limit. Here is the verified partial result.";
    agentCommand.mockClear();
    agentCommand.mockImplementationOnce(
      ((opts: unknown) =>
        new Promise((resolve) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({
            runId,
            stream: "assistant",
            data: { phase: "final_answer", text: summary, delta: summary },
          });
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: {
              phase: "error",
              error: "Agent stopped after reaching its retry limit.",
              stopReason: "retry_limit",
            },
          });
          setTimeout(() => resolve({ payloads: [{ text: summary, isError: true }], meta: {} }), 50);
        })) as never,
    );

    const res = await postChatCompletions(port, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "finish the task" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    const streamedContent = data
      .filter((entry) => entry !== "[DONE]")
      .flatMap((entry) => {
        const parsed = JSON.parse(entry) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        return parsed.choices?.[0]?.delta?.content ?? [];
      })
      .join("");
    expect(streamedContent).toBe(summary);
    expect(text.indexOf(summary)).toBeLessThan(text.indexOf("event: error"));
    expect(data.at(-1)).toBe("[DONE]");
  });

  it(
    "cleans up usage-enabled stream when client disconnects before usage arrives",
    { timeout: 15_000 },
    async () => {
      const port = enabledPort;
      let serverAbortSignal: AbortSignal | undefined;

      agentCommand.mockClear();
      agentCommand.mockImplementationOnce(
        (opts: unknown) =>
          new Promise<undefined>((resolve) => {
            const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
            const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            serverAbortSignal = signal;
            emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
            emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
            if (signal?.aborted) {
              resolve(undefined);
              return;
            }
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      );

      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
      });
      clientReq.on("error", () => {});
      clientReq.end(
        JSON.stringify({
          stream: true,
          stream_options: { include_usage: true },
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      await vi.waitFor(() => {
        expect(agentCommand).toHaveBeenCalledTimes(1);
      });

      clientReq.destroy();

      await vi.waitFor(
        () => {
          expect(serverAbortSignal?.aborted).toBe(true);
        },
        { timeout: 5_000, interval: 50 },
      );
    },
  );

  it("finalizes after command settlement without requiring usage when not requested", async () => {
    const port = enabledPort;
    agentCommand.mockClear();
    agentCommand.mockImplementationOnce(
      ((opts: unknown) =>
        new Promise((resolve) => {
          const runId = (opts as { runId?: string } | undefined)?.runId ?? "";
          emitAgentEvent({ runId, stream: "assistant", data: { delta: "hello" } });
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
          setTimeout(() => resolve({ payloads: [{ text: "hello" }], meta: {} }), 20);
        })) as never,
    );

    const res = await postChatCompletions(port, {
      stream: true,
      model: "openclaw",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");
    const jsonChunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    const usageChunks = jsonChunks.filter((chunk) => "usage" in chunk);
    expect(usageChunks).toHaveLength(0);
  });

  it("treats shared-secret bearer callers as owner operators", async () => {
    const port = await getFreePort();
    const server = await startTokenServer(port);
    try {
      agentCommand.mockClear();
      agentCommand.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);

      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-openclaw-scopes": "operator.approvals",
        },
        body: JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(200);
      const firstCall = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { senderIsOwner?: boolean }
        | undefined;
      expect(firstCall?.senderIsOwner).toBe(true);
      await res.text();
    } finally {
      await server.close({ reason: "openai token auth owner test done" });
    }
  });

  it("aborts agent command when streaming client disconnects", { timeout: 15_000 }, async () => {
    const port = enabledPort;
    let serverAbortSignal: AbortSignal | undefined;

    agentCommand.mockClear();
    agentCommand.mockImplementationOnce(
      (opts: unknown) =>
        new Promise<undefined>((resolve) => {
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          serverAbortSignal = signal;
          if (signal?.aborted) {
            resolve(undefined);
            return;
          }
          signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }),
    );

    const clientReq = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
    });
    clientReq.on("error", () => {});
    clientReq.end(
      JSON.stringify({
        stream: true,
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    await vi.waitFor(() => {
      expect(agentCommand).toHaveBeenCalledTimes(1);
    });

    clientReq.destroy();

    await vi.waitFor(
      () => {
        expect(serverAbortSignal?.aborted).toBe(true);
      },
      { timeout: 5_000, interval: 50 },
    );
  });

  it(
    "aborts agent command when non-streaming client disconnects",
    { timeout: 15_000 },
    async () => {
      const port = enabledPort;
      let serverAbortSignal: AbortSignal | undefined;

      agentCommand.mockClear();
      agentCommand.mockImplementationOnce(
        (opts: unknown) =>
          new Promise<undefined>((resolve) => {
            const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            serverAbortSignal = signal;
            if (signal?.aborted) {
              resolve(undefined);
              return;
            }
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      );

      const clientReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret",
        },
      });
      clientReq.on("error", () => {});
      clientReq.end(
        JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      await vi.waitFor(() => {
        expect(agentCommand).toHaveBeenCalledTimes(1);
      });

      clientReq.destroy();

      await vi.waitFor(
        () => {
          expect(serverAbortSignal?.aborted).toBe(true);
        },
        { timeout: 5_000, interval: 50 },
      );
    },
  );
});
