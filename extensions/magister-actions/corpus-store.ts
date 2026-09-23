import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { type ExtractionResult, PARSER_VERSION } from "./corpus-contract.js";
import { openCorpusDatabase } from "./corpus-schema.js";

export type CorpusSource = {
  sourceId: string;
  sourceRevision: number;
  duplicate: boolean;
};

export class CorpusStore {
  private readonly db: DatabaseSync;

  constructor(workspace: string) {
    this.db = openCorpusDatabase(workspace);
  }

  record(params: {
    relativePath: string;
    sha256: string;
    mime: string;
    byteSize: number;
    provenance: string;
    extraction: ExtractionResult;
  }): CorpusSource {
    const existing = this.db
      .prepare("SELECT source_id, sha256, source_revision FROM sources WHERE path = ?")
      .get(params.relativePath) as
      | { source_id: string; sha256: string; source_revision: number }
      | undefined;
    const sourceId = existing?.source_id ?? randomUUID();
    const sourceRevision = existing
      ? existing.sha256 === params.sha256
        ? existing.source_revision
        : existing.source_revision + 1
      : 1;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(`
          INSERT INTO sources (
            source_id, path, sha256, detected_mime, byte_size, provenance,
            uploaded_at, parser_version, extraction_status, extracted_artifact,
            trusted_as_project_source, source_revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(path) DO UPDATE SET
            sha256 = excluded.sha256,
            detected_mime = excluded.detected_mime,
            byte_size = excluded.byte_size,
            provenance = excluded.provenance,
            uploaded_at = excluded.uploaded_at,
            parser_version = excluded.parser_version,
            extraction_status = excluded.extraction_status,
            extracted_artifact = excluded.extracted_artifact,
            source_revision = excluded.source_revision
        `)
        .run(
          sourceId,
          params.relativePath,
          params.sha256,
          params.mime,
          params.byteSize,
          params.provenance,
          now,
          PARSER_VERSION,
          params.extraction.status,
          params.extraction.artifactPath,
          sourceRevision,
        );
      this.db
        .prepare(`
          INSERT INTO upload_manifests (
            manifest_id, source_id, path, sha256, detected_mime, byte_size,
            uploaded_at, provenance, extraction_status, extracted_artifact,
            parser_version, source_revision, summary_revision, trusted_as_project_source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
        `)
        .run(
          randomUUID(),
          sourceId,
          params.relativePath,
          params.sha256,
          params.mime,
          params.byteSize,
          now,
          params.provenance,
          params.extraction.status,
          params.extraction.artifactPath,
          PARSER_VERSION,
          sourceRevision,
        );
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return {
      sourceId,
      sourceRevision,
      duplicate: existing?.sha256 === params.sha256,
    };
  }

  recordRejection(params: {
    relativePath: string;
    sha256?: string;
    mime?: string;
    byteSize?: number;
    provenance: string;
    failureCode: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO ingestion_rejections (
          rejection_id, path, sha256, detected_mime, byte_size, provenance,
          parser_version, extraction_status, failure_code, rejected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?)
      `)
      .run(
        randomUUID(),
        params.relativePath,
        params.sha256 ?? null,
        params.mime ?? null,
        params.byteSize ?? null,
        params.provenance,
        PARSER_VERSION,
        params.failureCode.slice(0, 120),
        Date.now(),
      );
  }

  close(): void {
    this.db.close();
  }
}
