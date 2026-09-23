import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConversationSessionState } from "./checkpoint-state.js";
import { parseCheckpointRecords } from "./checkpoint-store.js";
import { resolveConversationCheckpointConfig } from "./conversation-config.js";
import { ConversationCheckpointManager } from "./conversation-manager.js";
import { hashIdentifier } from "./conversation-text.js";

describe("conversation checkpoint integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "magister-conversation-manager-"));
    delete process.env.GATEWAY_TOKEN;
    delete process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("captures a short chat and freezes its bounded recall in the next session", async () => {
    const evidence = "Our target audience is independent dental practices.";
    const preferenceEvidence = "Please keep reports concise.";
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [
        {
          text: JSON.stringify({
            summary:
              "The project targets independent dental practices and the initial audience definition is complete.",
            topics: ["target audience", "reporting style"],
          }),
        },
      ],
    }));
    const api = makeApi(runEmbeddedPiAgent);
    const config = resolveConversationCheckpointConfig(
      { conversationCheckpoints: { mode: "active" } },
      null,
    );
    const manager = new ConversationCheckpointManager(api, config);
    const firstContext = {
      agentId: "marketing",
      sessionId: "session-one",
      sessionKey: "agent:marketing:web:user-one",
      workspaceDir: dir,
      trigger: "user",
    };
    expect(await manager.buildPromptContext(firstContext)).toBeUndefined();
    expect(
      (
        await readConversationSessionState({
          workspaceDir: dir,
          sessionHash: hashIdentifier(firstContext.sessionId),
          agentId: "marketing",
        })
      ).recallFrozen,
    ).toBe(false);
    await manager.captureAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: `${evidence} ${preferenceEvidence}` },
          {
            role: "assistant",
            content: "I documented the audience and will use it to shape the campaign strategy.",
          },
        ],
      },
      firstContext,
    );
    await manager.finalizeSessionForTest({
      workspaceDir: dir,
      sessionHash: hashIdentifier(firstContext.sessionId),
    });

    expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "magister-gateway",
        model: "anthropic/claude-haiku-4-5",
        disableTools: true,
        // Identity line only: the summary must not carry the agent's skills
        // catalog and tooling prompt (~27k tokens) for a 12k-char transcript.
        promptMode: "none",
        bootstrapContextMode: "lightweight",
        reasoningLevel: "off",
        streamParams: { maxTokens: 512 },
        cleanupBundleMcpOnRunEnd: true,
        timeoutMs: 30_000,
        // Magister fork: an explicit session key is what puts X-Session-Id on
        // the outbound LLM request, so the gateway can route this summary to
        // the cheap platform-funded model instead of the project's chat model.
        sessionKey: expect.stringMatching(/^conversation-checkpoint-/),
      }),
    );
    await expect(access(join(dir, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(dir, "USER.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const newContext = {
      agentId: "marketing",
      sessionId: "session-two",
      sessionKey: firstContext.sessionKey,
      workspaceDir: dir,
      trigger: "user",
    };
    const recall = await manager.buildPromptContext(newContext);
    expect(recall).toContain("Recent chats:");
    expect(recall).toContain("independent dental practices");
    expect(await manager.buildPromptContext(newContext)).toBe(recall);
    // Frozen recall is part of the cached prompt prefix: a non-user turn on
    // the same session must keep it, not drop and later restore it.
    expect(await manager.buildPromptContext({ ...newContext, trigger: "manual" })).toBe(recall);
    // A session that never froze recall still gets none from a non-user turn.
    expect(
      await manager.buildPromptContext({
        ...newContext,
        sessionId: "session-three",
        trigger: "manual",
      }),
    ).toBeUndefined();
  });

  it("excludes the current session while allowing late recall from another session", async () => {
    const summaries = [
      {
        summary: "The current session produced its own campaign checkpoint.",
        topics: ["current campaign"],
      },
      {
        summary: "Another project session approved the launch positioning.",
        topics: ["launch positioning"],
      },
    ];
    const runEmbeddedPiAgent = vi.fn(async () => {
      const summary = summaries.shift();
      if (!summary) {
        throw new Error("unexpected summary request");
      }
      return { payloads: [{ text: JSON.stringify(summary) }] };
    });
    const api = makeApi(runEmbeddedPiAgent);
    const config = resolveConversationCheckpointConfig(
      { conversationCheckpoints: { mode: "active" } },
      null,
    );
    const manager = new ConversationCheckpointManager(api, config);
    const currentContext = {
      agentId: "marketing",
      sessionId: "current-session",
      workspaceDir: dir,
      trigger: "user",
    };
    const otherContext = {
      ...currentContext,
      sessionId: "other-session",
    };

    expect(await manager.buildPromptContext(currentContext)).toBeUndefined();
    await manager.captureAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "Build the detailed campaign plan for this session." },
          { role: "assistant", content: "The campaign plan and milestones are complete." },
        ],
      },
      currentContext,
    );
    await manager.finalizeSessionForTest({
      workspaceDir: dir,
      sessionHash: hashIdentifier(currentContext.sessionId),
    });

    expect(await manager.buildPromptContext(currentContext)).toBeUndefined();

    await manager.captureAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "Approve the detailed positioning in another session." },
          { role: "assistant", content: "The launch positioning is approved." },
        ],
      },
      otherContext,
    );
    await manager.finalizeSessionForTest({
      workspaceDir: dir,
      sessionHash: hashIdentifier(otherContext.sessionId),
    });

    const recall = await manager.buildPromptContext(currentContext);
    expect(recall).toContain("Another project session approved the launch positioning.");
    expect(recall).not.toContain("current session produced its own campaign checkpoint");
    expect(await manager.buildPromptContext(currentContext)).toBe(recall);
  });

  it("removes quiescent session state after a session-end checkpoint", async () => {
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [
        {
          text: JSON.stringify({
            summary: "The completed planning session produced a launch decision.",
            topics: ["launch"],
          }),
        },
      ],
    }));
    const api = makeApi(runEmbeddedPiAgent);
    const config = resolveConversationCheckpointConfig(
      { conversationCheckpoints: { mode: "active" } },
      null,
    );
    const manager = new ConversationCheckpointManager(api, config);
    const ctx = {
      agentId: "marketing",
      sessionId: "ended-session",
      workspaceDir: dir,
      trigger: "user",
    };
    const sessionHash = hashIdentifier(ctx.sessionId);
    await manager.captureAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "Complete the detailed campaign launch plan." },
          { role: "assistant", content: "The launch plan and decision are complete." },
        ],
      },
      ctx,
    );

    manager.scheduleSessionEnd(ctx);

    const statePath = join(
      dir,
      ".magister",
      "state",
      "conversation-checkpoints",
      "sessions",
      `${sessionHash}.json`,
    );
    await vi.waitFor(async () => {
      expect(
        await readFile(join(dir, "memory", `${new Date().toISOString().slice(0, 10)}.md`), "utf8"),
      ).toContain("completed planning session");
      await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("checkpoints a meaningful short chat after the idle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 6, 22, 12));
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [
        {
          text: JSON.stringify({
            summary: "The short launch-planning chat produced a concrete next step.",
            topics: ["launch planning"],
          }),
        },
      ],
    }));
    const api = makeApi(runEmbeddedPiAgent);
    const config = resolveConversationCheckpointConfig(
      { conversationCheckpoints: { mode: "active", idleMinutes: 1 } },
      null,
    );
    const manager = new ConversationCheckpointManager(api, config);
    manager.start(dir);
    await manager.captureAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "Please map the launch campaign and its next milestone." },
          { role: "assistant", content: "The campaign sequence and next milestone are ready." },
        ],
      },
      {
        agentId: "marketing",
        sessionId: "idle-session",
        workspaceDir: dir,
        trigger: "user",
      },
    );

    await vi.advanceTimersByTimeAsync(60_001);
    await vi.waitFor(async () => {
      expect(await readFile(join(dir, "memory", "2026-07-22.md"), "utf8")).toContain(
        "short launch-planning chat",
      );
    });
    manager.stop();
    expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
  });

  it("honors retry deadlines and writes a deterministic fallback after three failures", async () => {
    vi.useFakeTimers();
    const startedAt = Date.UTC(2026, 6, 22, 12);
    vi.setSystemTime(startedAt);
    const runEmbeddedPiAgent = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const api = makeApi(runEmbeddedPiAgent);
    const config = resolveConversationCheckpointConfig(
      { conversationCheckpoints: { mode: "active" } },
      null,
    );
    const manager = new ConversationCheckpointManager(api, config);
    const ctx = {
      agentId: "marketing",
      sessionId: "retry-session",
      sessionKey: "agent:marketing:web:retry-user",
      workspaceDir: dir,
      trigger: "user",
    };
    const sessionHash = hashIdentifier(ctx.sessionId);
    await manager.captureAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "Please prepare the launch plan for our dental campaign." },
          { role: "assistant", content: "I prepared the launch plan and captured next steps." },
        ],
      },
      ctx,
    );

    await manager.finalizeSessionForTest({ workspaceDir: dir, sessionHash });
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    let state = await readConversationSessionState({
      workspaceDir: dir,
      sessionHash,
      agentId: "marketing",
    });
    expect(state).toMatchObject({ retryCount: 1, retryAt: startedAt + 60_000 });
    expect(state.pending).toHaveLength(2);

    await manager.finalizeSessionForTest({ workspaceDir: dir, sessionHash });
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);

    vi.setSystemTime(startedAt + 60_001);
    await manager.finalizeSessionForTest({ workspaceDir: dir, sessionHash });
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(2);

    vi.setSystemTime(startedAt + 60_001 + 5 * 60_000 + 1);
    await manager.finalizeSessionForTest({ workspaceDir: dir, sessionHash });
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(3);
    expect(await readFile(join(dir, "memory", "2026-07-22.md"), "utf8")).toContain(
      "Conversation checkpoint",
    );
    state = await readConversationSessionState({
      workspaceDir: dir,
      sessionHash,
      agentId: "marketing",
    });
    expect(state).toMatchObject({ retryCount: 0, sequence: 1, pending: [] });
    expect(state.inFlight).toBeUndefined();
  });

  it("records proposals without touching canonical memory in shadow mode", async () => {
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [
        {
          text: JSON.stringify({
            summary: "The user completed a detailed campaign planning conversation.",
            topics: ["campaign planning"],
          }),
        },
      ],
    }));
    const api = makeApi(runEmbeddedPiAgent);
    const config = resolveConversationCheckpointConfig(
      { conversationCheckpoints: { mode: "shadow" } },
      null,
    );
    const manager = new ConversationCheckpointManager(api, config);
    const ctx = {
      agentId: "marketing",
      sessionKey: "agent:marketing:web:shadow-user",
      workspaceDir: dir,
      trigger: "user",
    };
    const sessionHash = hashIdentifier(ctx.sessionKey);
    await manager.captureAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "Let's create a detailed campaign plan for the new launch." },
          { role: "assistant", content: "The campaign phases and launch criteria are now ready." },
        ],
      },
      ctx,
    );
    await manager.finalizeSessionForTest({ workspaceDir: dir, sessionHash });

    await expect(access(join(dir, "memory"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(dir, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const shadowDir = join(dir, ".magister", "state", "conversation-checkpoints", "shadow");
    const shadowFiles = await readdir(shadowDir);
    expect(shadowFiles).toHaveLength(1);
    expect(await readFile(join(shadowDir, shadowFiles[0]), "utf8")).toContain(
      "campaign planning conversation",
    );
  });

  it("defers a prepared write failure and reuses its model output, id, and date", async () => {
    vi.useFakeTimers();
    const startedAt = Date.UTC(2026, 6, 22, 23, 59);
    vi.setSystemTime(startedAt);
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [
        {
          text: JSON.stringify({
            summary: "The user completed a detailed launch planning conversation.",
            topics: ["launch planning"],
          }),
        },
      ],
    }));
    const api = makeApi(runEmbeddedPiAgent);
    const config = resolveConversationCheckpointConfig(
      { conversationCheckpoints: { mode: "active" } },
      null,
    );
    const manager = new ConversationCheckpointManager(api, config);
    const ctx = {
      agentId: "marketing",
      sessionId: "prepared-retry-session",
      workspaceDir: dir,
      trigger: "user",
    };
    const sessionHash = hashIdentifier(ctx.sessionId);
    await manager.captureAgentEnd(
      {
        success: true,
        messages: [
          { role: "user", content: "Please build the detailed launch sequence for the campaign." },
          { role: "assistant", content: "The launch sequence and handoff are complete." },
        ],
      },
      ctx,
    );
    await writeFile(join(dir, "memory"), "blocks the daily directory", "utf8");

    await expect(
      manager.finalizeSessionForTest({ workspaceDir: dir, sessionHash }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    let state = await readConversationSessionState({
      workspaceDir: dir,
      sessionHash,
      agentId: "marketing",
    });
    expect(state.inFlight?.prepared?.summary).toContain("launch planning");
    expect(state.inFlight?.startedAt).toBe(startedAt);
    expect(state.retryAt).toBe(startedAt + 5 * 60_000);
    const checkpointId = state.inFlight?.checkpointId;
    if (!checkpointId) {
      throw new Error("prepared checkpoint id missing");
    }

    await manager.finalizeSessionForTest({ workspaceDir: dir, sessionHash });
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);

    await rm(join(dir, "memory"), { force: true });
    await mkdir(join(dir, "memory"));
    vi.setSystemTime(startedAt + 5 * 60_000 + 1);
    await manager.finalizeSessionForTest({ workspaceDir: dir, sessionHash });
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const daily = await readFile(join(dir, "memory", "2026-07-22.md"), "utf8");
    expect(parseCheckpointRecords(daily).map((record) => record.checkpointId)).toEqual([
      checkpointId,
    ]);
    await expect(access(join(dir, "memory", "2026-07-23.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    state = await readConversationSessionState({
      workspaceDir: dir,
      sessionHash,
      agentId: "marketing",
    });
    expect(state).toMatchObject({ sequence: 1, retryCount: 0 });
    expect(state.inFlight).toBeUndefined();
  });

  it("ignores failed, non-user, and reviewer runs", async () => {
    const runEmbeddedPiAgent = vi.fn();
    const api = makeApi(runEmbeddedPiAgent);
    const config = resolveConversationCheckpointConfig(
      { conversationCheckpoints: { mode: "active" } },
      null,
    );
    const manager = new ConversationCheckpointManager(api, config);
    const messages = [
      { role: "user", content: "This is a detailed conversation that would normally be saved." },
      { role: "assistant", content: "I completed the detailed project work." },
    ];
    await manager.captureAgentEnd(
      { success: false, messages },
      { sessionId: "failed", workspaceDir: dir, trigger: "user" },
    );
    await manager.captureAgentEnd(
      { success: true, messages },
      { sessionId: "manual", workspaceDir: dir, trigger: "manual" },
    );
    await manager.captureAgentEnd(
      { success: true, messages },
      { agentId: "reviewer", sessionId: "review", workspaceDir: dir, trigger: "user" },
    );
    for (const sessionId of ["failed", "manual", "review"]) {
      await manager.finalizeSessionForTest({
        workspaceDir: dir,
        sessionHash: hashIdentifier(sessionId),
      });
    }
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("finalizes pre-compaction capture once when the transcript is seen again", async () => {
    const runEmbeddedPiAgent = vi.fn(async () => ({
      payloads: [
        {
          text: JSON.stringify({
            summary: "The long planning chat reached a stable pre-compaction checkpoint.",
            topics: ["planning"],
          }),
        },
      ],
    }));
    const api = makeApi(runEmbeddedPiAgent);
    const config = resolveConversationCheckpointConfig(
      { conversationCheckpoints: { mode: "active" } },
      null,
    );
    const manager = new ConversationCheckpointManager(api, config);
    const ctx = {
      agentId: "marketing",
      sessionId: "compaction-session",
      workspaceDir: dir,
      trigger: "user",
    };
    const checkpointDate = new Date().toISOString().slice(0, 10);
    const messages = [
      { role: "user", content: "Build the complete launch plan with channels and milestones." },
      { role: "assistant", content: "The channel plan and all milestones are complete." },
    ];
    await manager.captureAgentEnd({ success: true, messages }, ctx);
    await manager.captureBeforeCompaction(messages, ctx);
    const sessionHash = hashIdentifier(ctx.sessionId);
    await vi.waitFor(async () => {
      const state = await readConversationSessionState({
        workspaceDir: dir,
        sessionHash,
        agentId: "marketing",
      });
      expect(state.sequence).toBe(1);
    });

    await manager.captureBeforeCompaction(messages, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const daily = await readFile(join(dir, "memory", `${checkpointDate}.md`), "utf8");
    expect(parseCheckpointRecords(daily)).toHaveLength(1);
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
  });

  function makeApi(runEmbeddedPiAgent: ReturnType<typeof vi.fn>): OpenClawPluginApi {
    return {
      config: {
        agents: {
          list: [{ id: "marketing", workspace: dir }],
          defaults: { userTimezone: "UTC" },
        },
      },
      pluginConfig: {
        conversationCheckpoints: { mode: "active" },
      },
      runtime: {
        agent: {
          resolveAgentDir: () => dir,
          runEmbeddedPiAgent,
        },
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as OpenClawPluginApi;
  }
});
