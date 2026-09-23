import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PARSER_VERSION } from "./corpus-contract.js";
import { corpusQuotaConfig } from "./corpus-quota.js";
import { openCorpusDatabase } from "./corpus-schema.js";

export const CORPUS_PARSER_VERSION = PARSER_VERSION;
const MAX_CACHE_VALUE_BYTES = 256 * 1024;
const MAX_SEARCH_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_CHUNK_CHARS = 2_000;

export type CorpusSearchResult = {
  source_id: string;
  path: string;
  provenance: string;
  source_revision: number;
  fetched_at: number | null;
  trusted_as_project_source: boolean;
  excerpt: string;
  score: number;
};

export type ReadCacheContract = {
  projectScope: string;
  accountScope?: string;
  inputHash: string;
  sourceRevision: number;
  fetchedAt: number;
  freshnessTtlSeconds: number;
  parserVersion?: string;
};

function open(workspace: string): DatabaseSync {
  return openCorpusDatabase(workspace);
}

export function canonicalCorpusJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCorpusJson).join(",")}]`;
  }
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalCorpusJson(row[key])}`)
    .join(",")}}`;
}

export function readCacheKey(contract: ReadCacheContract): string {
  return createHash("sha256")
    .update(
      canonicalCorpusJson({
        project_scope: contract.projectScope,
        account_scope: contract.accountScope ?? null,
        input_hash: contract.inputHash,
        source_revision: contract.sourceRevision,
        fetched_at: contract.fetchedAt,
        freshness_ttl_seconds: contract.freshnessTtlSeconds,
        parser_version: contract.parserVersion ?? CORPUS_PARSER_VERSION,
      }),
    )
    .digest("hex");
}

export function putCorpusReadCache(
  workspace: string,
  contract: ReadCacheContract,
  value: unknown,
): string {
  const valueJson = canonicalCorpusJson(value);
  if (Buffer.byteLength(valueJson) > MAX_CACHE_VALUE_BYTES) {
    throw new Error("corpus read-cache value exceeds 256 KiB");
  }
  if (contract.freshnessTtlSeconds <= 0 || contract.sourceRevision <= 0) {
    throw new Error("corpus read-cache freshness contract is invalid");
  }
  const cacheKey = readCacheKey(contract);
  const db = open(workspace);
  try {
    const quota = corpusQuotaConfig().cacheBytes;
    const incomingBytes = Buffer.byteLength(valueJson);
    if (incomingBytes > quota) {
      throw new Error("corpus read-cache value exceeds the configured cache quota");
    }
    db.prepare("DELETE FROM read_cache WHERE cache_key = ?").run(cacheKey);
    let used = (
      db.prepare("SELECT COALESCE(SUM(LENGTH(value_json)), 0) AS bytes FROM read_cache").get() as {
        bytes: number;
      }
    ).bytes;
    for (const row of db
      .prepare("SELECT cache_key, LENGTH(value_json) AS bytes FROM read_cache ORDER BY created_at")
      .all() as Array<{ cache_key: string; bytes: number }>) {
      if (used + incomingBytes <= quota) {
        break;
      }
      db.prepare("DELETE FROM read_cache WHERE cache_key = ?").run(row.cache_key);
      used -= row.bytes;
    }
    db.prepare(`
      INSERT INTO read_cache (
        cache_key, project_scope, account_scope, input_hash, source_revision,
        fetched_at, freshness_ttl_seconds, parser_version, value_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json,
        created_at = excluded.created_at
    `).run(
      cacheKey,
      contract.projectScope,
      contract.accountScope ?? null,
      contract.inputHash,
      contract.sourceRevision,
      contract.fetchedAt,
      contract.freshnessTtlSeconds,
      contract.parserVersion ?? CORPUS_PARSER_VERSION,
      valueJson,
      Date.now(),
    );
  } finally {
    db.close();
  }
  return cacheKey;
}

export function getCorpusReadCache(
  workspace: string,
  contract: ReadCacheContract,
  now = Date.now(),
): unknown {
  const cacheKey = readCacheKey(contract);
  const db = open(workspace);
  try {
    const row = db
      .prepare(`
        SELECT value_json, fetched_at, freshness_ttl_seconds, source_revision, parser_version
        FROM read_cache WHERE cache_key = ?
      `)
      .get(cacheKey) as
      | {
          value_json: string;
          fetched_at: number;
          freshness_ttl_seconds: number;
          source_revision: number;
          parser_version: string;
        }
      | undefined;
    const freshUntil = row ? row.fetched_at + row.freshness_ttl_seconds * 1000 : 0;
    if (
      !row ||
      row.source_revision !== contract.sourceRevision ||
      row.parser_version !== (contract.parserVersion ?? CORPUS_PARSER_VERSION) ||
      now > freshUntil
    ) {
      db.prepare("DELETE FROM read_cache WHERE cache_key = ?").run(cacheKey);
      return null;
    }
    return JSON.parse(row.value_json) as unknown;
  } finally {
    db.close();
  }
}

export function recordFetchedCorpusSource(params: {
  workspace: string;
  projectScope: string;
  accountScope?: string;
  url: string;
  contentHash: string;
  provenance: "research" | "web_context" | "seo" | "analytics" | "integration_discovery";
  fetchedAt: number;
  freshnessTtlSeconds: number;
}): { sourceId: string; sourceRevision: number } {
  const virtualPath = `external/${params.projectScope}/${params.accountScope ?? "project"}/${createHash("sha256").update(params.url).digest("hex")}`;
  const db = open(params.workspace);
  try {
    const existing = db
      .prepare("SELECT source_id, sha256, source_revision FROM sources WHERE path = ?")
      .get(virtualPath) as
      | { source_id: string; sha256: string; source_revision: number }
      | undefined;
    const sourceId = existing?.source_id ?? randomUUID();
    const sourceRevision = existing
      ? existing.sha256 === params.contentHash
        ? existing.source_revision
        : existing.source_revision + 1
      : 1;
    db.prepare(`
      INSERT INTO sources (
        source_id, path, sha256, detected_mime, byte_size, provenance, uploaded_at,
        parser_version, extraction_status, extracted_artifact,
        trusted_as_project_source, source_revision, fetched_at, freshness_ttl_seconds,
        source_url, project_scope, account_scope, source_kind
      ) VALUES (?, ?, ?, 'application/json', 0, ?, ?, ?, 'external', NULL, 0, ?, ?, ?, ?, ?, ?, 'fetched')
      ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256,
        provenance = excluded.provenance, parser_version = excluded.parser_version,
        source_revision = excluded.source_revision, fetched_at = excluded.fetched_at,
        freshness_ttl_seconds = excluded.freshness_ttl_seconds,
        source_url = excluded.source_url, project_scope = excluded.project_scope,
        account_scope = excluded.account_scope, source_kind = excluded.source_kind
    `).run(
      sourceId,
      virtualPath,
      params.contentHash,
      params.provenance,
      params.fetchedAt,
      CORPUS_PARSER_VERSION,
      sourceRevision,
      params.fetchedAt,
      params.freshnessTtlSeconds,
      params.url,
      params.projectScope,
      params.accountScope ?? null,
    );
    return { sourceId, sourceRevision };
  } finally {
    db.close();
  }
}

export function getLatestFetchedCorpusSource(params: {
  workspace: string;
  projectScope: string;
  accountScope?: string;
  url: string;
}):
  | {
      sourceId: string;
      sourceRevision: number;
      fetchedAt: number;
      freshnessTtlSeconds: number;
    }
  | undefined {
  const virtualPath = `external/${params.projectScope}/${params.accountScope ?? "project"}/${createHash("sha256").update(params.url).digest("hex")}`;
  const db = open(params.workspace);
  try {
    const row = db
      .prepare(
        `SELECT source_id, source_revision, fetched_at, freshness_ttl_seconds
         FROM sources WHERE path = ? AND source_kind = 'fetched'`,
      )
      .get(virtualPath) as
      | {
          source_id: string;
          source_revision: number;
          fetched_at: number;
          freshness_ttl_seconds: number;
        }
      | undefined;
    return row
      ? {
          sourceId: row.source_id,
          sourceRevision: row.source_revision,
          fetchedAt: row.fetched_at,
          freshnessTtlSeconds: row.freshness_ttl_seconds,
        }
      : undefined;
  } finally {
    db.close();
  }
}

function excerptForTerms(text: string, terms: string[]): { excerpt: string; score: number } {
  const normalized = text.toLowerCase();
  let score = 0;
  let first = Number.POSITIVE_INFINITY;
  for (const term of terms) {
    let offset = normalized.indexOf(term);
    while (offset >= 0) {
      score += 1;
      first = Math.min(first, offset);
      offset = normalized.indexOf(term, offset + term.length);
    }
  }
  if (score === 0) {
    return { excerpt: "", score: 0 };
  }
  const start = Math.max(0, first - 300);
  return {
    excerpt: text
      .slice(start, start + MAX_SEARCH_CHUNK_CHARS)
      .replace(/\s+/g, " ")
      .trim(),
    score,
  };
}

export async function searchCorpus(
  workspace: string,
  query: string,
  limit = 8,
): Promise<CorpusSearchResult[]> {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length >= 2)
    .slice(0, 12);
  if (terms.length === 0) {
    return [];
  }
  const db = open(workspace);
  let rows: Array<{
    source_id: string;
    path: string;
    provenance: string;
    source_revision: number;
    fetched_at: number | null;
    trusted_as_project_source: number;
    extracted_artifact: string | null;
  }>;
  try {
    rows = db
      .prepare(`
        SELECT source_id, path, provenance, source_revision, fetched_at,
          trusted_as_project_source, extracted_artifact
        FROM sources WHERE extraction_status = 'extracted' AND extracted_artifact IS NOT NULL
        ORDER BY uploaded_at DESC LIMIT 200
      `)
      .all() as typeof rows;
  } finally {
    db.close();
  }
  const results: CorpusSearchResult[] = [];
  for (const row of rows) {
    if (!row.extracted_artifact) {
      continue;
    }
    try {
      const stat = await fs.promises.stat(row.extracted_artifact);
      if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) {
        continue;
      }
      const match = excerptForTerms(
        await fs.promises.readFile(row.extracted_artifact, "utf8"),
        terms,
      );
      if (match.score > 0) {
        results.push({
          source_id: row.source_id,
          path: row.path,
          provenance: row.provenance,
          source_revision: row.source_revision,
          fetched_at: row.fetched_at,
          trusted_as_project_source: row.trusted_as_project_source === 1,
          excerpt: match.excerpt,
          score: match.score,
        });
      }
    } catch {
      // A missing rebuildable artifact is reconciled separately; search skips it safely.
    }
  }
  return results.toSorted((left, right) => right.score - left.score).slice(0, Math.min(20, limit));
}

export async function corpusDiskState(workspace: string): Promise<{
  usedPercent: number;
  extractionAllowed: boolean;
  cacheEvicted: boolean;
}> {
  const stat = await fs.promises.statfs(workspace);
  const total = stat.blocks * stat.bsize;
  const free = stat.bavail * stat.bsize;
  const usedPercent = total > 0 ? ((total - free) / total) * 100 : 100;
  let cacheEvicted = false;
  if (usedPercent >= 75) {
    const db = open(workspace);
    try {
      db.exec("DELETE FROM read_cache;");
      cacheEvicted = true;
    } finally {
      db.close();
    }
  }
  return { usedPercent, extractionAllowed: usedPercent < 85, cacheEvicted };
}

export async function corpusPreprocessingAllowed(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.MAGISTER_RESOURCE_ADMISSION_ENABLED !== "1") {
    return true;
  }
  const root = env.MAGISTER_CGROUP_ROOT ?? "/sys/fs/cgroup";
  try {
    const [currentRaw, maximumRaw] = await Promise.all([
      fs.promises.readFile(path.join(root, "memory.current"), "utf8"),
      fs.promises.readFile(path.join(root, "memory.max"), "utf8"),
    ]);
    const current = Number(currentRaw.trim());
    const maximum = maximumRaw.trim() === "max" ? os.totalmem() : Number(maximumRaw.trim());
    return (
      Number.isFinite(current) &&
      current >= 0 &&
      Number.isFinite(maximum) &&
      maximum > 0 &&
      current / maximum < 0.7
    );
  } catch {
    return false;
  }
}
