import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { reportCleanupFailure, reportHostRouteFailure } from "./host-route-telemetry.js";
import { hostedLibraryRuntime } from "./library-integration.js";
import { LocalMutationObservation, parseLocalMutationContext } from "./mutation-observer.js";
import { mirrorReadBits } from "./tool-readable.js";

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const ATTEMPT_RE = /^[A-Za-z0-9._-]{1,120}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROTECTED_TOP_LEVEL = new Set([".magister", ".openclaw", "hooks", "skills"]);
const PROTECTED_FILES = new Set([
  "AGENTS.md",
  "HEARTBEAT.md",
  "INTEGRATIONS.md",
  "MEMORY.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
  "WORKFLOWS.md",
]);

type PromotionRequest = {
  attempt_id: string;
  staged_path: string;
  destination_path: string;
  sha256: string;
  replace_sha256?: string;
  mutation_context?: unknown;
};

export class ArtifactPromotionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

function normalizedRelative(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) {
    throw new ArtifactPromotionError(`${label} is invalid`);
  }
  if (path.isAbsolute(value)) {
    throw new ArtifactPromotionError(`${label} must be relative`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ArtifactPromotionError(`${label} contains an unsafe path segment`);
  }
  return segments.join(path.sep);
}

function destinationRelative(value: unknown): string {
  const relative = normalizedRelative(value, "destination_path");
  const segments = relative.split(path.sep);
  if (
    PROTECTED_TOP_LEVEL.has(segments[0] ?? "") ||
    segments.some((segment) => segment.startsWith(".")) ||
    (segments.length === 1 && PROTECTED_FILES.has(segments[0] ?? ""))
  ) {
    throw new ArtifactPromotionError("destination_path is platform-managed", 403);
  }
  return relative;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new ArtifactPromotionError("promotion request is too large", 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ArtifactPromotionError("promotion request must be valid JSON");
  }
}

function parseRequest(value: unknown): PromotionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactPromotionError("promotion request must be an object");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    "attempt_id",
    "staged_path",
    "destination_path",
    "sha256",
    "replace_sha256",
    "mutation_context",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new ArtifactPromotionError("promotion request has unknown fields");
  }
  if (typeof row.attempt_id !== "string" || !ATTEMPT_RE.test(row.attempt_id)) {
    throw new ArtifactPromotionError("attempt_id is invalid");
  }
  if (typeof row.sha256 !== "string" || !SHA256_RE.test(row.sha256)) {
    throw new ArtifactPromotionError("sha256 is invalid");
  }
  if (
    row.replace_sha256 !== undefined &&
    (typeof row.replace_sha256 !== "string" || !SHA256_RE.test(row.replace_sha256))
  ) {
    throw new ArtifactPromotionError("replace_sha256 is invalid");
  }
  const stagedPath = normalizedRelative(row.staged_path, "staged_path");
  if (stagedPath !== "promote" && !stagedPath.startsWith(`promote${path.sep}`)) {
    throw new ArtifactPromotionError("staged_path must be under the promotion staging directory");
  }
  return {
    attempt_id: row.attempt_id,
    staged_path: stagedPath,
    destination_path: destinationRelative(row.destination_path),
    sha256: row.sha256,
    ...(typeof row.replace_sha256 === "string" ? { replace_sha256: row.replace_sha256 } : {}),
    ...(row.mutation_context !== undefined ? { mutation_context: row.mutation_context } : {}),
  };
}

async function removePromotedStaging(staged: string, attemptRoot: string): Promise<void> {
  await fs.promises.rm(staged, { force: true });
  let current = path.dirname(staged);
  while (current !== attemptRoot && current.startsWith(`${attemptRoot}${path.sep}`)) {
    try {
      await fs.promises.rmdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        break;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    current = path.dirname(current);
  }
  try {
    await fs.promises.rmdir(attemptRoot);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

/** Staging cleanup after the promotion is committed, and only then.
 *
 *  It cannot change the outcome: the destination is written and the mutation
 *  ledger already says `promoted`. It can fail, though — the sandbox creates
 *  `promote/<sub>/` as agent-tool under umask 0027, so the host may read the
 *  staged file but not unlink it — and letting that throw answered 500 for a
 *  delivered artifact. Whatever stays behind is reclaimed by the supervisor's
 *  scratch reaper, which runs as root. */
async function cleanUpPromotedStaging(staged: string, attemptRoot: string): Promise<void> {
  try {
    await removePromotedStaging(staged, attemptRoot);
  } catch (error) {
    reportCleanupFailure("magister_artifact_promotion", error);
  }
}

async function assertComponents(
  root: string,
  relative: string,
  options: { createParents: boolean },
): Promise<string> {
  let current = root;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const final = index === segments.length - 1;
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new ArtifactPromotionError("artifact path contains a symlink", 409);
      }
      if (!final && !stat.isDirectory()) {
        throw new ArtifactPromotionError("artifact parent is not a directory", 409);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (!final && options.createParents) {
        await fs.promises.mkdir(current, { mode: 0o700 });
      } else if (!final) {
        throw new ArtifactPromotionError("staged artifact parent is missing", 404);
      }
    }
    // Destination parents only (`createParents`): the staging tree under
    // `.magister/tmp` takes the other branch and stays owner-only. Existing
    // directories too, since a readable artifact inside a 0700 directory is
    // still unreachable by the agent's tools.
    if (!final && options.createParents) {
      await mirrorReadBits(current);
    }
  }
  return current;
}

type StagedArtifact = { attemptRoot: string; staged: string; stat: fs.Stats };

const STAGED_ARTIFACT_MISSING =
  "staged artifact is missing: attempt_id is this command's MAGISTER_ATTEMPT_ID (the name of the " +
  "directory holding MAGISTER_PROMOTION_DIR), not the exec session name, and a command that exits " +
  "non-zero discards its staging, so stage again and print that id from the same command";

/** The file at `staged_path` under one attempt, or null when it is not there. */
async function stagedFileIn(
  attemptRoot: string,
  stagedPath: string,
): Promise<StagedArtifact | null> {
  try {
    const staged = await assertComponents(attemptRoot, stagedPath, { createParents: false });
    return { attemptRoot, staged, stat: await fs.promises.lstat(staged) };
  } catch (error) {
    const missing =
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof ArtifactPromotionError && error.statusCode === 404);
    if (missing) {
      return null;
    }
    throw error;
  }
}

/** The staged file a request means, even when its `attempt_id` is wrong.
 *
 *  The model is never handed the attempt id; it has to read it from the
 *  sandbox's environment, and sometimes takes the exec session's name instead
 *  (`print('attempt_id=quiet-kelp')`). The file was staged correctly, so the
 *  promotion failed for nothing and the deliverable lost its verified write.
 *  `sha256` is what actually binds the request to its bytes: any retained
 *  attempt holding an owned regular file with exactly that hash at that path
 *  is the file the caller staged. Attempts are this one tenant's own, expire
 *  in an hour, and are bounded by the scratch quota, so the walk is short. */
async function locateStagedArtifact(
  workspace: string,
  request: PromotionRequest,
  expectedUid: number,
): Promise<StagedArtifact> {
  const attemptsRelative = path.join(".magister", "tmp", "attempts");
  const named = await assertComponents(workspace, path.join(attemptsRelative, request.attempt_id), {
    createParents: false,
  });
  const direct = await stagedFileIn(named, request.staged_path);
  if (direct) {
    return direct;
  }
  const attemptsRoot = path.join(workspace, attemptsRelative);
  const entries = await fs.promises
    .readdir(attemptsRoot, { withFileTypes: true })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === request.attempt_id) {
      continue;
    }
    const candidate = await stagedFileIn(path.join(attemptsRoot, entry.name), request.staged_path);
    if (
      candidate &&
      candidate.stat.isFile() &&
      candidate.stat.nlink === 1 &&
      candidate.stat.uid === expectedUid &&
      candidate.stat.size <= MAX_ARTIFACT_BYTES &&
      (await hashFile(candidate.staged)) === request.sha256
    ) {
      return candidate;
    }
  }
  throw new ArtifactPromotionError(STAGED_ARTIFACT_MISSING, 404);
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function destinationState(
  destination: string,
  requestedHash: string,
  replaceHash: string | undefined,
): Promise<"missing" | "current" | "replace"> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new ArtifactPromotionError("destination is not a safe regular file", 409);
  }
  const currentHash = await hashFile(destination);
  if (currentHash === requestedHash) {
    return "current";
  }
  if (!replaceHash || currentHash !== replaceHash) {
    throw new ArtifactPromotionError("destination changed or replacement was not authorized", 409);
  }
  return "replace";
}

export async function promoteArtifact(
  rawRequest: unknown,
  options: { workspace?: string; agentToolUid?: number } = {},
): Promise<Record<string, unknown>> {
  const request = parseRequest(rawRequest);
  const workspace = path.resolve(
    options.workspace ?? process.env.OPENCLAW_WORKSPACE_DIR ?? "/data/.openclaw/workspace",
  );
  const expectedUid =
    options.agentToolUid ?? Number.parseInt(process.env.MAGISTER_AGENT_TOOL_UID ?? "", 10);
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 1) {
    throw new ArtifactPromotionError("agent-tool identity is unavailable", 503);
  }
  const context = parseLocalMutationContext(request.mutation_context);
  if (request.mutation_context !== undefined && !context) {
    throw new ArtifactPromotionError("promotion mutation context is invalid", 409);
  }
  if (process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT === "1" && context?.mode !== "enforce") {
    throw new ArtifactPromotionError("promotion requires a current enforced mutation fence", 409);
  }

  const library = hostedLibraryRuntime(workspace);
  const replay = await library?.replayPromotion(request);
  if (replay) {
    return {
      ...replay,
      destination_path: request.destination_path,
      sha256: request.sha256,
      byte_size: replay.files.find((file) => file.path === request.destination_path)?.size,
    };
  }

  const {
    attemptRoot,
    staged,
    stat: stagedStat,
  } = await locateStagedArtifact(workspace, request, expectedUid);
  if (
    stagedStat.isSymbolicLink() ||
    !stagedStat.isFile() ||
    stagedStat.nlink !== 1 ||
    stagedStat.uid !== expectedUid
  ) {
    throw new ArtifactPromotionError("staged artifact is not an owned regular file", 409);
  }
  if (stagedStat.size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactPromotionError("staged artifact exceeds the 50 MB quota", 413);
  }
  if ((await hashFile(staged)) !== request.sha256) {
    throw new ArtifactPromotionError("staged artifact hash mismatch", 409);
  }

  // The staged file is untrusted until ownership/size/hash validation above.
  // Active Library commits bytes first; local installation is its projection.
  if (library) {
    const receipt = await library.promote(request, await fs.promises.readFile(staged));
    if (receipt) {
      if (receipt.status === "committed") await cleanUpPromotedStaging(staged, attemptRoot);
      return {
        ...receipt,
        destination_path: request.destination_path,
        sha256: request.sha256,
        byte_size: stagedStat.size,
      };
    }
  }

  const completeLegacy = await library?.beginLegacyWrite(
    "sandbox.promotion",
    // Bounded (the id is at most 240 chars); the runtime adds a per-attempt suffix.
    `promotion:${createHash("sha256").update(`${request.attempt_id}\0${request.destination_path}`).digest("hex")}`,
  );
  // The destination is only replaced by the rename below; any failure before
  // it changed no bytes, so the lease settles as no_effect, never stays open.
  let renamed = false;
  const destination = await assertComponents(workspace, request.destination_path, {
    createParents: true,
  }).catch(async (error: unknown) => {
    await completeLegacy?.("no_effect");
    throw error;
  });
  const observation = context
    ? new LocalMutationObservation(workspace, context, request.destination_path, request.sha256)
    : undefined;
  let temporary: string | undefined;
  let commitAttested = false;
  try {
    const initialState = await destinationState(
      destination,
      request.sha256,
      request.replace_sha256,
    );
    if (initialState === "current") {
      await mirrorReadBits(destination);
      observation?.finish("promoted");
      await cleanUpPromotedStaging(staged, attemptRoot);
      await completeLegacy?.();
      return {
        status: "already_current",
        destination_path: request.destination_path,
        sha256: request.sha256,
        byte_size: stagedStat.size,
        project_fence: context?.project_fence,
      };
    }

    const parent = path.dirname(destination);
    temporary = path.join(parent, `.magister-promote-${randomUUID()}.tmp`);
    await fs.promises.copyFile(staged, temporary, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(temporary, 0o600);
    const copiedStat = await fs.promises.lstat(temporary);
    if (
      !copiedStat.isFile() ||
      copiedStat.nlink !== 1 ||
      copiedStat.size !== stagedStat.size ||
      (await hashFile(temporary)) !== request.sha256
    ) {
      throw new ArtifactPromotionError("staged artifact changed during promotion", 409);
    }
    const handle = await fs.promises.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const finalState = await destinationState(destination, request.sha256, request.replace_sha256);
    if (finalState === "current") {
      await fs.promises.rm(temporary, { force: true });
      temporary = undefined;
    } else {
      await observation?.attestCommit();
      commitAttested = observation !== undefined && context?.mode === "enforce";
      observation?.lockPromotion();
      // Re-read after the live gateway attestation and local transaction lock;
      // this is the last check before the atomic rename.
      const attestedState = await destinationState(
        destination,
        request.sha256,
        request.replace_sha256,
      );
      if (attestedState === "current") {
        await fs.promises.rm(temporary, { force: true });
        temporary = undefined;
      } else {
        observation?.assertCommitCurrent();
        await fs.promises.rename(temporary, destination);
        renamed = true;
        temporary = undefined;
        await fsyncDirectory(parent);
      }
    }
    // The copy is owner-only while it is verified; once it is the destination
    // the agent's tools must be able to read it. Also heals an artifact an
    // earlier promotion left at 0600 (the `current` branches above).
    await mirrorReadBits(destination);
    if (commitAttested) {
      await observation?.completeCommit();
      commitAttested = false;
    }
    observation?.finish("promoted");
    await cleanUpPromotedStaging(staged, attemptRoot);
    await completeLegacy?.();
    return {
      status: "promoted",
      destination_path: request.destination_path,
      sha256: request.sha256,
      byte_size: stagedStat.size,
      project_fence: context?.project_fence,
    };
  } catch (error) {
    if (commitAttested) {
      await observation?.completeCommit().catch(() => {});
      commitAttested = false;
    }
    observation?.finish("failed", error instanceof Error ? error.name : "unknown");
    // After the rename the outcome is unknown: that lease stays open.
    await completeLegacy?.(renamed ? "unknown" : "no_effect");
    throw error;
  } finally {
    if (temporary) {
      await fs.promises.rm(temporary, { force: true });
    }
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

export async function handleArtifactPromotion(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    sendJson(res, 200, await promoteArtifact(await readJsonBody(req)));
  } catch (error) {
    if (!(error instanceof ArtifactPromotionError)) {
      reportHostRouteFailure("magister_artifact_promotion", error);
    }
    const status = error instanceof ArtifactPromotionError ? error.statusCode : 500;
    const message = error instanceof ArtifactPromotionError ? error.message : "promotion failed";
    sendJson(res, status, { error: "promotion_rejected", message });
  }
  return true;
}
