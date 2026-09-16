import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ImageContent } from "../agents/command/types.js";
import { parseDraftVerificationReceipt } from "../agents/draft-verification-receipt.js";
import {
  hasNonzeroUsage,
  normalizeUsage,
  toOpenAiChatCompletionsUsage,
  type NormalizedUsage,
} from "../agents/usage.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { GatewayHttpChatCompletionsConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractImageContentFromSource,
  normalizeMimeList,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  resolveAssistantMediaUrls,
  resolveAssistantStreamDeltaText,
} from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, watchClientDisconnect, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";
import { extractMagisterApprovalEventFromToolEvent } from "./magister-approval-event.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  config?: GatewayHttpChatCompletionsConfig;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  // Naming/style reference: src/agents/openai-transport-stream.ts:1262-1273
  stream_options?: unknown;
  messages?: unknown;
  user?: unknown;
};

const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const IMAGE_ONLY_USER_MESSAGE = "User sent image(s) with no text.";
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_IMAGE_LIMITS: InputImageLimits = {
  allowUrl: false,
  allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
  maxBytes: DEFAULT_INPUT_IMAGE_MAX_BYTES,
  maxRedirects: DEFAULT_INPUT_MAX_REDIRECTS,
  timeoutMs: DEFAULT_INPUT_TIMEOUT_MS,
};

type ResolvedOpenAiChatCompletionsLimits = {
  maxBodyBytes: number;
  maxImageParts: number;
  maxTotalImageBytes: number;
  images: InputImageLimits;
};

function resolveOpenAiChatCompletionsLimits(
  config: GatewayHttpChatCompletionsConfig | undefined,
): ResolvedOpenAiChatCompletionsLimits {
  const imageConfig = config?.images;
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
    maxImageParts:
      typeof config?.maxImageParts === "number"
        ? Math.max(0, Math.floor(config.maxImageParts))
        : DEFAULT_OPENAI_MAX_IMAGE_PARTS,
    maxTotalImageBytes:
      typeof config?.maxTotalImageBytes === "number"
        ? Math.max(1, Math.floor(config.maxTotalImageBytes))
        : DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
    images: {
      allowUrl: imageConfig?.allowUrl ?? DEFAULT_OPENAI_IMAGE_LIMITS.allowUrl,
      urlAllowlist: normalizeInputHostnameAllowlist(imageConfig?.urlAllowlist),
      allowedMimes: normalizeMimeList(imageConfig?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: imageConfig?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: imageConfig?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: imageConfig?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Magister fork: write a named SSE event (with `event:` line) for thinking
 * and tool events. Consumed by `gateway/app/services/active_turns.py` which
 * dispatches by event name to render thinking blocks and tool start/result
 * blocks in the webapp chat.
 */
function writeCustomSseEvent(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function buildAgentCommandInput(params: {
  prompt: { message: string; extraSystemPrompt?: string; images?: ImageContent[] };
  modelOverride?: string;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  abortSignal?: AbortSignal;
}) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    images: params.prompt.images,
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: params.messageChannel,
    bestEffortDeliver: false as const,
    senderIsOwner: params.senderIsOwner,
    allowModelOverride: true as const,
    abortSignal: params.abortSignal,
  };
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    ],
  });
}

function writeAssistantStopChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  });
}

function writeUsageChunk(
  res: ServerResponse,
  params: {
    runId: string;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [],
    usage: params.usage,
  });
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resolveImageUrlPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const imageUrl = (part as { image_url?: unknown }).image_url;
  if (typeof imageUrl === "string") {
    const trimmed = imageUrl.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!imageUrl || typeof imageUrl !== "object") {
    return undefined;
  }
  const rawUrl = (imageUrl as { url?: unknown }).url;
  if (typeof rawUrl !== "string") {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractImageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const urls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "image_url") {
      continue;
    }
    const url = resolveImageUrlPart(part);
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

type ActiveTurnContext = {
  activeTurnIndex: number;
  activeUserMessageIndex: number;
  urls: string[];
};

function parseImageUrlToSource(url: string): InputImageSource {
  const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(url);
  if (dataUriMatch) {
    const metadata = normalizeOptionalString(dataUriMatch[1]) ?? "";
    const data = dataUriMatch[2] ?? "";
    const metadataParts = metadata
      .split(";")
      .map((part) => normalizeOptionalString(part) ?? "")
      .filter(Boolean);
    const isBase64 = metadataParts.some(
      (part) => normalizeLowercaseStringOrEmpty(part) === "base64",
    );
    if (!isBase64) {
      throw new Error("image_url data URI must be base64 encoded");
    }
    if (!(normalizeOptionalString(data) ?? "")) {
      throw new Error("image_url data URI is missing payload data");
    }
    const mediaTypeRaw = metadataParts.find((part) => part.includes("/"));
    return {
      type: "base64",
      mediaType: mediaTypeRaw,
      data,
    };
  }
  return { type: "url", url };
}

function resolveActiveTurnContext(messagesUnknown: unknown): ActiveTurnContext {
  const messages = asMessages(messagesUnknown);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "tool") {
      continue;
    }
    return {
      activeTurnIndex: i,
      activeUserMessageIndex: normalizedRole === "user" ? i : -1,
      urls: normalizedRole === "user" ? extractImageUrls(msg.content) : [],
    };
  }
  return { activeTurnIndex: -1, activeUserMessageIndex: -1, urls: [] };
}

async function resolveImagesForRequest(
  activeTurnContext: Pick<ActiveTurnContext, "urls">,
  limits: ResolvedOpenAiChatCompletionsLimits,
): Promise<ImageContent[]> {
  const urls = activeTurnContext.urls;
  if (urls.length === 0) {
    return [];
  }
  if (urls.length > limits.maxImageParts) {
    throw new Error(`Too many image_url parts (${urls.length}; limit ${limits.maxImageParts})`);
  }

  const images: ImageContent[] = [];
  let totalBytes = 0;
  for (const url of urls) {
    const source = parseImageUrlToSource(url);
    if (source.type === "base64") {
      const sourceBytes = estimateBase64DecodedBytes(source.data);
      if (totalBytes + sourceBytes > limits.maxTotalImageBytes) {
        throw new Error(
          `Total image payload too large (${totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`,
        );
      }
    }

    const image = await extractImageContentFromSource(source, limits.images);
    totalBytes += estimateBase64DecodedBytes(image.data);
    if (totalBytes > limits.maxTotalImageBytes) {
      throw new Error(
        `Total image payload too large (${totalBytes}; limit ${limits.maxTotalImageBytes})`,
      );
    }
    images.push(image);
  }
  return images;
}

export const __testOnlyOpenAiHttp = {
  resolveImagesForRequest,
  resolveOpenAiChatCompletionsLimits,
  resolveChatCompletionUsage,
};

function buildAgentPrompt(
  messagesUnknown: unknown,
  activeUserMessageIndex: number,
): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const [i, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const content = extractTextContent(msg.content).trim();
    const hasImage = extractImageUrls(msg.content).length > 0;
    if (!role) {
      continue;
    }
    if (role === "system" || role === "developer") {
      if (content) {
        systemParts.push(content);
      }
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    // Keep the image-only placeholder scoped to the active user turn so we don't
    // mention historical image-only turns whose bytes are intentionally not replayed.
    const messageContent =
      normalizedRole === "user" && !content && hasImage && i === activeUserMessageIndex
        ? IMAGE_ONLY_USER_MESSAGE
        : content;
    if (!messageContent) {
      continue;
    }

    const name = normalizeOptionalString(msg.name) ?? "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: messageContent },
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

type AgentUsageMeta = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

function resolveAgentRunUsage(result: unknown): NormalizedUsage | undefined {
  const agentMeta = (
    result as {
      meta?: {
        agentMeta?: {
          usage?: AgentUsageMeta;
          lastCallUsage?: AgentUsageMeta;
        };
      };
    } | null
  )?.meta?.agentMeta;
  const primary = normalizeUsage(agentMeta?.usage);
  if (hasNonzeroUsage(primary)) {
    return primary;
  }
  const fallback = normalizeUsage(agentMeta?.lastCallUsage);
  if (hasNonzeroUsage(fallback)) {
    return fallback;
  }
  return primary ?? fallback;
}

function resolveChatCompletionUsage(result: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return toOpenAiChatCompletionsUsage(resolveAgentRunUsage(result));
}

function resolveIncludeUsageForStreaming(payload: OpenAiChatCompletionRequest): boolean {
  // Keep parsing aligned with OpenAI wire-format field names.
  // Flow reference: src/agents/openai-transport-stream.ts:1262-1273
  const streamOptions = payload.stream_options;
  if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) {
    return false;
  }
  return (streamOptions as { include_usage?: unknown }).include_usage === true;
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const limits = resolveOpenAiChatCompletionsLimits(opts.config);
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/chat/completions",
    requiredOperatorMethod: "chat.send",
    // Compat HTTP uses a different scope model from generic HTTP helpers:
    // shared-secret bearer auth is treated as full operator access here.
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? limits.maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  // On the compat surface, shared-secret bearer auth is also treated as an
  // owner sender so owner-only tool policy matches the documented contract.
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);

  const payload = coerceRequest(handled.body);
  const stream = Boolean(payload.stream);
  const streamIncludeUsage = stream && resolveIncludeUsageForStreaming(payload);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  const { agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendJson(res, 400, {
      error: { message: modelError, type: "invalid_request_error" },
    });
    return true;
  }
  const activeTurnContext = resolveActiveTurnContext(payload.messages);
  const prompt = buildAgentPrompt(payload.messages, activeTurnContext.activeUserMessageIndex);
  let images: ImageContent[] = [];
  try {
    images = await resolveImagesForRequest(activeTurnContext, limits);
  } catch (err) {
    logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
    sendJson(res, 400, {
      error: {
        message: "Invalid image_url content in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  if (!prompt.message && images.length === 0) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();
  const abortController = new AbortController();
  const commandInput = buildAgentCommandInput({
    prompt: {
      message: prompt.message,
      extraSystemPrompt: prompt.extraSystemPrompt,
      images: images.length > 0 ? images : undefined,
    },
    modelOverride,
    sessionKey,
    runId,
    messageChannel,
    abortSignal: abortController.signal,
    senderIsOwner,
  });

  if (!stream) {
    const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);

      if (abortController.signal.aborted) {
        return true;
      }

      const content = resolveAgentResponseText(result);
      const usage = resolveChatCompletionUsage(result);

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage,
      });
    } catch (err) {
      if (abortController.signal.aborted) {
        return true;
      }
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error" },
      });
    } finally {
      stopWatchingDisconnect();
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let wroteStopChunk = false;
  let sawAssistantDelta = false;
  let finalUsage:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | undefined;
  let finalizeRequested = false;
  let commandSettled = false;
  let terminalError = false;
  let closed = false;
  let stopWatchingDisconnect = () => {};
  const forwardedMediaUrls = new Set<string>();

  const maybeFinalize = () => {
    if (closed || !finalizeRequested) {
      return;
    }
    // A run's lifecycle can end before agentCommand returns its final payload
    // (including a recovery answer or terminal error). Closing here used to
    // discard that payload, or treat pre-tool narration as a completed answer.
    if (!commandSettled && !terminalError) {
      return;
    }
    if (streamIncludeUsage && !finalUsage) {
      return;
    }
    closed = true;
    stopWatchingDisconnect();
    unsubscribe();
    if (!wroteStopChunk) {
      writeAssistantStopChunk(res, { runId, model });
      wroteStopChunk = true;
    }
    if (streamIncludeUsage && finalUsage) {
      writeUsageChunk(res, { runId, model, usage: finalUsage });
    }
    writeDone(res);
    res.end();
  };

  const requestFinalize = () => {
    finalizeRequested = true;
    maybeFinalize();
  };

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "draft_verification") {
      const receipt = parseDraftVerificationReceipt(evt.data);
      if (receipt) {
        writeCustomSseEvent(res, "draft_verification", receipt);
      }
      return;
    }

    if (evt.stream === "assistant") {
      const mediaUrls = resolveAssistantMediaUrls(evt).filter((url) => {
        if (forwardedMediaUrls.has(url)) {
          return false;
        }
        forwardedMediaUrls.add(url);
        return true;
      });
      if (mediaUrls.length > 0) {
        writeCustomSseEvent(res, "media", { urls: mediaUrls });
      }

      const content = resolveAssistantStreamDeltaText(evt) ?? "";
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }

      sawAssistantDelta = true;
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: null,
      });
      return;
    }

    // Magister fork: forward thinking events through HTTP SSE so the webapp
    // can render reasoning blocks (active_turns.py dispatches on `event: thinking`).
    if (evt.stream === "thinking") {
      const delta = typeof evt.data?.delta === "string" ? evt.data.delta : "";
      if (delta) {
        writeCustomSseEvent(res, "thinking", { delta });
      }
      return;
    }

    // Magister fork: forward tool start/result events through HTTP SSE so the
    // webapp can render tool blocks. `args` carries the tool's input (e.g. exec
    // command, file path) so consumers can show meaningful labels. `result` is
    // included on errors so failed tool blocks are readable in chat.
    if (evt.stream === "tool") {
      const data = evt.data as Record<string, unknown> | undefined;
      if (data) {
        const approval = extractMagisterApprovalEventFromToolEvent(data);
        if (data.phase === "update" && approval) {
          // This update exists only to surface the pending card before a held
          // tool resolves. Keep the ordinary tool block in its running state.
          writeCustomSseEvent(res, "approval", approval);
          return;
        }
        writeCustomSseEvent(res, "tool", {
          phase: data.phase,
          name: data.name,
          toolCallId: data.toolCallId,
          ...(data.isError !== undefined && { isError: data.isError }),
          ...(data.args !== undefined && { args: data.args }),
          ...(Boolean(data.isError) && data.result !== undefined && { result: data.result }),
        });
        if (approval) {
          writeCustomSseEvent(res, "approval", approval);
        }
      }
      return;
    }

    // Magister fork: forward compaction progress (mid-turn overflow recovery
    // or SDK auto-compaction) so the gateway can show a "compacting" state
    // instead of dead air — overflow compaction can take minutes.
    if (evt.stream === "compaction") {
      const data = evt.data ?? {};
      const payload: Record<string, unknown> = { phase: data.phase };
      for (const key of ["trigger", "willRetry", "tokensBefore", "tokensAfter"]) {
        if (data[key] !== undefined) {
          payload[key] = data[key];
        }
      }
      writeCustomSseEvent(res, "compaction", payload);
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        const receipt = parseDraftVerificationReceipt(evt.data?.draftVerification);
        if (receipt) {
          writeCustomSseEvent(res, "draft_verification", receipt);
        }
      }
      if (phase === "error") {
        terminalError = true;
        // Magister fork: surface the terminal error as a custom SSE event
        // before finalizing. Without it a run that died mid-turn is
        // indistinguishable from one that finished, and the gateway records
        // the turn as completed-with-partial-content.
        writeCustomSseEvent(res, "error", {
          message:
            typeof evt.data?.error === "string" && evt.data.error
              ? evt.data.error
              : "Agent run failed",
          ...(commandSettled ? { code: "terminal_result_error" } : {}),
        });
      }
      if (phase === "end" || phase === "error") {
        requestFinalize();
      }
    }
  });

  stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
    closed = true;
    unsubscribe();
  });

  wroteRole = true;
  writeAssistantRoleChunk(res, { runId, model });

  void (async () => {
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);

      if (closed) {
        return;
      }

      finalUsage = resolveChatCompletionUsage(result);
      commandSettled = true;

      const finalResult = result as {
        payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean }>;
        meta?: { error?: unknown; stopReason?: string };
      } | null;
      const resultPayloads = finalResult?.payloads;
      const resultFailed =
        Boolean(finalResult?.meta?.error) ||
        finalResult?.meta?.stopReason === "error" ||
        finalResult?.meta?.stopReason === "retry_limit" ||
        (resultPayloads?.length && resultPayloads.every((payload) => payload.isError));
      if (terminalError || resultFailed) {
        // Explicit terminal metadata can accompany partial narration. Keep
        // non-error partial text, but never deliver the turn as a success or
        // expose raw provider error payloads. The runner owns all retries.
        if (!terminalError) {
          const partialText = resultPayloads
            ?.filter((payload) => !payload.isError && !payload.isReasoning)
            .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
            .filter(Boolean)
            .join("\n\n");
          if (!sawAssistantDelta && partialText) {
            sawAssistantDelta = true;
            writeAssistantContentChunk(res, {
              runId,
              model,
              content: partialText,
              finishReason: null,
            });
          }
          terminalError = true;
          writeCustomSseEvent(res, "error", {
            message: "Agent couldn't generate a response. Please try again.",
            code: "terminal_result_error",
          });
        }
        // include_usage keeps a lifecycle-error stream open until this point.
        // Finalize its usage without duplicating the error already delivered.
        requestFinalize();
        return;
      }

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        const content = resolveAgentResponseText(result);

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content,
          finishReason: null,
        });
      }
      requestFinalize();
    } catch (err) {
      if (closed || abortController.signal.aborted) {
        return;
      }
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      commandSettled = true;
      finalUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          error: "Agent couldn't generate a response. Please try again.",
        },
      });
      requestFinalize();
    } finally {
      if (!closed) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}
