import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversationSessionState,
  listConversationSessionStates,
  pruneShadowCheckpoints,
  readConversationSessionState,
  selectConversationSessionStatesForPruning,
  writeShadowCheckpoint,
  writeConversationSessionState,
} from "./checkpoint-state.js";

describe("checkpoint session state", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "magister-checkpoint-state-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists pending cursors, prepared summaries, and frozen recall across restarts", async () => {
    const sessionHash = "a".repeat(32);
    const state = createConversationSessionState({ sessionHash, agentId: "marketing" });
    state.lastMessageFingerprint = "1".repeat(64);
    state.lastMessageCount = 4;
    state.recallFrozen = true;
    state.frozenRecall = "recent header";
    state.inFlight = {
      checkpointId: "checkpoint-123",
      entries: [{ role: "user", text: "Remember this", fingerprint: "2".repeat(64) }],
      startedAt: 10,
      sequence: 1,
      startFingerprint: "2".repeat(64),
      endFingerprint: "2".repeat(64),
      prepared: {
        summary: "A durable preference",
        topics: ["preference"],
        source: "model",
      },
    };
    await writeConversationSessionState(dir, state);

    const reloaded = await readConversationSessionState({
      workspaceDir: dir,
      sessionHash,
      agentId: "main",
    });
    expect(reloaded).toEqual(state);
    expect(await listConversationSessionStates(dir)).toEqual([state]);
  });

  it("selects ended, expired, and excess quiescent sessions while preserving active state", () => {
    const states = ["a", "b", "c", "d"].map((prefix, index) => {
      const state = createConversationSessionState({
        sessionHash: prefix.repeat(32),
        agentId: "marketing",
      });
      state.updatedAt = (index + 1) * 1_000;
      return state;
    });
    states[1].endedAt = 4_500;
    states[3].pending = [
      { role: "user", text: "Active conversation", fingerprint: "1".repeat(64) },
    ];

    expect(
      selectConversationSessionStatesForPruning({
        states,
        nowMs: 5_000,
        retentionMs: 3_500,
        maxStates: 2,
      }).toSorted(),
    ).toEqual(["a".repeat(32), "b".repeat(32)]);
  });

  it("bounds shadow proposals by age and count", async () => {
    for (const [checkpointId, createdAt] of [
      ["old", 1_000],
      ["middle", 8_000],
      ["new", 9_000],
    ] as const) {
      await writeShadowCheckpoint({
        workspaceDir: dir,
        checkpointId,
        sessionHash: checkpointId.padEnd(32, "a"),
        sequence: 1,
        createdAt,
        summary: { summary: checkpointId, topics: [], source: "model" },
      });
    }

    expect(
      await pruneShadowCheckpoints({
        workspaceDir: dir,
        nowMs: 10_000,
        retentionMs: 5_000,
        maxFiles: 1,
      }),
    ).toBe(2);
    expect(
      await readdir(join(dir, ".magister", "state", "conversation-checkpoints", "shadow")),
    ).toEqual(["new.json"]);
  });
});
