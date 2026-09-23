import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type IngestionResult,
  IngestionError,
  MAX_REQUEST_BYTES,
  corpusLimits,
  workspaceDir,
} from "./corpus-contract.js";
import {
  defaultDestination,
  downloadToStaging,
  ingestOne,
  normalizeDestination,
  writeBase64ToStaging,
} from "./corpus-ingestion.js";
import { type LocalMutationContext, parseLocalMutationContext } from "./mutation-observer.js";

type UploadFile = {
  name: string;
  type?: string;
  data: string;
  destination_path?: string;
};

type IngestionRequest = {
  files?: UploadFile[];
  session_key?: string;
  download_url?: string;
  destination_path?: string;
  filename?: string;
  declared_mime?: string;
  extract?: boolean;
  provenance?: string;
  mutation_context?: LocalMutationContext;
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new IngestionError("upload request exceeds the bounded request size", 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new IngestionError("upload request must be valid JSON");
  }
}

function parseRequest(value: unknown): IngestionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IngestionError("upload request must be an object");
  }
  const request = value as Record<string, unknown>;
  const files = Array.isArray(request.files)
    ? request.files.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new IngestionError("files entries must be objects");
        }
        const row = item as Record<string, unknown>;
        if (typeof row.name !== "string" || typeof row.data !== "string") {
          throw new IngestionError("each file requires name and base64 data");
        }
        return {
          name: row.name,
          data: row.data,
          ...(typeof row.type === "string" ? { type: row.type } : {}),
          ...(typeof row.destination_path === "string"
            ? { destination_path: row.destination_path }
            : {}),
        };
      })
    : undefined;
  const mutationContext = parseLocalMutationContext(request.mutation_context);
  if (request.mutation_context !== undefined && !mutationContext) {
    throw new IngestionError("upload mutation context is invalid", 409);
  }
  if (
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT === "1" &&
    mutationContext?.mode !== "enforce"
  ) {
    throw new IngestionError("upload requires a current enforced mutation fence", 409);
  }
  return {
    files,
    ...(typeof request.session_key === "string" ? { session_key: request.session_key } : {}),
    ...(typeof request.download_url === "string" ? { download_url: request.download_url } : {}),
    ...(typeof request.destination_path === "string"
      ? { destination_path: request.destination_path }
      : {}),
    ...(typeof request.filename === "string" ? { filename: request.filename } : {}),
    ...(typeof request.declared_mime === "string" ? { declared_mime: request.declared_mime } : {}),
    extract: request.extract === true,
    ...(typeof request.provenance === "string" ? { provenance: request.provenance } : {}),
    ...(mutationContext ? { mutation_context: mutationContext } : {}),
  };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

export async function handleCorpusIngestion(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    const request = parseRequest(await readJsonBody(req));
    const workspace = workspaceDir();
    const results: IngestionResult[] = [];
    if (request.files?.length) {
      if (request.files.length > 10) {
        throw new IngestionError("a chat upload may contain at most 10 files");
      }
      for (const file of request.files) {
        const destination = file.destination_path
          ? normalizeDestination(workspace, file.destination_path)
          : defaultDestination(workspace, file.name);
        results.push(
          await ingestOne({
            workspace,
            destination,
            filename: file.name,
            declaredMime: file.type,
            provenance: request.provenance ?? "chat",
            extract: request.extract === true,
            mutationContext: request.mutation_context,
            writeStaging: async (stagingPath) => await writeBase64ToStaging(file.data, stagingPath),
          }),
        );
      }
    } else if (request.download_url && request.destination_path && request.filename) {
      results.push(
        await ingestOne({
          workspace,
          destination: normalizeDestination(workspace, request.destination_path),
          filename: request.filename,
          declaredMime: request.declared_mime,
          provenance: request.provenance ?? "signed_url",
          extract: request.extract === true,
          mutationContext: request.mutation_context,
          writeStaging: async (stagingPath) =>
            await downloadToStaging(request.download_url ?? "", stagingPath),
        }),
      );
    } else {
      throw new IngestionError("provide files or a signed download upload contract");
    }
    sendJson(res, 200, { status: "ok", files: results });
  } catch (error) {
    const status = error instanceof IngestionError ? error.statusCode : 500;
    let message: string;
    if (error instanceof IngestionError) {
      message = error.message;
    } else {
      // A bare "ingestion failed" erased the crash cause from every
      // off-machine surface — two production wedges (2026-08-05, 2026-08-07)
      // went undiagnosable. Name the error class only: bounded identifier,
      // no message text, so nothing sensitive leaves the machine.
      message = `ingestion failed (${crashClass(error)})`;
      console.error(`[magister-corpus] ingestion crash class=${crashClass(error)}`);
    }
    sendJson(res, status, { error: "ingestion_rejected", message });
  }
  return true;
}

/** Bounded identifier for a non-IngestionError crash: fs/sqlite `code` when
 * present (EACCES, SQLITE_BUSY, …), else the constructor name. */
function crashClass(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const name = error instanceof Error ? error.name : typeof error;
  const raw = typeof code === "string" && code ? code : name;
  const safe = raw.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
  return safe || "unknown";
}

export { corpusLimits };
export type { IngestionResult };
