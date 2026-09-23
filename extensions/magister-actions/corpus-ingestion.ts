import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type IngestionResult,
  IngestionError,
  MAX_SOURCE_BYTES,
  fsyncDir,
  fsyncPath,
  stateRoot,
} from "./corpus-contract.js";
import { extractSource } from "./corpus-extraction.js";
import { corpusDiskState, corpusPreprocessingAllowed } from "./corpus-index.js";
import { assertMimeAgreement, detectMime } from "./corpus-mime.js";
import { assertCorpusPathQuotas } from "./corpus-quota.js";
import { CorpusStore, type CorpusSource } from "./corpus-store.js";
import { LocalMutationObservation, type LocalMutationContext } from "./mutation-observer.js";
import { mirrorReadBits } from "./tool-readable.js";

export function normalizeDestination(workspace: string, requested: string): string {
  if (!requested.trim()) {
    throw new IngestionError("destination_path is required");
  }
  const absolute = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(workspace, requested);
  const resources = path.join(workspace, "resources");
  if (absolute !== resources && !absolute.startsWith(`${resources}${path.sep}`)) {
    throw new IngestionError("destination must stay under workspace/resources");
  }
  const relative = path.relative(resources, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new IngestionError("destination must name a file under workspace/resources");
  }
  return absolute;
}

export function defaultDestination(workspace: string, filename: string): string {
  const base = path.basename(filename.trim());
  if (!base || base === "." || base === "..") {
    throw new IngestionError("filename is invalid");
  }
  return normalizeDestination(workspace, path.join("resources", base));
}

async function rejectSymlinkComponents(workspace: string, destination: string): Promise<void> {
  const parent = path.dirname(destination);
  const relative = path.relative(workspace, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new IngestionError("destination escapes the workspace");
  }
  let current = workspace;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new IngestionError("symlinked upload directories are forbidden");
      }
      if (!stat.isDirectory()) {
        throw new IngestionError("upload parent is not a directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await fs.promises.mkdir(current, { mode: 0o700 });
    }
    // Every directory on the way to an upload, not only one created here: a
    // file the tools may read is still unreachable inside a 0700 directory.
    await mirrorReadBits(current);
  }
  try {
    const target = await fs.promises.lstat(destination);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new IngestionError("upload destination must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function writeBase64ToStaging(data: string, stagingPath: string): Promise<void> {
  if (data.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 + 8) {
    throw new IngestionError("file exceeds the 50 MB upload limit", 413);
  }
  const handle = await fs.promises.open(
    stagingPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  );
  let bytes = 0;
  try {
    const stride = 4 * 256 * 1024;
    for (let offset = 0; offset < data.length; offset += stride) {
      let end = Math.min(data.length, offset + stride);
      if (end < data.length) {
        end -= (end - offset) % 4;
      }
      const encoded = data.slice(offset, end);
      const isLast = end === data.length;
      if (
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
        (!isLast && encoded.includes("="))
      ) {
        throw new IngestionError("file data is not valid base64");
      }
      const chunk = Buffer.from(encoded, "base64");
      bytes += chunk.byteLength;
      if (bytes > MAX_SOURCE_BYTES) {
        throw new IngestionError("file exceeds the 50 MB upload limit", 413);
      }
      await handle.write(chunk);
      offset = end - stride;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function allowedSignedUploadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IngestionError("download_url is invalid");
  }
  const allowedHosts = new Set(
    (process.env.MAGISTER_UPLOAD_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const providerHost = url.hostname.toLowerCase().endsWith(".supabase.co");
  if (
    url.protocol !== "https:" ||
    (!providerHost && !allowedHosts.has(url.hostname.toLowerCase()))
  ) {
    throw new IngestionError("download_url host is not an approved upload provider");
  }
  if (url.username || url.password) {
    throw new IngestionError("download_url userinfo is forbidden");
  }
  return url;
}

export async function downloadToStaging(rawUrl: string, stagingPath: string): Promise<void> {
  const url = allowedSignedUploadUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok || !response.body) {
    throw new IngestionError(`upload provider returned HTTP ${response.status}`, 502);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
    throw new IngestionError("file exceeds the 50 MB upload limit", 413);
  }
  const handle = await fs.promises.open(
    stagingPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  );
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new IngestionError("file exceeds the 50 MB upload limit", 413);
      }
      await handle.write(value);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashFile(
  filePath: string,
): Promise<{ sha256: string; byteSize: number; head: Buffer }> {
  const digest = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  const headParts: Buffer[] = [];
  let headBytes = 0;
  let byteSize = 0;
  for await (const value of stream) {
    const chunk = Buffer.from(value);
    byteSize += chunk.byteLength;
    digest.update(chunk);
    if (headBytes < 8_192) {
      const part = chunk.subarray(0, 8_192 - headBytes);
      headParts.push(part);
      headBytes += part.byteLength;
    }
  }
  return { sha256: digest.digest("hex"), byteSize, head: Buffer.concat(headParts) };
}

export async function ingestOne(params: {
  workspace: string;
  destination: string;
  filename: string;
  declaredMime?: string;
  provenance: string;
  extract: boolean;
  writeStaging: (stagingPath: string) => Promise<void>;
  mutationContext?: LocalMutationContext;
}): Promise<IngestionResult> {
  await rejectSymlinkComponents(params.workspace, params.destination);
  const initialDestination = await fs.promises.lstat(params.destination).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  const disk = await corpusDiskState(params.workspace);
  if (disk.usedPercent >= 75) {
    console.warn(
      `[magister-corpus] disk watermark=${disk.usedPercent.toFixed(1)}% cache_evicted=${disk.cacheEvicted}`,
    );
  }
  if (params.extract && !disk.extractionAllowed) {
    throw new IngestionError("disk usage is above the 85% extraction watermark", 507);
  }
  if (params.extract && !(await corpusPreprocessingAllowed())) {
    throw new IngestionError("extraction is paused by machine memory admission", 503);
  }
  const stagingDir = path.join(stateRoot(params.workspace), "tmp", "ingest");
  await fs.promises.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const stagingPath = path.join(stagingDir, `${randomUUID()}.part`);
  const backupPath = path.join(stagingDir, `${randomUUID()}.backup`);
  let backupCreated = false;
  let promoted = false;
  let observation: LocalMutationObservation | undefined;
  let observedHash: string | undefined;
  let observedSize: number | undefined;
  let observedMime: string | undefined;
  let commitAttested = false;
  try {
    await params.writeStaging(stagingPath);
    const { sha256, byteSize, head } = await hashFile(stagingPath);
    observedHash = sha256;
    observedSize = byteSize;
    if (byteSize > MAX_SOURCE_BYTES) {
      throw new IngestionError("file exceeds the 50 MB upload limit", 413);
    }
    const mime = detectMime(head, params.filename);
    observedMime = mime;
    assertMimeAgreement(params.filename, mime, params.declaredMime);
    await assertCorpusPathQuotas({
      workspace: params.workspace,
      destination: params.destination,
      sourceBytes: byteSize,
      sha256,
      extract: params.extract,
    });
    if (params.mutationContext) {
      const resource = path.relative(params.workspace, params.destination);
      const suffix = createHash("sha256").update(resource).digest("hex").slice(0, 16);
      observation = new LocalMutationObservation(
        params.workspace,
        params.mutationContext,
        resource,
        sha256,
        `${params.mutationContext.operation_id}:${suffix}`.slice(0, 240),
      );
    }
    const extraction = await extractSource({
      workspace: params.workspace,
      stagingPath,
      sha256,
      filename: params.filename,
      mime,
      head,
      enabled: params.extract,
    });
    const currentDestination = await fs.promises.lstat(params.destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (
      Boolean(initialDestination) !== Boolean(currentDestination) ||
      (initialDestination &&
        currentDestination &&
        (initialDestination.ino !== currentDestination.ino ||
          initialDestination.size !== currentDestination.size ||
          initialDestination.mtimeMs !== currentDestination.mtimeMs))
    ) {
      throw new IngestionError("upload destination changed during ingestion", 409);
    }
    await observation?.attestCommit();
    commitAttested = observation !== undefined && params.mutationContext?.mode === "enforce";
    observation?.lockPromotion();
    observation?.assertCommitCurrent();
    if (currentDestination) {
      await fs.promises.rename(params.destination, backupPath);
      backupCreated = true;
    }
    await fs.promises.rename(stagingPath, params.destination);
    promoted = true;
    // Owner-only until it is in place, then readable by the agent's tools. Left
    // at 0600 the upload could be read by the host `read` tool but not by
    // `exec`, so a spreadsheet or archive could never be parsed: every binary
    // upload cost ~30 tool calls and ended with the agent working blind.
    await fs.promises.chmod(params.destination, 0o600);
    await mirrorReadBits(params.destination);
    await fsyncPath(params.destination);
    await fsyncDir(path.dirname(params.destination));
    const store = new CorpusStore(params.workspace);
    let source: CorpusSource;
    try {
      source = store.record({
        relativePath: path.relative(params.workspace, params.destination),
        sha256,
        mime,
        byteSize,
        provenance: params.provenance,
        extraction,
      });
    } finally {
      store.close();
    }
    if (commitAttested) {
      await observation?.completeCommit();
      commitAttested = false;
    }
    observation?.finish("promoted");
    if (backupCreated) {
      await fs.promises.rm(backupPath, { force: true });
      backupCreated = false;
      await fsyncDir(path.dirname(params.destination));
    }
    return {
      path: params.destination,
      sha256,
      detected_mime: mime,
      byte_size: byteSize,
      duplicate: source.duplicate,
      extraction_status: extraction.status,
      extracted_artifact: extraction.artifactPath,
      source_revision: source.sourceRevision,
    };
  } catch (error) {
    if (promoted) {
      await fs.promises.rm(params.destination, { force: true });
      promoted = false;
    }
    if (backupCreated) {
      await fs.promises.rename(backupPath, params.destination);
      backupCreated = false;
      await fsyncDir(path.dirname(params.destination));
    }
    if (observedHash) {
      try {
        const store = new CorpusStore(params.workspace);
        try {
          store.recordRejection({
            relativePath: path.relative(params.workspace, params.destination),
            sha256: observedHash,
            mime: observedMime,
            byteSize: observedSize,
            provenance: params.provenance,
            failureCode: error instanceof Error ? error.message : "ingestion_failed",
          });
        } finally {
          store.close();
        }
      } catch {
        // Preserve the original rejection; readiness surfaces a corpus DB failure separately.
      }
    }
    if (commitAttested) {
      await observation?.completeCommit().catch(() => {});
      commitAttested = false;
    }
    observation?.finish("failed", error instanceof Error ? error.name : "unknown");
    throw error;
  } finally {
    if (!promoted) {
      await fs.promises.rm(stagingPath, { force: true });
    }
    if (backupCreated) {
      await fs.promises.rm(backupPath, { force: true });
    }
  }
}
