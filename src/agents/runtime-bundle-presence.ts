import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const RELEASE_RE = /^rb_[0-9a-f]{64}$/u;
const PRE_REQUEST_TIMEOUT_MS = 250;
const POST_REQUEST_TIMEOUT_MS = 500;

export type RuntimeBundlePresence = {
  releaseId: string;
  manifestSha256: string;
  templatesSha256: string;
  skillsSha256: string;
};

type RuntimeBundleProcessState = {
  active: {
    release_id: string;
    manifest_sha256: string;
    templates_sha256: string;
    skills_sha256: string;
  };
  boot_id: string;
  lease: string;
  machine_id: string;
  process_generation: string;
};

export type PendingPromptPresence = {
  pendingPath: string;
  sentPath: string;
  metricSentPath: string;
  payload: Record<string, unknown>;
  modelRequestPendingPath: string;
  modelRequestSentPath: string;
  modelRequestPayload: Record<string, unknown>;
  modelRequestSend?: Promise<void>;
  modelRequestStartedAtMs?: number;
  firstTokenLatencyMs?: number;
};

function readJsonSync(filePath: string): unknown {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return undefined;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function readValidatedState(workspaceDir: string): RuntimeBundleProcessState | undefined {
  const runtimeDir = path.join(workspaceDir, ".magister", "runtime");
  const state = readJsonSync(path.join(runtimeDir, "process-state.json")) as
    | Partial<RuntimeBundleProcessState>
    | undefined;
  const manifest = readJsonSync(path.join(runtimeDir, "applied-manifest.json")) as
    | { release_id?: unknown; manifest_sha256?: unknown }
    | undefined;
  const marker = readJsonSync(path.join(runtimeDir, "bundle-active")) as
    | { release_id?: unknown; state?: unknown }
    | undefined;
  const active = state?.active;
  if (
    !active ||
    !RELEASE_RE.test(active.release_id ?? "") ||
    !validHash(active.manifest_sha256) ||
    !validHash(active.templates_sha256) ||
    !validHash(active.skills_sha256) ||
    manifest?.release_id !== active.release_id ||
    manifest?.manifest_sha256 !== active.manifest_sha256 ||
    marker?.state !== "active" ||
    marker.release_id !== active.release_id ||
    typeof state.boot_id !== "string" ||
    typeof state.lease !== "string" ||
    typeof state.machine_id !== "string" ||
    typeof state.process_generation !== "string"
  ) {
    return undefined;
  }
  return state as RuntimeBundleProcessState;
}

export function readActiveRuntimeBundle(workspaceDir?: string): RuntimeBundlePresence | undefined {
  if (!workspaceDir) {
    return undefined;
  }
  const state = readValidatedState(workspaceDir);
  if (!state) {
    return undefined;
  }
  return {
    manifestSha256: state.active.manifest_sha256,
    releaseId: state.active.release_id,
    skillsSha256: state.active.skills_sha256,
    templatesSha256: state.active.templates_sha256,
  };
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function sendRuntimeEvidence(
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<boolean> {
  const token = process.env.GATEWAY_TOKEN ?? "";
  if (!token) {
    return false;
  }
  const baseUrl = process.env.GATEWAY_INTERNAL_URL ?? "http://magister-gateway.internal:8081";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/api/runtime-bundle/ack`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function markSent(params: {
  pendingPath: string;
  sentPath: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await atomicJson(params.sentPath, {
    acknowledged_at: Date.now(),
    release_id: params.payload.release_id,
    session_id: params.payload.session_id,
  });
  await unlink(params.pendingPath).catch(() => {});
  await fsyncDirectory(path.dirname(params.pendingPath));
}

export async function beginPromptPresence(params: {
  workspaceDir: string;
  sessionId: string;
}): Promise<PendingPromptPresence | undefined> {
  const state = readValidatedState(params.workspaceDir);
  if (!state || !(process.env.GATEWAY_TOKEN ?? "")) {
    return undefined;
  }
  const sessionId = params.sessionId.slice(0, 500);
  const identity = createHash("sha256")
    .update(
      [
        state.machine_id,
        state.boot_id,
        state.process_generation,
        state.active.release_id,
        sessionId,
      ].join("\0"),
    )
    .digest("hex");
  const directory = path.join(params.workspaceDir, ".magister", "runtime", "prompt-presence");
  const record: PendingPromptPresence = {
    pendingPath: path.join(directory, "pending", `${identity}.json`),
    sentPath: path.join(directory, "sent", `${identity}.json`),
    metricSentPath: path.join(directory, "first-token", `${identity}.json`),
    payload: {
      boot_id: state.boot_id,
      lease: state.lease,
      machine_id: state.machine_id,
      manifest_sha256: state.active.manifest_sha256,
      phase: "prompt_present",
      process_generation: state.process_generation,
      release_id: state.active.release_id,
      session_id: sessionId,
      skills_sha256: state.active.skills_sha256,
      templates_sha256: state.active.templates_sha256,
    },
    modelRequestPendingPath: path.join(directory, "model-request-pending", `${identity}.json`),
    modelRequestSentPath: path.join(directory, "model-request-sent", `${identity}.json`),
    modelRequestPayload: {
      boot_id: state.boot_id,
      lease: state.lease,
      machine_id: state.machine_id,
      manifest_sha256: state.active.manifest_sha256,
      phase: "model_request_started",
      process_generation: state.process_generation,
      release_id: state.active.release_id,
      session_id: sessionId,
      skills_sha256: state.active.skills_sha256,
      templates_sha256: state.active.templates_sha256,
    },
  };
  if (!fs.existsSync(record.sentPath)) {
    if (!fs.existsSync(record.pendingPath)) {
      await atomicJson(record.pendingPath, record.payload);
    } else {
      try {
        record.payload = JSON.parse(await readFile(record.pendingPath, "utf8"));
      } catch {
        await atomicJson(record.pendingPath, record.payload);
      }
    }
    if (await sendRuntimeEvidence(record.payload, PRE_REQUEST_TIMEOUT_MS)) {
      await markSent({
        pendingPath: record.pendingPath,
        sentPath: record.sentPath,
        payload: record.payload,
      });
    }
  }
  return record;
}

export async function markPromptRequestStarted(
  record: PendingPromptPresence | undefined,
): Promise<void> {
  if (!record) {
    return;
  }
  record.modelRequestStartedAtMs = Date.now();
  if (fs.existsSync(record.modelRequestSentPath)) {
    return;
  }
  try {
    if (!fs.existsSync(record.modelRequestPendingPath)) {
      await atomicJson(record.modelRequestPendingPath, record.modelRequestPayload);
    } else {
      try {
        record.modelRequestPayload = JSON.parse(
          await readFile(record.modelRequestPendingPath, "utf8"),
        );
      } catch {
        await atomicJson(record.modelRequestPendingPath, record.modelRequestPayload);
      }
    }
  } catch {
    return;
  }
  record.modelRequestSend = (async () => {
    if (await sendRuntimeEvidence(record.modelRequestPayload, PRE_REQUEST_TIMEOUT_MS)) {
      await markSent({
        pendingPath: record.modelRequestPendingPath,
        sentPath: record.modelRequestSentPath,
        payload: record.modelRequestPayload,
      });
    }
  })().catch(() => {});
}

export function recordPromptFirstToken(record: PendingPromptPresence | undefined): void {
  if (
    !record ||
    record.firstTokenLatencyMs !== undefined ||
    record.modelRequestStartedAtMs === undefined
  ) {
    return;
  }
  record.firstTokenLatencyMs = Math.max(0, Date.now() - record.modelRequestStartedAtMs);
}

export async function retryPromptPresence(
  record: PendingPromptPresence | undefined,
): Promise<void> {
  if (!record) {
    return;
  }
  await record.modelRequestSend;
  const promptPending = fs.existsSync(record.pendingPath);
  const modelRequestPending = fs.existsSync(record.modelRequestPendingPath);
  const metricPending =
    record.firstTokenLatencyMs !== undefined && !fs.existsSync(record.metricSentPath);
  if (!promptPending && !modelRequestPending && !metricPending) {
    return;
  }
  const payload =
    record.firstTokenLatencyMs === undefined
      ? record.payload
      : { ...record.payload, first_token_latency_ms: record.firstTokenLatencyMs };
  if (
    (promptPending || metricPending) &&
    (await sendRuntimeEvidence(payload, POST_REQUEST_TIMEOUT_MS))
  ) {
    if (promptPending) {
      await markSent({
        pendingPath: record.pendingPath,
        sentPath: record.sentPath,
        payload: record.payload,
      });
    }
    if (metricPending) {
      await atomicJson(record.metricSentPath, {
        acknowledged_at: Date.now(),
        first_token_latency_ms: record.firstTokenLatencyMs,
        release_id: record.payload.release_id,
        session_id: record.payload.session_id,
      });
    }
  }
  if (
    modelRequestPending &&
    (await sendRuntimeEvidence(record.modelRequestPayload, POST_REQUEST_TIMEOUT_MS))
  ) {
    await markSent({
      pendingPath: record.modelRequestPendingPath,
      sentPath: record.modelRequestSentPath,
      payload: record.modelRequestPayload,
    });
  }
}
