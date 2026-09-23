import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listTaskRecords,
  setTaskOutboxIntentById,
  setTaskOutboxIntentByRunId,
} from "../../tasks/task-registry.js";
import type { TaskOutboxEventType, TaskRuntime } from "../../tasks/task-registry.types.js";
import {
  DurableWebhookReplayConflictError,
  enqueueDurableWebhook,
} from "./durable-webhook-outbox.js";

function configuredUrl(cfg: OpenClawConfig, eventType: TaskOutboxEventType): string | undefined {
  const raw =
    eventType === "cron_completion"
      ? cfg.cron?.completionWebhook
      : eventType === "subagent_completion"
        ? cfg.subagent?.completionWebhook
        : cfg.slackCompletion?.completionWebhook;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function isTerminal(status: string): boolean {
  return ["succeeded", "failed", "timed_out", "cancelled", "lost"].includes(status);
}

export function persistCompletionOutboxIntent(params: {
  eventId: string;
  eventType: TaskOutboxEventType;
  payload: Record<string, unknown>;
  runId?: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  cronOccurrence?: { jobId: string; runAtMs: number };
}): number {
  if (params.runId?.trim()) {
    return setTaskOutboxIntentByRunId({
      runId: params.runId,
      runtime: params.runtime,
      sessionKey: params.sessionKey,
      eventId: params.eventId,
      eventType: params.eventType,
      payload: params.payload,
    }).length;
  }
  const cronOccurrence = params.cronOccurrence;
  if (!cronOccurrence) {
    return 0;
  }
  const match = listTaskRecords().find(
    (task) =>
      task.runtime === "cron" &&
      task.sourceId === cronOccurrence.jobId &&
      task.startedAt === cronOccurrence.runAtMs &&
      isTerminal(task.status),
  );
  if (!match) {
    return 0;
  }
  setTaskOutboxIntentById({
    taskId: match.taskId,
    eventId: params.eventId,
    eventType: params.eventType,
    payload: params.payload,
  });
  return 1;
}

export async function reconstructTaskCompletionOutbox(params: {
  cfg: OpenClawConfig;
  stateDir?: string;
}): Promise<{ reconstructed: number; unavailable: number; invalid: number }> {
  let reconstructed = 0;
  let unavailable = 0;
  let invalid = 0;
  for (const task of listTaskRecords()) {
    if (!task.outboxRequired || !isTerminal(task.status)) {
      continue;
    }
    if (!task.eventId || !task.outboxEventType || !task.terminalPayload) {
      invalid += 1;
      continue;
    }
    const url = configuredUrl(params.cfg, task.outboxEventType);
    if (!url) {
      unavailable += 1;
      continue;
    }
    try {
      await enqueueDurableWebhook({
        eventId: task.eventId,
        eventType: task.outboxEventType,
        url,
        payload: task.terminalPayload,
        stateDir: params.stateDir,
      });
      reconstructed += 1;
    } catch (error) {
      if (error instanceof DurableWebhookReplayConflictError) {
        invalid += 1;
        continue;
      }
      throw error;
    }
  }
  return { reconstructed, unavailable, invalid };
}
