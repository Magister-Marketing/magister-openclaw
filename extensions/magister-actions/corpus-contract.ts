import fs from "node:fs";
import path from "node:path";

export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 72 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_PAGES = 250;
export const MAX_CSV_ROWS = 5_000;
export const MAX_CSV_COLUMNS = 100;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_ARCHIVE_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 10_000;
export const MAX_ARCHIVE_RATIO = 100;
export const PARSER_VERSION = "magister-corpus-v1";

export type IngestionResult = {
  path: string;
  sha256: string;
  detected_mime: string;
  byte_size: number;
  duplicate: boolean;
  extraction_status: string;
  extracted_artifact: string | null;
  source_revision: number;
};

export type ExtractionResult = {
  status: string;
  artifactPath: string | null;
};

export class IngestionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export function workspaceDir(): string {
  return path.resolve(process.env.OPENCLAW_WORKSPACE_DIR ?? "/data/.openclaw/workspace");
}

export function stateRoot(workspace: string): string {
  return path.join(workspace, ".magister");
}

export async function fsyncPath(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function fsyncDir(dirPath: string): Promise<void> {
  const handle = await fs.promises.open(dirPath, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const corpusLimits = {
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxPdfPages: MAX_PDF_PAGES,
  maxCsvRows: MAX_CSV_ROWS,
  maxCsvColumns: MAX_CSV_COLUMNS,
  maxImagePixels: MAX_IMAGE_PIXELS,
  maxArchiveExpandedBytes: MAX_ARCHIVE_EXPANDED_BYTES,
  parserVersion: PARSER_VERSION,
};
