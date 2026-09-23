import type { MsgContext } from "./templating.js";

function sanitizeNoteValue(value: string): string {
  return value
    .replace(/[\p{Cc}\]]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatPasteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describePaste(paste: { path: string; bytes: number; lines: number }): string {
  return `${sanitizeNoteValue(paste.path)} (${paste.lines} lines, ${formatPasteSize(paste.bytes)})`;
}

const GUIDANCE =
  "the same content is inline below; compute from the file rather than from the chat text";

/**
 * `[pasted data saved: inbox/ads_daily-3f2a9c1e.csv (785 lines, 54.2 KB); …]`
 * in the same position the media note takes, so the model learns the file
 * exists before it reads the paste.
 */
export function buildInboundPasteNote(ctx: Pick<MsgContext, "PasteFiles">): string | undefined {
  const pastes = Array.isArray(ctx.PasteFiles) ? ctx.PasteFiles.filter(Boolean) : [];
  if (pastes.length === 0) {
    return undefined;
  }
  if (pastes.length === 1) {
    const [only] = pastes;
    return `[pasted data saved: ${describePaste(only)}; ${GUIDANCE}]`;
  }
  const lines = [`[pasted data saved: ${pastes.length} files; ${GUIDANCE}]`];
  pastes.forEach((paste, index) => {
    lines.push(`[pasted data ${index + 1}/${pastes.length}: ${describePaste(paste)}]`);
  });
  return lines.join("\n");
}

/**
 * The same note for prompt paths that have no prelude slot (the gateway's
 * agent command builds the prompt body directly): prefix the body, leave the
 * body alone when nothing was materialized.
 */
export function prependInboundPasteNote(
  body: string,
  pastes: MsgContext["PasteFiles"] | undefined,
): string {
  const note = buildInboundPasteNote({ PasteFiles: pastes });
  if (!note) {
    return body;
  }
  return body.trim() ? `${note}\n\n${body}` : note;
}
