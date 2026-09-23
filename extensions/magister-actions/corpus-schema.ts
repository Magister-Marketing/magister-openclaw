import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CORPUS_SCHEMA_VERSION = 2;

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
}

function addColumn(db: DatabaseSync, table: string, definition: string): void {
  const name = definition.split(/\s+/, 1)[0] ?? "";
  if (name && !columns(db, table).has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition};`);
  }
}

function migrate(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  const current = versionRow?.user_version ?? 0;
  if (!Number.isInteger(current) || current < 0 || current > CORPUS_SCHEMA_VERSION) {
    throw new Error(`unsupported corpus schema version: ${current}`);
  }
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        detected_mime TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        provenance TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL,
        parser_version TEXT NOT NULL,
        extraction_status TEXT NOT NULL,
        extracted_artifact TEXT,
        trusted_as_project_source INTEGER NOT NULL DEFAULT 0,
        source_revision INTEGER NOT NULL,
        fetched_at INTEGER,
        freshness_ttl_seconds INTEGER,
        source_url TEXT,
        project_scope TEXT,
        account_scope TEXT,
        source_kind TEXT NOT NULL DEFAULT 'upload'
      );
      CREATE INDEX IF NOT EXISTS sources_sha256_idx ON sources(sha256);
      CREATE TABLE IF NOT EXISTS upload_manifests (
        manifest_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        detected_mime TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        uploaded_at INTEGER NOT NULL,
        provenance TEXT NOT NULL,
        extraction_status TEXT NOT NULL,
        extracted_artifact TEXT,
        parser_version TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        summary_revision INTEGER NOT NULL DEFAULT 0,
        trusted_as_project_source INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS summaries (
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        summary_revision INTEGER NOT NULL,
        source_revision INTEGER NOT NULL,
        summary_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(source_id, summary_revision)
      );
      CREATE TABLE IF NOT EXISTS read_cache (
        cache_key TEXT PRIMARY KEY,
        project_scope TEXT NOT NULL,
        account_scope TEXT,
        input_hash TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        freshness_ttl_seconds INTEGER NOT NULL,
        parser_version TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ingestion_rejections (
        rejection_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        sha256 TEXT,
        detected_mime TEXT,
        byte_size INTEGER,
        provenance TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        extraction_status TEXT NOT NULL,
        failure_code TEXT NOT NULL,
        rejected_at INTEGER NOT NULL
      );
    `);

    // Version 1 existed briefly without these adapter/manifest fields. Additive
    // ALTERs keep that image's legacy SELECTs valid after an upgrade.
    addColumn(db, "sources", "source_url TEXT");
    addColumn(db, "sources", "project_scope TEXT");
    addColumn(db, "sources", "account_scope TEXT");
    addColumn(db, "sources", "source_kind TEXT NOT NULL DEFAULT 'upload'");
    addColumn(db, "upload_manifests", "summary_revision INTEGER NOT NULL DEFAULT 0");
    db.exec(`PRAGMA user_version = ${CORPUS_SCHEMA_VERSION};`);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

export function corpusDatabasePath(workspace: string): string {
  return path.join(workspace, ".magister", "state", "corpus.sqlite");
}

export function openCorpusDatabase(workspace: string): DatabaseSync {
  const dbPath = corpusDatabasePath(workspace);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;",
  );
  migrate(db);
  fs.chmodSync(dbPath, 0o600);
  return db;
}
