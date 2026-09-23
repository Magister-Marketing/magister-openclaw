import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCheckpoint,
  formatDateInTimezone,
  listRecentCheckpoints,
  parseCheckpointRecords,
  serializeCheckpoint,
} from "./checkpoint-store.js";
import { withContextLock } from "./context-lock.js";
import type { CheckpointRecord } from "./conversation-types.js";

describe("checkpoint store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "magister-checkpoint-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends idempotent structured blocks without changing unmarked notes", async () => {
    const createdAt = Date.UTC(2026, 6, 22, 2, 0, 0);
    const date = formatDateInTimezone(createdAt, "America/Los_Angeles");
    const path = join(dir, "memory", `${date}.md`);
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(path, "  Hand-written note with **spacing**.  ", "utf8");
    const record = makeRecord({ createdAt });

    expect(
      (await appendCheckpoint({ workspaceDir: dir, userTimezone: "America/Los_Angeles", record }))
        .appended,
    ).toBe(true);
    expect(
      (await appendCheckpoint({ workspaceDir: dir, userTimezone: "America/Los_Angeles", record }))
        .appended,
    ).toBe(false);

    const markdown = await readFile(path, "utf8");
    expect(markdown.startsWith("  Hand-written note with **spacing**.  \n\n")).toBe(true);
    expect(parseCheckpointRecords(markdown)).toEqual([record]);
  });

  it("ignores malformed markers", () => {
    const valid = makeRecord({ createdAt: Date.now() });
    const markdown = `<!-- magister-checkpoint:v1:not-base64 -->\nbad\n<!-- /magister-checkpoint -->\n\n${serializeCheckpoint(valid)}`;
    expect(parseCheckpointRecords(markdown)).toEqual([valid]);
  });

  it("recovers a valid record after an unterminated marker", () => {
    const valid = makeRecord({ createdAt: Date.now() });
    const markdown = `<!-- magister-checkpoint:v1:dW50ZXJtaW5hdGVk -->\nbad\n\n${serializeCheckpoint(valid)}`;
    expect(parseCheckpointRecords(markdown)).toEqual([valid]);
  });

  it("keeps only the newest sequence per session inside the recent window", async () => {
    const nowMs = Date.UTC(2026, 6, 22, 12);
    const older = makeRecord({ checkpointId: "older", sequence: 1, createdAt: nowMs - 60_000 });
    const newer = makeRecord({ checkpointId: "newer", sequence: 2, createdAt: nowMs });
    const expired = makeRecord({
      checkpointId: "expired",
      sessionHash: "b".repeat(32),
      createdAt: nowMs - 40 * 24 * 60 * 60 * 1000,
    });
    await appendCheckpoint({ workspaceDir: dir, userTimezone: "UTC", record: older });
    await appendCheckpoint({ workspaceDir: dir, userTimezone: "UTC", record: newer });
    await appendCheckpoint({ workspaceDir: dir, userTimezone: "UTC", record: expired });

    expect(
      await listRecentCheckpoints({
        workspaceDir: dir,
        recentDays: 30,
        nowMs,
        userTimezone: "UTC",
      }),
    ).toEqual([newer]);
  });

  it("serializes concurrent appends through the shared workspace lock", async () => {
    const createdAt = Date.UTC(2026, 6, 22, 12);
    const records = [
      makeRecord({ checkpointId: "concurrent-one", sequence: 1, createdAt }),
      makeRecord({ checkpointId: "concurrent-two", sequence: 2, createdAt: createdAt + 1 }),
    ];
    await Promise.all(
      records.map((record) =>
        withContextLock(dir, () =>
          appendCheckpoint({ workspaceDir: dir, userTimezone: "UTC", record }),
        ),
      ),
    );
    const daily = await readFile(join(dir, "memory", "2026-07-22.md"), "utf8");
    expect(
      parseCheckpointRecords(daily)
        .map((record) => record.checkpointId)
        .toSorted(),
    ).toEqual(["concurrent-one", "concurrent-two"]);
  });
});

function makeRecord(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    version: 1,
    checkpointId: "checkpoint-123",
    sessionHash: "a".repeat(32),
    sequence: 1,
    startFingerprint: "1".repeat(64),
    endFingerprint: "2".repeat(64),
    createdAt: Date.UTC(2026, 6, 22),
    summary: "The user chose a concise reporting format.",
    topics: ["reporting"],
    ...overrides,
  };
}
