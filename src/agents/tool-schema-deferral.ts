import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentContext,
  AgentTool,
} from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { jsonResult, ToolInputError, type AnyAgentTool } from "./tools/common.js";

/**
 * Deferred tool schemas.
 *
 * Every tool's JSON schema rides in every LLM request. A tool whose
 * `schemaDelivery` is "deferred" keeps only its name and a one-line summary in
 * the system prompt until the model loads it with `tool_describe`; the describe
 * result carries the schema, and the tool is promoted into the live tool list,
 * so it then runs under its own name with every policy, hook, approval and
 * ledger path unchanged. Promotion lasts for the conversation: the next turn
 * finds the tool's earlier calls in the transcript and activates it before the
 * first request. A direct call to a tool whose schema was never loaded
 * promotes it too and asks the model to call again.
 *
 * Policy runs before the split (`createOpenClawCodingTools`), so a denied tool
 * is never describable, and a run that denies `tool_describe` itself, or has
 * nothing deferred, ships every schema exactly as before.
 */

export const TOOL_DESCRIBE_TOOL_NAME = "tool_describe";

const DIRECTORY_SUMMARY_MAX_CHARS = 160;

type DeferredSchemaCatalog = Map<string, AnyAgentTool>;

/**
 * The describe tool carries its catalog as an own property, so the wrappers
 * that spread a tool into a new object (hooks, abort, deferred follow-ups)
 * keep the same Map the tool's `execute` closes over.
 */
type ToolDescribeTool = AnyAgentTool & { deferredSchemaCatalog: DeferredSchemaCatalog };

function isToolDescribeTool(tool: AnyAgentTool): tool is ToolDescribeTool {
  return (
    tool.name === TOOL_DESCRIBE_TOOL_NAME &&
    (tool as Partial<ToolDescribeTool>).deferredSchemaCatalog instanceof Map
  );
}

export function isDeferredSchemaTool(tool: Pick<AnyAgentTool, "name" | "schemaDelivery">): boolean {
  return tool.schemaDelivery === "deferred" && tool.name !== TOOL_DESCRIBE_TOOL_NAME;
}

/**
 * Defer the tools `tools.deferredSchemas` names. Hosted Magister actions carry
 * their delivery in the action contract; native and bundled tools have no
 * contract, so the image config names the ones whose schema almost never
 * earns its place in the prompt (30 days to 2026-10-19 in production:
 * `message`, `video_generate`, `image_generate` and `sessions_spawn` were
 * 16.5K of the 75K tool-schema chars on every request and reached under 2% of
 * tool-using sessions). Config only adds deferral: a contract-deferred action
 * stays deferred, an unknown name is ignored, and tool_describe itself is
 * never deferred, or nothing could be loaded.
 */
export function applyConfiguredSchemaDeferral(
  tools: readonly AnyAgentTool[],
  deferredNames: readonly string[] | undefined,
): AnyAgentTool[] {
  const names = new Set((deferredNames ?? []).filter((name) => name !== TOOL_DESCRIBE_TOOL_NAME));
  return tools.map((tool) =>
    names.has(tool.name) && tool.schemaDelivery !== "deferred"
      ? { ...tool, schemaDelivery: "deferred" as const }
      : tool,
  );
}

/**
 * Per-session eager schemas. A Magister task chat knows its work before the
 * first turn, so the Gateway names the task's own deferred tools in this
 * request header (``gateway/app/services/task_tool_delivery.py``); their
 * schemas then ride in every request of that session instead of costing a
 * describe round trip and a prompt-cache rewrite mid-session. The header
 * only widens what is eager: it never defers, denies or permits anything,
 * and an unknown name is ignored. Deferral stays a prompt-composition
 * choice, so an authenticated caller gains no capability from it.
 */
export const EAGER_SCHEMAS_HEADER = "x-magister-eager-schemas";

const EAGER_SCHEMAS_MAX = 32;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

/** Comma-separated tool names from the header: trimmed, valid, unique, bounded. */
export function parseEagerSchemaTools(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  const names: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!TOOL_NAME_PATTERN.test(name) || name === TOOL_DESCRIBE_TOOL_NAME || names.includes(name)) {
      continue;
    }
    names.push(name);
    if (names.length >= EAGER_SCHEMAS_MAX) {
      break;
    }
  }
  return names;
}

/**
 * Make the named deferred tools eager for this run. Applied after
 * applyConfiguredSchemaDeferral, so the request wins over both the contract
 * and the image config for exactly the tools it names.
 */
export function applyRequestedEagerSchemas(
  tools: readonly AnyAgentTool[],
  eagerNames: readonly string[] | undefined,
): AnyAgentTool[] {
  const names = new Set(eagerNames ?? []);
  if (names.size === 0) {
    return [...tools];
  }
  return tools.map((tool) =>
    names.has(tool.name) && tool.schemaDelivery === "deferred"
      ? { ...tool, schemaDelivery: "eager" as const }
      : tool,
  );
}

export type ToolDescribeResult = {
  tool: string;
  description: string;
  parameters: unknown;
  side_effect?: string;
  permission?: string;
  status: "loaded";
  next: string;
};

function describeDeferredTool(entry: AnyAgentTool): ToolDescribeResult {
  return {
    tool: entry.name,
    description: entry.description ?? "",
    parameters: entry.parameters,
    ...(entry.sideEffect ? { side_effect: entry.sideEffect } : {}),
    ...(entry.sharedPromptGuidance
      ? {
          permission:
            "Permission-gated: the shared instructions for permission-gated tools in the system prompt apply.",
        }
      : {}),
    status: "loaded",
    next: `Call ${entry.name} directly now with these parameters; it stays callable for the rest of this conversation.`,
  };
}

/** The control tool. Goes through the policy pipeline like any core tool. */
export function createToolDescribeTool(): AnyAgentTool {
  const deferredSchemaCatalog: DeferredSchemaCatalog = new Map();
  const tool: ToolDescribeTool = {
    name: TOOL_DESCRIBE_TOOL_NAME,
    label: "Tool Describe",
    description:
      "Load the full schema of one deferred-schema tool from the Tooling list. After this call the tool is callable by its own name for the rest of the conversation. Call tool_describe once per tool, and never for a tool that already has its schema.",
    parameters: Type.Object({
      name: Type.String({ description: "The exact tool name from the deferred-schema list." }),
    }),
    deferredSchemaCatalog,
    async execute(_toolCallId, params) {
      const raw = (params as { name?: unknown } | undefined)?.name;
      const name = typeof raw === "string" ? raw.trim() : "";
      const entry = name ? deferredSchemaCatalog.get(name) : undefined;
      if (!entry) {
        const names = [...deferredSchemaCatalog.keys()].toSorted();
        throw new ToolInputError(
          name
            ? `"${name}" is not a deferred-schema tool. Deferred-schema tools: ${names.join(", ") || "none"}. A tool already listed with its schema needs no tool_describe.`
            : "tool_describe needs the exact name of a deferred-schema tool.",
        );
      }
      return jsonResult(describeDeferredTool(entry));
    },
  };
  return tool;
}

export type ToolSchemaDeliveryPlan = {
  /** Every tool to register with the session, real names intact. */
  tools: AnyAgentTool[];
  /** Tools whose schemas ride in every request (eager tools, plus tool_describe when anything is deferred). */
  promptTools: AnyAgentTool[];
  /** Tools named in the prompt whose schema loads on demand. Empty when deferral is off for this run. */
  deferredTools: AnyAgentTool[];
  deferredToolNames: ReadonlySet<string>;
};

/**
 * Split policy-filtered tools into the schemas that ship on every request and
 * the ones the model loads on demand. When `tool_describe` did not survive
 * policy, or nothing is deferred, every schema ships and the describe tool is
 * dropped as pure overhead.
 */
export function planToolSchemaDelivery(tools: readonly AnyAgentTool[]): ToolSchemaDeliveryPlan {
  const describeTool = tools.find(isToolDescribeTool);
  const deferredTools = tools.filter(isDeferredSchemaTool);
  if (!describeTool || deferredTools.length === 0) {
    const eager = tools.filter((tool) => tool.name !== TOOL_DESCRIBE_TOOL_NAME);
    return { tools: eager, promptTools: eager, deferredTools: [], deferredToolNames: new Set() };
  }
  describeTool.deferredSchemaCatalog.clear();
  for (const tool of deferredTools) {
    describeTool.deferredSchemaCatalog.set(tool.name, tool);
  }
  const deferredToolNames = new Set(deferredTools.map((tool) => tool.name));
  return {
    tools: [...tools],
    promptTools: tools.filter((tool) => !deferredToolNames.has(tool.name)),
    deferredTools,
    deferredToolNames,
  };
}

type DirectoryTool = Pick<AnyAgentTool, "name" | "description" | "sharedPromptGuidance">;

/** The first sentence of the description, clipped; the schema is what stays out of the prompt. */
export function summarizeDeferredTool(tool: DirectoryTool): string {
  const normalized = (tool.description ?? "").replace(/\s+/g, " ").trim();
  const firstSentence = normalized.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? normalized;
  const clipped =
    firstSentence.length > DIRECTORY_SUMMARY_MAX_CHARS
      ? `${firstSentence.slice(0, DIRECTORY_SUMMARY_MAX_CHARS - 3).trimEnd()}...`
      : firstSentence;
  const summary = clipped || "No description.";
  return tool.sharedPromptGuidance ? `${summary} Asks the user for permission.` : summary;
}

/** `- name: summary` per deferred tool, sorted so the prompt prefix is stable. */
export function buildDeferredToolDirectoryLines(tools: readonly DirectoryTool[]): string[] {
  return [...tools]
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((tool) => `- ${tool.name}: ${summarizeDeferredTool(tool)}`);
}

/**
 * Deferred tools this conversation already loaded: any earlier call to the
 * tool itself (including one the loop refused before promotion) or a
 * `tool_describe` naming it. Rebuilt from the transcript on every turn, so a
 * restart forgets nothing and compaction simply asks for a fresh describe.
 */
export function collectPromotedToolNames(params: {
  entries: readonly unknown[];
  deferredToolNames: ReadonlySet<string>;
}): Set<string> {
  const promoted = new Set<string>();
  for (const entry of params.entries) {
    const record = entry as {
      type?: unknown;
      message?: { role?: unknown; content?: unknown };
    } | null;
    if (
      record?.type !== "message" ||
      record.message?.role !== "assistant" ||
      !Array.isArray(record.message.content)
    ) {
      continue;
    }
    for (const block of record.message.content) {
      const call = block as { type?: unknown; name?: unknown; arguments?: unknown } | null;
      if (call?.type !== "toolCall" || typeof call.name !== "string") {
        continue;
      }
      if (params.deferredToolNames.has(call.name)) {
        promoted.add(call.name);
        continue;
      }
      if (call.name !== TOOL_DESCRIBE_TOOL_NAME) {
        continue;
      }
      const target = (call.arguments as { name?: unknown } | null)?.name;
      if (typeof target === "string" && params.deferredToolNames.has(target.trim())) {
        promoted.add(target.trim());
      }
    }
  }
  return promoted;
}

/** The slice of a pi-coding-agent `AgentSession` the activation touches. */
export type ToolSchemaDeferralSession = {
  agent: {
    afterToolCall?: (
      context: AfterToolCallContext,
      signal?: AbortSignal,
    ) => Promise<AfterToolCallResult | undefined>;
    state: { tools: AgentTool[] };
  };
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
};

type Promotion = { name: string; directCall: boolean };

function resolvePromotion(
  ctx: AfterToolCallContext,
  override: AfterToolCallResult | undefined,
  deferredToolNames: ReadonlySet<string>,
): Promotion | undefined {
  const isError = override?.isError ?? ctx.isError;
  const name = ctx.toolCall.name;
  if (name === TOOL_DESCRIBE_TOOL_NAME) {
    if (isError) {
      return undefined;
    }
    const details = (override?.details ?? ctx.result.details) as
      | { tool?: unknown; status?: unknown }
      | undefined;
    return typeof details?.tool === "string" &&
      details.status === "loaded" &&
      deferredToolNames.has(details.tool)
      ? { name: details.tool, directCall: false }
      : undefined;
  }
  if (
    isError &&
    deferredToolNames.has(name) &&
    !(ctx.context.tools ?? []).some((tool) => tool.name === name)
  ) {
    // The loop answered "Tool <name> not found": the model skipped the describe.
    return { name, directCall: true };
  }
  return undefined;
}

/**
 * Make a deferred tool callable: for the turn in progress by adding it to the
 * loop's live tool list (the loop re-reads it on every request), and for the
 * rest of this run through the session's active set.
 */
function promoteTool(
  session: ToolSchemaDeferralSession,
  name: string,
  context: AgentContext,
): AgentTool | undefined {
  const active = session.getActiveToolNames();
  if (!active.includes(name)) {
    session.setActiveToolsByName([...active, name]);
  }
  const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return undefined;
  }
  const live = context.tools ?? (context.tools = []);
  if (!live.some((candidate) => candidate.name === name)) {
    live.push(tool);
  }
  return tool;
}

function installPromotionHook(
  session: ToolSchemaDeferralSession,
  deferredToolNames: ReadonlySet<string>,
): void {
  const prior = session.agent.afterToolCall;
  session.agent.afterToolCall = async (ctx, signal) => {
    const override = prior ? await prior(ctx, signal) : undefined;
    const promotion = resolvePromotion(ctx, override, deferredToolNames);
    if (!promotion) {
      return override;
    }
    const tool = promoteTool(session, promotion.name, ctx.context);
    if (!tool || !promotion.directCall) {
      return override;
    }
    return {
      ...override,
      content: [
        {
          type: "text",
          text: `${promotion.name} has a deferred schema that was not loaded yet. It is loaded now and callable for the rest of this conversation: call ${promotion.name} again with the same arguments.`,
        },
      ],
      isError: true,
    };
  };
}

/**
 * Apply a plan to a freshly created session: activate the eager tools plus the
 * deferred ones this conversation already loaded, and install the promotion
 * hook. With nothing deferred the session is left exactly as it was.
 */
export function activateToolSchemaDeferral(params: {
  session: ToolSchemaDeferralSession;
  plan: ToolSchemaDeliveryPlan;
  registeredToolNames: readonly string[];
  transcriptEntries: readonly unknown[];
}): { activeToolNames: string[]; promotedFromTranscript: string[] } {
  const { deferredToolNames } = params.plan;
  if (deferredToolNames.size === 0) {
    return { activeToolNames: [...params.registeredToolNames], promotedFromTranscript: [] };
  }
  const promoted = collectPromotedToolNames({
    entries: params.transcriptEntries,
    deferredToolNames,
  });
  const activeToolNames = params.registeredToolNames.filter(
    (name) => !deferredToolNames.has(name) || promoted.has(name),
  );
  params.session.setActiveToolsByName(activeToolNames);
  installPromotionHook(params.session, deferredToolNames);
  return { activeToolNames, promotedFromTranscript: [...promoted].toSorted() };
}
