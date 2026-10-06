import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessage,
  type Usage,
} from "@mariozechner/pi-ai";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAssistantMessagePhase } from "../shared/chat-message-content.js";
import {
  applyFigureEdits,
  checkDraft,
  deriveDraftContract,
  draftRepairInstruction,
  draftStopReason,
  figuresRepairInstruction,
  hasDraftChecks,
  MAX_DRAFT_CHARS,
  MAX_EVIDENCE_CHARS,
  parseFigureEdits,
  ungroundedFigures,
  type DraftVerificationReceipt,
} from "./draft-verification.js";

type StreamOptions = Parameters<StreamFn>[2];
type Model = Parameters<StreamFn>[0];
type Stream = Awaited<ReturnType<StreamFn>>;
type WrapOptions = { repairAllowed?: boolean; maxRepairMs?: number };
type Options = WrapOptions & {
  mode: DraftVerificationReceipt["mode"];
  prompt: string;
  deadline: number;
  repairAllowed: boolean;
  abortSignal?: AbortSignal;
};

const HTTP_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const MAX_REPAIR_MS = 30_000;
const MAX_REPAIR_TOKENS = 2_048;
// A pasted-data analysis is a long deliverable (the benchmark's ledger
// reviews run 9k–28k output tokens), so its correction is a list of edits
// to the draft, not a rewrite: a few thousand tokens, applied here. The
// Gateway's silence watchdog bounds the wait.
const MAX_FIGURES_REPAIR_MS = 90_000;
const MAX_FIGURES_REPAIR_TOKENS = 4_000;
// A tool output in the correction context keeps its tail, where a script
// prints its figures table.
const MAX_EVIDENCE_IN_REPAIR_CHARS = 20_000;

const draftLogger = createSubsystemLogger("draft-verification");

type ContextMessage = Parameters<StreamFn>[1]["messages"][number];

/**
 * What the figures check may ground a figure in: the request (the pasted
 * data is inline) and every tool output the model has seen, newest first
 * until the cap. The model's own earlier prose is not evidence.
 */
function collectEvidence(context: Parameters<StreamFn>[1], prompt: string): string[] {
  const evidence: string[] = [prompt];
  let size = prompt.length;
  for (let i = context.messages.length - 1; i >= 0 && size < MAX_EVIDENCE_CHARS; i -= 1) {
    const message = context.messages[i];
    if (message.role !== "toolResult" && message.role !== "user") {
      continue;
    }
    const blocks = typeof message.content === "string" ? [message.content] : message.content;
    for (const block of blocks) {
      const text = typeof block === "string" ? block : block.type === "text" ? block.text : "";
      if (text && text !== prompt) {
        evidence.push(text);
        size += text.length;
      }
    }
  }
  return evidence;
}

/**
 * The correction call carries no tools, and a provider refuses tool blocks
 * in a history without tool definitions. Prior tool calls become prose and
 * tool outputs become user text, so the model still sees the figures its
 * script printed; the correction is never persisted, so the real transcript
 * keeps its tool messages.
 */
function toolFreeMessages(messages: ContextMessage[]): ContextMessage[] {
  const result: ContextMessage[] = [];
  const pushUser = (text: string, timestamp: number) => {
    const previous = result.at(-1);
    if (previous && previous.role === "user" && Array.isArray(previous.content)) {
      previous.content.push({ type: "text", text });
      return;
    }
    result.push({ role: "user", content: [{ type: "text", text }], timestamp });
  };
  for (const message of messages) {
    if (message.role === "toolResult") {
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      pushUser(
        `[${message.toolName} output]\n${text.length > MAX_EVIDENCE_IN_REPAIR_CHARS ? text.slice(-MAX_EVIDENCE_IN_REPAIR_CHARS) : text}`,
        message.timestamp,
      );
    } else if (message.role === "assistant") {
      const content = message.content.flatMap((block) =>
        block.type === "text"
          ? [block]
          : block.type === "toolCall"
            ? [{ type: "text" as const, text: `(ran ${block.name})` }]
            : [],
      );
      if (content.length > 0) {
        result.push({ ...message, content });
      }
    } else if (Array.isArray(message.content)) {
      // Consecutive user turns merge, as a tool output followed by a request would otherwise stand alone.
      const previous = result.at(-1);
      if (previous && previous.role === "user" && Array.isArray(previous.content)) {
        previous.content.push(...message.content);
      } else {
        result.push({ ...message, content: [...message.content] });
      }
    } else {
      pushUser(message.content, message.timestamp);
    }
  }
  return result;
}

/** Do not retain a second copy of an oversized provider partial. */
function boundedText(message: AssistantMessage): string | undefined {
  let size = 0;
  const text: string[] = [];
  for (const block of message.content) {
    if (block.type === "toolCall") {
      return undefined;
    }
    size += block.type === "text" ? block.text.length : block.thinking.length;
    if (size > MAX_DRAFT_CHARS) {
      return undefined;
    }
    if (block.type === "text") {
      text.push(block.text);
    }
  }
  if (text.length !== 1 || resolveAssistantMessagePhase(message) === "commentary") {
    return undefined;
  }
  const directives = parseReplyDirectives(text[0]);
  if (
    directives.mediaUrl ||
    directives.mediaUrls?.length ||
    directives.audioAsVoice ||
    directives.replyToTag ||
    directives.isSilent
  ) {
    return undefined;
  }
  return text[0];
}

/** SDK payload wrappers invoke the supplied callback after their own patches. */
function toolFreePayloadGuard(
  options: StreamOptions,
  api: string,
  maxTokens: number,
): NonNullable<NonNullable<StreamOptions>["onPayload"]> {
  return async (payload, model) => {
    const replacement = await options?.onPayload?.(payload, model);
    const selected = replacement === undefined ? payload : replacement;
    if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
      throw new Error("Unsupported correction payload");
    }
    const safe = { ...selected } as Record<string, unknown>;
    for (const key of [
      "tools",
      "functions",
      "function_call",
      "parallel_tool_calls",
      "mcp_servers",
      "web_search_options",
    ]) {
      delete safe[key];
    }
    if (api === "anthropic-messages") {
      // With no tools Anthropic needs no tool_choice (including on older compatible routes).
      delete safe.tool_choice;
    } else {
      safe.tool_choice = "none";
    }
    const tokenKey =
      api === "openai-responses"
        ? "max_output_tokens"
        : api === "openai-completions" && "max_completion_tokens" in safe
          ? "max_completion_tokens"
          : "max_tokens";
    const configured = safe[tokenKey];
    const limit =
      typeof configured === "number" && Number.isFinite(configured) && configured >= 1
        ? Math.min(maxTokens, Math.floor(configured))
        : maxTokens;
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      delete safe[key];
    }
    safe[tokenKey] = limit;
    return safe;
  };
}

function hasToolCall(message: AssistantMessage): boolean {
  return (
    message.stopReason === "toolUse" || message.content.some((block) => block.type === "toolCall")
  );
}

function nativeOrCachedOptions(options: StreamOptions): boolean {
  const values = options as Record<string, unknown> | undefined;
  return (
    (typeof values?.transport === "string" && values.transport.startsWith("websocket")) ||
    [
      "cachedContent",
      "cached_content",
      "previousResponseId",
      "previous_response_id",
      "tools",
      "nativeTools",
      "builtInTools",
      "built_in_tools",
    ].some((key) => values?.[key] != null)
  );
}

function failedMessage(
  model: Model,
  aborted: boolean,
  observed?: AssistantMessage,
): AssistantMessage {
  return {
    ...(observed ?? {
      role: "assistant" as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }),
    content: [],
    stopReason: aborted ? "aborted" : "error",
    errorMessage: aborted ? "Request aborted" : "Provider stream failed",
  };
}

/** Fresh stream/result pair: the SDK persists result(), not merely the done event. */
function emitSelected(stream: Stream, message: AssistantMessage): void {
  stream.push({ type: "start", partial: message });
  for (const [contentIndex, block] of message.content.entries()) {
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
    } else if (block.type === "thinking") {
      stream.push({ type: "thinking_start", contentIndex, partial: message });
      stream.push({
        type: "thinking_delta",
        contentIndex,
        delta: block.thinking,
        partial: message,
      });
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: message,
      });
    } else {
      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
    }
  }
  emitTerminal(stream, message);
}

function emitTerminal(stream: Stream, message: AssistantMessage): void {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  stream.end();
}

/** One timer covers stream creation, iteration AND result(), even for an abort-ignoring transport. */
function boundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signals: (AbortSignal | undefined)[],
  deadline: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const abort = () => {
    controller.abort();
    rejectAbort(new Error("Draft stream interrupted"));
  };
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  for (const signal of signals) {
    signal?.addEventListener("abort", abort, { once: true });
  }
  if (signals.some((signal) => signal?.aborted) || deadline <= Date.now()) {
    abort();
  } else {
    timer = setTimeout(abort, deadline - Date.now());
  }
  const work = controller.signal.aborted
    ? interrupted
    : Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([work, interrupted]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
    for (const signal of signals) {
      signal?.removeEventListener("abort", abort);
    }
  });
}

/** Per outer run. Only this provider boundary selects an answer; it never starts an AgentSession. */
export class DraftVerificationStream {
  readonly receipt: DraftVerificationReceipt;
  readonly contract;
  hadToolActivity = false;
  lastProviderUsage?: Usage;
  private additionalUsage?: Usage;
  private releasedText = false;

  constructor(private readonly options: Options) {
    this.contract = deriveDraftContract(options.prompt);
    this.receipt = {
      version: 1,
      mode: options.mode,
      outcome: "unchecked",
      checks: [],
      repair_attempts: 0,
      stop_reason: null,
      ceiling_retried: null,
      skill_reads: null,
    };
  }

  beginAttempt(excluded = false): void {
    // Attempt evidence is not run-wide. Retain only safety/budget state when
    // retrying, including when the next attempt fails before opening a stream.
    this.lastProviderUsage = undefined;
    this.receipt.checks = [];
    this.receipt.stop_reason = null;
    this.receipt.outcome = excluded ? "excluded" : "unchecked";
  }

  /** Drain once into attempt aggregate accounting, never into the selected message's usage. */
  takeAdditionalUsage(): Usage | undefined {
    const usage = this.additionalUsage;
    this.additionalUsage = undefined;
    return usage;
  }

  /** The figures check verifies against tool output, so tool activity is its expected shape. */
  private get toolTurnChecks(): boolean {
    return this.contract.figuresGrounded === true;
  }

  private observe(message: AssistantMessage, evidence: readonly string[] = []): void {
    this.hadToolActivity ||= hasToolCall(message);
    this.receipt.stop_reason = draftStopReason(message.stopReason);
    if (this.options.mode === "off") {
      return;
    }
    this.receipt.checks = checkDraft(this.contract, boundedText(message) ?? "", evidence);
    this.receipt.outcome = this.receipt.checks.some((check) => check.status === "fail")
      ? "failed"
      : this.receipt.checks.length > 0 &&
          this.receipt.checks.every((check) => check.status === "pass")
        ? "passed"
        : "unchecked";
  }

  wrap(inner: StreamFn | undefined, override: WrapOptions = {}): StreamFn {
    const callInner = inner ?? streamSimple;
    return (model, context, options) => {
      this.lastProviderUsage = undefined;
      const output = createAssistantMessageEventStream();
      const canBuffer =
        this.options.mode === "repair" &&
        hasDraftChecks(this.contract) &&
        this.options.repairAllowed &&
        override.repairAllowed !== false &&
        (this.toolTurnChecks || (!this.hadToolActivity && !this.releasedText)) &&
        this.receipt.repair_attempts === 0 &&
        HTTP_APIS.has(model.api) &&
        !nativeOrCachedOptions(options);
      const evidence = this.toolTurnChecks ? collectEvidence(context, this.options.prompt) : [];
      let observed: AssistantMessage | undefined;
      const parentAborted = () => this.options.abortSignal?.aborted || options?.signal?.aborted;
      const release = (message: AssistantMessage) => {
        this.releasedText ||= message.content.some(
          (block) => block.type === "text" && block.text.length > 0,
        );
        emitSelected(output, message);
      };

      const consume = async (
        stream: Stream,
        forward: boolean,
        signal?: AbortSignal,
      ): Promise<AssistantMessage> => {
        for await (const event of stream) {
          if (signal?.aborted) {
            throw new Error("Draft stream interrupted");
          }
          const message =
            event.type === "done"
              ? event.message
              : event.type === "error"
                ? event.error
                : event.partial;
          observed = message;
          this.hadToolActivity ||= hasToolCall(message);
          if (event.type === "done" || event.type === "error") {
            this.lastProviderUsage = message.usage;
          }
          if (forward) {
            if (event.type === "done" || event.type === "error") {
              this.observe(message, evidence);
              if (this.options.mode === "repair" && this.receipt.outcome === "failed") {
                this.receipt.outcome = "excluded";
              }
            }
            this.releasedText ||= message.content.some(
              (block) => block.type === "text" && block.text.length > 0,
            );
            output.push(event);
          }
        }
        const result = await stream.result();
        if (signal?.aborted) {
          throw new Error("Draft stream interrupted");
        }
        this.lastProviderUsage = result.usage;
        return result;
      };

      const run = async () => {
        if (!canBuffer) {
          // Do not suppress or reconstruct off/shadow/ineligible streaming events.
          const original = await consume(await callInner(model, context, options), true);
          this.observe(original, evidence);
          if (this.options.mode === "repair" && this.receipt.outcome === "failed") {
            this.receipt.outcome = "excluded";
          }
          output.end(original);
          return;
        }

        let original = await boundedOperation(
          async (signal) =>
            consume(await callInner(model, context, { ...options, signal }), false, signal),
          [this.options.abortSignal, options?.signal],
          this.options.deadline,
        );
        this.observe(original, evidence);
        if (parentAborted()) {
          release(failedMessage(model, true, original));
          this.receipt.stop_reason = "aborted";
          return;
        }
        const figuresRepair =
          this.toolTurnChecks &&
          this.receipt.checks.some(
            (check) => check.kind === "figures_grounded" && check.status === "fail",
          );
        const repairCeilingMs = figuresRepair ? MAX_FIGURES_REPAIR_MS : MAX_REPAIR_MS;
        const repairMs = Math.min(
          repairCeilingMs,
          this.options.maxRepairMs ?? repairCeilingMs,
          override.maxRepairMs ?? repairCeilingMs,
          this.options.deadline - Date.now(),
        );
        if (
          this.receipt.outcome !== "failed" ||
          original.stopReason !== "stop" ||
          (this.hadToolActivity && !this.toolTurnChecks) ||
          !Number.isFinite(repairMs) ||
          repairMs <= 1_000
        ) {
          if (this.receipt.outcome === "failed") {
            this.receipt.outcome = "excluded";
          }
          release(original);
          return;
        }

        this.receipt.repair_attempts = 1;
        this.receipt.outcome = "repair_failed";
        const originalText = boundedText(original) ?? "";
        const ungrounded = figuresRepair ? ungroundedFigures(originalText, evidence) : [];
        if (figuresRepair) {
          draftLogger.warn("draft states figures no tool output or request holds", {
            count: ungrounded.length,
            figures: ungrounded.slice(0, 24),
          });
        }
        let candidate: AssistantMessage | undefined;
        try {
          candidate = await boundedOperation(
            async (signal) => {
              const tokenCeiling = figuresRepair ? MAX_FIGURES_REPAIR_TOKENS : MAX_REPAIR_TOKENS;
              const maxTokens = Math.max(
                1,
                Math.min(tokenCeiling, options?.maxTokens ?? tokenCeiling, model.maxTokens),
              );
              const repairOptions = {
                ...options,
                signal,
                toolChoice: "none",
                maxRetries: 0,
                maxTokens,
                timeoutMs: repairMs,
                onPayload: toolFreePayloadGuard(options, model.api, maxTokens),
              };
              const repairContext = {
                ...context,
                tools: [],
                messages: [
                  ...(this.hadToolActivity
                    ? toolFreeMessages([...context.messages, original])
                    : [...context.messages, original]),
                  {
                    role: "user" as const,
                    content: figuresRepair
                      ? figuresRepairInstruction(ungrounded)
                      : draftRepairInstruction(this.contract),
                    timestamp: Date.now(),
                  },
                ],
              };
              // Call captured INNER, not this wrapper or AgentSession.prompt: no mutation replay/retry loop.
              return consume(
                await callInner({ ...model, maxTokens }, repairContext, repairOptions),
                false,
                signal,
              );
            },
            [this.options.abortSignal, options?.signal],
            Date.now() + repairMs,
          );
          this.receipt.stop_reason = draftStopReason(candidate.stopReason);
        } catch {
          this.receipt.stop_reason = null; // No observed terminal means no invented provider stop/usage.
        }
        if (candidate) {
          const deliverable =
            !parentAborted() &&
            (!this.hadToolActivity || this.toolTurnChecks) &&
            candidate.stopReason === "stop";
          if (figuresRepair) {
            // The correction is a list of edits; the draft with them applied
            // is the candidate answer, and it ships when every figure is
            // grounded or when strictly fewer are not.
            const edits = parseFigureEdits(boundedText(candidate) ?? "");
            const patchedText = edits ? applyFigureEdits(originalText, edits) : undefined;
            const checks = patchedText ? checkDraft(this.contract, patchedText, evidence) : [];
            const remaining = patchedText ? ungroundedFigures(patchedText, evidence) : ungrounded;
            const otherChecksPass = checks.every(
              (check) => check.kind === "figures_grounded" || check.status === "pass",
            );
            if (deliverable && patchedText && checks.length > 0 && otherChecksPass) {
              if (checks.every((check) => check.status === "pass")) {
                this.receipt.outcome = "repaired";
              } else if (remaining.length < ungrounded.length) {
                this.receipt.outcome = "improved";
              }
            }
            this.additionalUsage = candidate.usage;
            if (this.receipt.outcome === "repaired" || this.receipt.outcome === "improved") {
              original = {
                ...original,
                content: original.content.map((block) =>
                  block.type === "text" ? { ...block, text: patchedText! } : block,
                ),
              };
              this.receipt.checks = checks;
            }
            draftLogger.warn("figures correction finished", {
              outcome: this.receipt.outcome,
              edits: edits?.length ?? null,
              before: ungrounded.length,
              after: remaining.length,
              remaining: remaining.slice(0, 24),
              stopReason: candidate.stopReason,
            });
          } else {
            const checks = checkDraft(this.contract, boundedText(candidate) ?? "", evidence);
            if (
              deliverable &&
              checks.length > 0 &&
              checks.every((check) => check.status === "pass")
            ) {
              this.additionalUsage = original.usage;
              original = candidate;
              this.receipt.checks = checks;
              this.receipt.outcome = "repaired";
            } else {
              this.additionalUsage = candidate.usage;
            }
          }
        } else if (figuresRepair) {
          draftLogger.warn("figures correction produced no candidate", {
            before: ungrounded.length,
          });
        }
        if (parentAborted()) {
          this.receipt.stop_reason = "aborted";
          release(failedMessage(model, true, original));
        } else {
          release(original);
        }
      };
      void run().catch(() => {
        const message = failedMessage(model, Boolean(parentAborted()), observed);
        this.receipt.stop_reason = parentAborted() ? "aborted" : null;
        this.receipt.outcome = "excluded";
        if (canBuffer) {
          release(message);
        } else {
          emitTerminal(output, message);
        }
      });
      return output;
    };
  }
}
