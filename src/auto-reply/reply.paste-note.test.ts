import { describe, expect, it } from "vitest";
import { formatPasteSize, prependInboundPasteNote } from "./paste-note.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import { buildReplyPromptBodies } from "./reply/prompt-prelude.js";

describe("paste note plumbing", () => {
  const paste = {
    path: "inbox/ads_daily-3f2a9c1e.csv",
    bytes: 55_500,
    lines: 785,
    name: "ads_daily.csv",
  };

  it("names the saved file ahead of the body in every prompt variant", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "hello",
      BodyForAgent: "hello",
      From: "+1001",
      To: "+2000",
      PasteFiles: [paste],
    });
    const bodies = buildReplyPromptBodies({
      ctx: sessionCtx,
      sessionCtx,
      effectiveBaseBody: sessionCtx.BodyForAgent,
      prefixedBody: sessionCtx.BodyForAgent,
    });
    const expected = "[pasted data saved: inbox/ads_daily-3f2a9c1e.csv (785 lines, 54.2 KB);";
    expect(bodies.pasteNote).toContain(expected);
    for (const prompt of [
      bodies.prefixedCommandBody,
      bodies.queuedBody,
      bodies.transcriptCommandBody,
    ]) {
      expect(prompt.indexOf(expected)).toBeGreaterThanOrEqual(0);
      expect(prompt.indexOf(expected)).toBeLessThan(prompt.indexOf("hello"));
    }
  });

  it("lists several files one per line", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "hi",
      BodyForAgent: "hi",
      PasteFiles: [paste, { ...paste, path: "inbox/paste-2-3f2a9c1e.json", bytes: 900, lines: 1 }],
    });
    const note = buildReplyPromptBodies({
      ctx: sessionCtx,
      sessionCtx,
      effectiveBaseBody: "hi",
      prefixedBody: "hi",
    }).pasteNote;
    expect(note).toContain("[pasted data saved: 2 files;");
    // The skill step rides on the note in both shapes: it is the one
    // instruction the model reliably follows on a pasted-data turn.
    expect(note).toContain("first read the SKILL.md that covers this task, then compute");
    expect(note).toContain("[pasted data 1/2: inbox/ads_daily-3f2a9c1e.csv (785 lines, 54.2 KB)]");
    expect(note).toContain("[pasted data 2/2: inbox/paste-2-3f2a9c1e.json (1 lines, 900 B)]");
  });

  it("adds nothing when no paste was saved", () => {
    const sessionCtx = finalizeInboundContext({ Body: "hi", BodyForAgent: "hi" });
    const bodies = buildReplyPromptBodies({
      ctx: sessionCtx,
      sessionCtx,
      effectiveBaseBody: "hi",
      prefixedBody: "hi",
    });
    expect(bodies.pasteNote).toBeUndefined();
    expect(bodies.prefixedCommandBody).toBe("hi");
  });

  it("formats sizes the way a person reads them", () => {
    expect(formatPasteSize(512)).toBe("512 B");
    expect(formatPasteSize(55_500)).toBe("54.2 KB");
    expect(formatPasteSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("prependInboundPasteNote", () => {
  const paste = {
    path: "inbox/ads_daily-3f2a9c1e.csv",
    bytes: 55_500,
    lines: 785,
    name: "ads_daily.csv",
  };

  it("prefixes the body with the note when a paste was written", () => {
    expect(prependInboundPasteNote("Review the quarter.", [paste])).toBe(
      "[pasted data saved: inbox/ads_daily-3f2a9c1e.csv (785 lines, 54.2 KB); the same content is inline below; first read the SKILL.md that covers this task, then compute from the file rather than from the chat text]\n\nReview the quarter.",
    );
  });

  it("leaves the body alone when nothing was materialized", () => {
    expect(prependInboundPasteNote("Review the quarter.", [])).toBe("Review the quarter.");
    expect(prependInboundPasteNote("Review the quarter.", undefined)).toBe("Review the quarter.");
  });
});
