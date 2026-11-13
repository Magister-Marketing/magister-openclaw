export type LibraryFile = {
  file_id: string;
  revision_id: string;
  project_id: string;
  path: string;
  entry_type: "file" | "directory";
  ownership: "user" | "managed";
  lifecycle: "active" | "trashed";
  size: number;
  sha256?: string;
  content_type?: string;
  managed_edit_target?: unknown;
};
export type LibraryState = {
  project_id: string;
  mode: "legacy" | "shadow" | "active" | "recovery";
  epoch: number;
  sequence: number;
  publication: { pending: number; failed: number };
  coverage: { complete: boolean; pending_sources: string[] };
};
export type LibraryCache = {
  project_id: string;
  epoch: number;
  sequence: number;
  files: Record<string, LibraryFile>;
};
export type LibraryChange =
  | {
      kind: "create";
      path: string;
      expected_absent: true;
      text?: string;
      upload_id?: string;
      content_type?: string;
    }
  | {
      kind: "replace";
      file_id: string;
      expected_revision: string;
      text?: string;
      upload_id?: string;
      content_type?: string;
    }
  | { kind: "trash"; file_id: string; expected_revision: string }
  | { kind: "move"; file_id: string; expected_revision: string; path: string };
export type LibraryCommit = {
  project_id: string;
  operation_id: string;
  expected_epoch: number;
  changes: LibraryChange[];
};
export type LibraryReceipt = {
  operation_id: string;
  status: "committed" | "rejected";
  project_id: string;
  epoch: number;
  sequence: number;
  files: LibraryFile[];
  error?: unknown;
  cloud_saved: boolean;
  materialization: "pending" | "not_required";
};
export type LibraryBridge = {
  request: <T>(
    method: "GET" | "POST",
    endpoint: string,
    values?: Record<string, unknown>,
  ) => Promise<T>;
  download: (url: string) => Promise<Buffer>;
  upload: (url: string, bytes: Buffer, contentType: string) => Promise<void>;
};
