import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  definePluginEntry,
  jsonResult,
  KeyedAsyncQueue,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { withContextLock } from "./context-lock.js";
import { resolveConversationCheckpointConfig } from "./conversation-config.js";
import { ConversationCheckpointManager } from "./conversation-manager.js";
import { MemoryStore, type MemoryTarget } from "./memory-store.js";
import { memoryOperationId, withHostMutationBoundary } from "./mutation-boundary.js";

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

const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
const DEFAULT_USER_CHAR_LIMIT = 1375;

// Serializes load→mutate→persist per memory file across concurrent agent
// turns in this process (up to 4 run in parallel on the `main` lane, plus
// cron). Without this, two turns can both loadFromDisk(), then the second
// persist() silently drops the first turn's entry (last-writer-wins).
const memoryWriteQueue = new KeyedAsyncQueue();

type MemoryPluginConfig = {
  enabled?: boolean;
  memoryCharLimit?: number;
  userCharLimit?: number;
  conversationCheckpoints?: unknown;
};

type MemoryToolParams = {
  action?: string;
  target?: string;
  content?: string;
  old_text?: string;
};

const TOOL_DESCRIPTION = `Persistent curated memory. Two stores, one tool.

target='memory' — what you've learned about the project/business (brand voice, audience, patterns).
target='user'   — what you've learned about the user (name, preferences, working style).

Both are loaded into your system prompt at session start and stay frozen for the session.
Writes here go to disk immediately and appear in the NEXT session's system prompt.

Use sparingly. Char limits are tight — every entry must be a single, durable, single-line fact.
If you can't summarize it in 20 words, it's not memory, it's a task note.`;

function resolveWorkspaceDir(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext): string {
  if (ctx.workspaceDir) {
    return ctx.workspaceDir;
  }
  const agentId = ctx.agentId ?? "main";
  return resolveAgentWorkspaceDir(api.config, agentId);
}

function resolveConfig(api: OpenClawPluginApi): {
  memoryCharLimit: number;
  userCharLimit: number;
  enabled: boolean;
} {
  const cfg = (api.pluginConfig ?? {}) as MemoryPluginConfig;
  return {
    enabled: cfg.enabled !== false,
    memoryCharLimit: cfg.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: cfg.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT,
  };
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
      old_text: Type.Optional(
        Type.String({
          description:
            "Required for replace/remove. A short unique substring of the entry to modify.",
        }),
      ),
    }),
    async execute(callId: string, rawParams: Record<string, unknown>) {
      const params = rawParams as MemoryToolParams;
      const action = params.action;
      const target: MemoryTarget = params.target === "user" ? "user" : "memory";
      const workspaceDir = resolveWorkspaceDir(api, ctx);

      return memoryWriteQueue.enqueue(`${workspaceDir}:${target}`, async () =>
        withContextLock(workspaceDir, async () => {
          const store = new MemoryStore({
            memoryDir: workspaceDir,
            memoryCharLimit: cfg.memoryCharLimit,
            userCharLimit: cfg.userCharLimit,
            mutationBoundary: (writeTarget, content, write) =>
              withHostMutationBoundary(
                {
                  operationId: memoryOperationId(callId, String(action), writeTarget),
                  target: writeTarget,
                  content,
                },
                write,
              ),
          });
          await store.loadFromDisk();

          if (action === "add") {
            if (!params.content) {
              return jsonResult({
                success: false,
                target,
                message: "content is required for add",
              });
            }
            const res = await store.add(target, params.content);
            return jsonResult(res);
          }

          if (action === "replace") {
            if (!params.old_text || !params.content) {
              return jsonResult({
                success: false,
                target,
                message: "old_text and content are required for replace",
              });
            }
            const res = await store.replace(target, params.old_text, params.content);
            return jsonResult(res);
          }

          if (action === "remove") {
            if (!params.old_text) {
              return jsonResult({
                success: false,
                target,
                message: "old_text is required for remove",
              });
            }
            const res = await store.remove(target, params.old_text);
            return jsonResult(res);
          }

          return jsonResult({
            success: false,
            target,
            message: `Unknown action: ${String(action)}`,
          });
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
    api.registerTool((ctx) => createMemoryTool(api, ctx), { name: "memory" });
    api.on("agent_end", async (event, ctx) => {
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
      try {
        const recentContext = await checkpointManager.buildPromptContext(ctx);
        return buildPromptBuildHookResult(recentContext);
      } catch {
        api.logger.warn("magister-memory: recent conversation recall failed");
        return undefined;
      }
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
export { MemoryStore } from "./memory-store.js";
export { scanMemoryContent } from "./threat-scan.js";
export { ConversationCheckpointManager } from "./conversation-manager.js";
export { resolveConversationCheckpointConfig } from "./conversation-config.js";
