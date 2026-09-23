import fs from "node:fs";
import path from "node:path";
import { IngestionError, MAX_EXTRACTED_BYTES } from "./corpus-contract.js";

const MIB = 1024 * 1024;

export type CorpusQuotaConfig = {
  sourceBytes: number;
  extractionBytes: number;
  cacheBytes: number;
  scratchBytes: number;
  logBytes: number;
  reservedHeadroomBytes: number;
};

function configuredBytes(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw || !/^\d+$/.test(raw)) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= MIB && parsed <= 10 * 1024 * MIB
    ? parsed
    : fallback;
}

export function corpusQuotaConfig(env: NodeJS.ProcessEnv = process.env): CorpusQuotaConfig {
  return {
    sourceBytes: configuredBytes(env, "MAGISTER_CORPUS_SOURCE_QUOTA_BYTES", 512 * MIB),
    extractionBytes: configuredBytes(env, "MAGISTER_CORPUS_EXTRACTION_QUOTA_BYTES", 256 * MIB),
    cacheBytes: configuredBytes(env, "MAGISTER_CORPUS_CACHE_QUOTA_BYTES", 128 * MIB),
    scratchBytes: configuredBytes(env, "MAGISTER_CORPUS_SCRATCH_QUOTA_BYTES", 128 * MIB),
    logBytes: configuredBytes(env, "MAGISTER_CORPUS_LOG_QUOTA_BYTES", 64 * MIB),
    reservedHeadroomBytes: configuredBytes(
      env,
      "MAGISTER_CORPUS_RESERVED_HEADROOM_BYTES",
      128 * MIB,
    ),
  };
}

export async function directoryBytes(root: string, maxEntries = 100_000): Promise<number> {
  const pending = [root];
  let bytes = 0;
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const child of children) {
      entries += 1;
      if (entries > maxEntries) {
        throw new IngestionError("corpus quota inventory exceeds its bounded entry limit", 507);
      }
      const candidate = path.join(current, child.name);
      if (child.isSymbolicLink()) {
        continue;
      }
      if (child.isDirectory()) {
        pending.push(candidate);
      } else if (child.isFile()) {
        bytes += (await fs.promises.stat(candidate)).size;
      }
    }
  }
  return bytes;
}

export async function assertCorpusPathQuotas(params: {
  workspace: string;
  destination: string;
  sourceBytes: number;
  sha256: string;
  extract: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const quota = corpusQuotaConfig(params.env);
  const magister = path.join(params.workspace, ".magister");
  const [sources, extraction, scratch, logs, filesystem, replaced] = await Promise.all([
    directoryBytes(path.join(params.workspace, "resources")),
    directoryBytes(path.join(magister, "extracted")),
    directoryBytes(path.join(magister, "tmp")),
    directoryBytes(path.join(magister, "logs")),
    fs.promises.statfs(params.workspace),
    fs.promises.stat(params.destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }),
  ]);
  if (sources - (replaced?.size ?? 0) + params.sourceBytes > quota.sourceBytes) {
    throw new IngestionError("project source-file quota would be exceeded", 507);
  }
  if (scratch > quota.scratchBytes) {
    throw new IngestionError("project scratch quota is exhausted", 507);
  }
  if (logs > quota.logBytes) {
    throw new IngestionError("project diagnostic-log quota is exhausted", 507);
  }
  const expectedExtraction = params.extract
    ? fs.existsSync(path.join(magister, "extracted", params.sha256, "content.md"))
      ? 0
      : Math.min(MAX_EXTRACTED_BYTES, Math.max(1024, params.sourceBytes))
    : 0;
  if (extraction + expectedExtraction > quota.extractionBytes) {
    throw new IngestionError("project extraction quota would be exceeded", 507);
  }
  const available = filesystem.bavail * filesystem.bsize;
  if (available - expectedExtraction < quota.reservedHeadroomBytes) {
    throw new IngestionError("reserved checkpoint and outbox disk headroom would be consumed", 507);
  }
}
