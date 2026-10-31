import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  definePluginEntry,
  jsonResult,
  KeyedAsyncQueue,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import {
  applyBrandMemory,
  type BrandMemoryOperation,
  syncMarketingContext,
  syncBrandMemory,
} from "./brand-memory.js";
import { withContextLock } from "./context-lock.js";
import { resolveConversationCheckpointConfig } from "./conversation-config.js";
import { ConversationCheckpointManager } from "./conversation-manager.js";
import { type MemoryResult, UserMemoryStore } from "./memory-store.js";
import { memoryOperationId, withHostMutationBoundary } from "./mutation-boundary.js";
import { isInteractiveSession, resolveTurnBudgetConfig, TurnBudget } from "./turn-budget.js";

/**
 * Where session recall lands in the system prompt.
 *
 * `appendSystemContext`, never `prependSystemContext`: the hook runner puts a
 * prepended block at the very front of the prompt, above the ~100k-token
 * stable prefix that every provider caches. Recall differs per session (it
 * excludes the current one), so at the front it made every new session a cold
 * cache write and, when a non-user turn dropped it, re-wrote the prefix
 * mid-session. Appended, it sits below the cache boundary with the other
 * per-session context, where a change costs the small dynamic block only.
 */
export function buildPromptBuildHookResult(
  recentContext: string | undefined,
): { appendSystemContext: string } | undefined {
  return recentContext ? { appendSystemContext: recentContext } : undefined;
}

const DEFAULT_USER_CHAR_LIMIT = 1375;

// Serializes every write per memory file across concurrent agent turns in
// this process (up to 4 run in parallel on the `main` lane, plus cron).
// Without this, two USER.md writes can both loadFromDisk(), then the second
// persist() silently drops the first turn's entry (last-writer-wins); and an
// older brand-memory reply could overwrite MEMORY.md after a newer one.
const memoryWriteQueue = new KeyedAsyncQueue();

type MemoryPluginConfig = {
  enabled?: boolean;
  userCharLimit?: number;
  conversationCheckpoints?: unknown;
};

type MemoryToolParams = {
  action?: string;
  target?: string;
  content?: string;
  old_text?: string;
  entry_id?: string;
  scope?: Record<string, string>;
  expected_revision?: number;
};

const TOOL_DESCRIPTION = `Persistent curated memory. Two stores, one tool.

target='memory' — the brand's rules and facts (voice, audience, what to avoid), including what the user tells you about the brand. Shared: every Magister agent working on this brand reads it.
target='user'   — only facts about the person (name, role, working style).

Both load into your system prompt at each turn; changes from other agents appear on the next turn.

Save concise, durable facts the user confirmed. For brand rules, scope channel/account-specific preferences and replace contradictions by entry_id or unique old_text; expected_revision guards concurrent corrections. Use magister_record_marketing_feedback for item-specific corrections and reasons.`;

function resolveWorkspaceDir(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext): string {
  if (ctx.workspaceDir) {
    return ctx.workspaceDir;
  }
  const agentId = ctx.agentId ?? "main";
  return resolveAgentWorkspaceDir(api.config, agentId);
}

function resolveConfig(api: OpenClawPluginApi): {
  userCharLimit: number;
  enabled: boolean;
} {
  const cfg = (api.pluginConfig ?? {}) as MemoryPluginConfig;
  return {
    enabled: cfg.enabled !== false,
    userCharLimit: cfg.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT,
  };
}

/** Validate the tool's arguments; the error message is the tool's answer. */
function readOperation(params: MemoryToolParams): BrandMemoryOperation | { error: string } {
  const shared = {
    ...(params.entry_id ? { entry_id: params.entry_id } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.expected_revision !== undefined
      ? { expected_revision: params.expected_revision }
      : {}),
  };
  if (params.action === "add") {
    return params.content
      ? { ...shared, action: "add", content: params.content }
      : { error: "content is required for add" };
  }
  if (params.action === "replace") {
    return (params.old_text || params.entry_id) && params.content
      ? { ...shared, action: "replace", old_text: params.old_text, content: params.content }
      : { error: "old_text and content are required for replace" };
  }
  if (params.action === "remove") {
    return params.old_text || params.entry_id
      ? { ...shared, action: "remove", old_text: params.old_text }
      : { error: "old_text is required for remove" };
  }
  return { error: `Unknown action: ${String(params.action)}` };
}

function createMemoryTool(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext) {
  const cfg = resolveConfig(api);
  if (!cfg.enabled) {
    return null;
  }

  return {
    name: "memory",
    label: "Memory",
    description: TOOL_DESCRIPTION,
    parameters: Type.Object({
      action: Type.String({ enum: ["add", "replace", "remove"] }),
      target: Type.Optional(Type.String({ enum: ["memory", "user"] })),
      content: Type.Optional(
        Type.String({ description: "Required for add/replace. The new entry text." }),
      ),
      entry_id: Type.Optional(
        Type.String({
          description: "Brand rule id for an exact replace/remove, instead of old_text.",
        }),
      ),
      expected_revision: Type.Optional(Type.Integer({ minimum: 0 })),
      scope: Type.Optional(
        Type.Object(
          {
            channel: Type.Optional(Type.String({ maxLength: 500 })),
            connection_instance_key: Type.Optional(Type.String({ maxLength: 500 })),
            resource_id: Type.Optional(Type.String({ maxLength: 500 })),
            objective: Type.Optional(Type.String({ maxLength: 500 })),
            audience: Type.Optional(Type.String({ maxLength: 500 })),
          },
          { additionalProperties: false },
        ),
      ),
      old_text: Type.Optional(
        Type.String({
          description:
            "Required for replace/remove. A short unique substring of the entry to modify.",
        }),
      ),
    }),
    async execute(callId: string, rawParams: Record<string, unknown>) {
      const params = rawParams as MemoryToolParams;
      const target = params.target === "user" ? "user" : "memory";
      const workspaceDir = resolveWorkspaceDir(api, ctx);
      const operation = readOperation(params);
      if ("error" in operation) {
        return jsonResult({ success: false, target, message: operation.error });
      }

      if (target === "memory") {
        return memoryWriteQueue.enqueue(`${workspaceDir}:memory`, async () =>
          jsonResult(await applyBrandMemory(workspaceDir, operation)),
        );
      }

      if (operation.action !== "add" && !operation.old_text) {
        return jsonResult({
          success: false,
          target,
          message: "old_text is required for personal memory",
        });
      }
      return memoryWriteQueue.enqueue(`${workspaceDir}:user`, async () =>
        withContextLock(workspaceDir, async () => {
          const store = new UserMemoryStore({
            memoryDir: workspaceDir,
            charLimit: cfg.userCharLimit,
            mutationBoundary: (content, write) =>
              withHostMutationBoundary(
                { operationId: memoryOperationId(callId, operation.action, "user"), content },
                write,
              ),
          });
          await store.loadFromDisk();
          let res: MemoryResult;
          if (operation.action === "add") {
            res = await store.add(operation.content);
          } else if (operation.action === "replace") {
            res = await store.replace(operation.old_text ?? "", operation.content);
          } else {
            res = await store.remove(operation.old_text ?? "");
          }
          return jsonResult(res);
        }),
      );
    },
  };
}

export default definePluginEntry({
  id: "magister-memory",
  name: "Magister Memory",
  description:
    "Bounded curated memory with episodic conversation checkpoints and recent-chat continuity.",
  register(api) {
    const checkpointManager = new ConversationCheckpointManager(
      api,
      resolveConversationCheckpointConfig(api.pluginConfig),
    );
    const turnBudget = new TurnBudget(resolveTurnBudgetConfig(api.pluginConfig?.turnBudget));
    api.registerTool((ctx) => createMemoryTool(api, ctx), { name: "memory" });
    // Brand memory lives on the Gateway; refresh this machine's MEMORY.md copy
    // on every turn. before_model_resolve is awaited at the start of every
    // run, before the run resolves its context engine, whose first assemble()
    // reads MEMORY.md into the prompt (session_start is fire and forget, and
    // before_prompt_build runs after assemble()).
    if (resolveConfig(api).enabled) {
      api.on("before_model_resolve", async (_event, ctx) => {
        const workspaceDir =
          ctx.workspaceDir ?? resolveAgentWorkspaceDir(api.config, ctx.agentId ?? "main");
        try {
          await memoryWriteQueue.enqueue(`${workspaceDir}:memory`, async () => {
            // Complete the one-time legacy import before fetching modern context.
            // A failed import must not prevent fresh shared context from being read.
            try {
              await syncBrandMemory(workspaceDir);
            } finally {
              await syncMarketingContext(workspaceDir);
            }
          });
        } catch (error) {
          api.logger.warn(
            `magister-memory: brand memory sync failed, keeping the local MEMORY.md (${
              error instanceof Error ? error.message : String(error)
            })`,
          );
        }
        return undefined;
      });
    }
    api.on("agent_end", async (event, ctx) => {
      turnBudget.end(event.runId ?? ctx.runId);
      try {
        await checkpointManager.captureAgentEnd(event, ctx);
      } catch {
        api.logger.warn("magister-memory: conversation capture failed");
      }
    });
    api.on("before_compaction", async (event, ctx) => {
      try {
        await checkpointManager.captureBeforeCompaction(event.messages, ctx);
      } catch {
        api.logger.warn("magister-memory: pre-compaction capture failed");
      }
    });
    api.on("session_end", (event, ctx) => {
      checkpointManager.scheduleSessionEnd({
        ...ctx,
        sessionId: event.sessionId,
        sessionKey: event.sessionKey ?? ctx.sessionKey,
      });
    });
    api.on("before_prompt_build", async (_event, ctx) => {
      if (isInteractiveSession(ctx.sessionKey)) {
        turnBudget.start(ctx.runId);
      }
      try {
        const recentContext = await checkpointManager.buildPromptContext(ctx);
        return buildPromptBuildHookResult(recentContext);
      } catch {
        api.logger.warn("magister-memory: recent conversation recall failed");
        return undefined;
      }
    });
    // Turn budget (turn-budget.ts): once a run in a chat has worked N minutes
    // or M tool calls without replying, the next tool call is vetoed with the
    // nudge as its result, the way the tool-loop detector delivers its warning.
    api.on("before_tool_call", (event, ctx) => {
      if (!isInteractiveSession(ctx.sessionKey)) {
        return undefined;
      }
      const nudge = turnBudget.noteToolCall(
        event.runId ?? ctx.runId,
        event.toolName,
        event.toolCallId ?? ctx.toolCallId,
      );
      if (!nudge) {
        return undefined;
      }
      api.logger.info(`magister-memory: turn budget nudge for ${event.toolName}`);
      return { block: true, blockReason: nudge };
    });
    api.on("after_tool_call", (event, ctx) => {
      turnBudget.noteToolEnd(event.runId ?? ctx.runId, event.toolCallId ?? ctx.toolCallId);
    });
    api.registerService({
      id: "magister-memory-conversation-checkpoints",
      start: (ctx) => checkpointManager.start(ctx.workspaceDir),
      stop: () => checkpointManager.stop(),
    });
  },
});

// Re-exports for unit tests.
export { createMemoryTool };
export { UserMemoryStore } from "./memory-store.js";
export { scanMemoryContent } from "./threat-scan.js";
export { ConversationCheckpointManager } from "./conversation-manager.js";
export { resolveConversationCheckpointConfig } from "./conversation-config.js";
