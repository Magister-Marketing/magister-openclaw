import path from "node:path";
import { IngestionError } from "./corpus-contract.js";

const MIME_BY_EXTENSION: Record<string, readonly string[]> = {
  ".pdf": ["application/pdf"],
  ".csv": ["text/csv", "text/plain"],
  ".txt": ["text/plain"],
  ".md": ["text/plain", "text/markdown"],
  ".html": ["text/plain", "text/html"],
  ".htm": ["text/plain", "text/html"],
  ".json": ["text/plain", "application/json"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"],
  ".zip": ["application/zip"],
  ".docx": [
    "application/zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ".xlsx": ["application/zip", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".pptx": [
    "application/zip",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ".mp4": ["video/mp4"],
  ".mov": ["video/quicktime", "video/mp4"],
  ".webm": ["video/webm"],
};

export function detectMime(head: Buffer, filename: string): string {
  if (head.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    head.subarray(0, 6).toString("ascii") === "GIF87a" ||
    head.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return "image/gif";
  }
  if (
    head.subarray(0, 4).toString("ascii") === "RIFF" &&
    head.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return "video/webm";
  }
  if (head.subarray(4, 8).toString("ascii") === "ftyp") {
    return head.subarray(8, 12).toString("ascii") === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (head[0] === 0x50 && head[1] === 0x4b && [0x03, 0x05, 0x07].includes(head[2] ?? -1)) {
    return "application/zip";
  }
  if (head.includes(0)) {
    throw new IngestionError("unsupported binary file type");
  }
  return path.extname(filename).toLowerCase() === ".csv" ? "text/csv" : "text/plain";
}

export function assertMimeAgreement(filename: string, detected: string, declared?: string): void {
  const extension = path.extname(filename).toLowerCase();
  const accepted = MIME_BY_EXTENSION[extension];
  if (!accepted || !accepted.includes(detected)) {
    throw new IngestionError("file extension does not match detected content type");
  }
  if (declared && declared !== "application/octet-stream") {
    const declaredBase = declared.split(";", 1)[0]?.trim().toLowerCase();
    if (declaredBase && !accepted.includes(declaredBase) && declaredBase !== detected) {
      throw new IngestionError("declared MIME type does not match file content");
    }
  }
}

export function imageDimensions(head: Buffer, mime: string): { width: number; height: number } {
  if (mime === "image/png" && head.length >= 24) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  if (mime === "image/gif" && head.length >= 10) {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  if (
    mime === "image/webp" &&
    head.subarray(12, 16).toString("ascii") === "VP8X" &&
    head.length >= 30
  ) {
    return {
      width: 1 + head.readUIntLE(24, 3),
      height: 1 + head.readUIntLE(27, 3),
    };
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = head[offset + 1] ?? 0;
      const length = head.readUInt16BE(offset + 2);
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        return { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) };
      }
      if (length < 2) {
        break;
      }
      offset += length + 2;
    }
  }
  throw new IngestionError("image dimensions could not be safely determined");
}
