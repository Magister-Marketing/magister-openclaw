/**
 * A long message is a brief, a document, or pasted copy: the deliverable it
 * asks for has supplied material to honor. The skill rules in the system
 * prompt did not reach these turns: across two benchmark runs every
 * "respond to the attached brief" attempt answered in one model call with
 * no tool and no skill read (24 of 24, 2026-10-03), and the misses were all
 * of one kind, a resource the brief never supplied (a budget to move a cost
 * to, hours nobody approved, a claim no fact supports). The note sits on the
 * sent body only, like the paste note, so the transcript and the cached
 * prefix are unchanged.
 */
export const BRIEF_NOTE_MIN_CHARS = 1_500;

const GUIDANCE =
  "before the deliverable, read the SKILL.md that covers it; the material is the complete set of supplied facts, so a figure, budget, capacity, claim, or option it does not state comes from a tool output or is named as missing or declined, never assumed";

export function buildInboundBriefNote(params: {
  body: string | undefined;
  hasPasteNote: boolean;
}): string | undefined {
  if (params.hasPasteNote) {
    return undefined;
  }
  const length = params.body?.trim().length ?? 0;
  if (length < BRIEF_NOTE_MIN_CHARS) {
    return undefined;
  }
  return `[long message: ${length.toLocaleString("en-US")} chars of supplied material inline below; ${GUIDANCE}]`;
}

/** Prefix for prompt paths without a prelude slot; the body is left alone below the threshold. */
export function prependInboundBriefNote(
  body: string,
  params: { message: string; hasPasteNote: boolean },
): string {
  const note = buildInboundBriefNote({ body: params.message, hasPasteNote: params.hasPasteNote });
  if (!note) {
    return body;
  }
  return body.trim() ? `${note}\n\n${body}` : note;
}
