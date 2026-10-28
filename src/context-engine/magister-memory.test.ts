import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegacyContextEngine } from "./legacy.js";
import {
  createMagisterMemoryContextEngine,
  MagisterMemoryContextEngine,
} from "./magister-memory.js";

describe("MagisterMemoryContextEngine", () => {
  let dir: string;
  let memoryPath: string;
  let userPath: string;
  let projectPath: string;
  let brandPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mem-engine-test-"));
    memoryPath = join(dir, "MEMORY.md");
    userPath = join(dir, "USER.md");
    projectPath = join(dir, "PROJECT.md");
    brandPath = join(dir, "BRAND.md");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the shared provenance projection instead of labeling confirmed rules as inferred", async () => {
    await mkdir(join(dir, ".magister", "state"), { recursive: true });
    await writeFile(memoryPath, "old legacy note");
    await writeFile(
      join(dir, ".magister", "state", "marketing-context.json"),
      JSON.stringify({
        revision: 2,
        rendered: "Confirmed rules: use short sentences.\nObserved style: candid.",
        stale: true,
      }),
    );
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    const result = await engine.assemble({ sessionId: "same", messages: [] });
    expect(result.systemPromptAddition).toContain("source=shared_marketing_context");
    expect(result.systemPromptAddition).toContain("Confirmed rules: use short sentences");
    expect(result.systemPromptAddition).toContain("Refresh failed");
    expect(result.systemPromptAddition).not.toContain("older_inferred_memory");
  });

  it("returns inner result unchanged when both files are absent", async () => {
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    const res = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(res.systemPromptAddition ?? "").not.toContain("## Memory");
    expect(res.systemPromptAddition ?? "").not.toContain("## User Profile");
  });

  it("folds memory, user, and project content into system prompt addition", async () => {
    await writeFile(memoryPath, "Fact 1\n§\nFact 2");
    await writeFile(userPath, "User likes X");
    await writeFile(projectPath, "Acme assignment");
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    const res = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(res.systemPromptAddition).toContain("## Memory (about the project)");
    expect(res.systemPromptAddition).toContain("Fact 1");
    expect(res.systemPromptAddition).toContain("## User Profile");
    expect(res.systemPromptAddition).toContain("User likes X");
    expect(res.systemPromptAddition).toContain("## Project Assignment");
    expect(res.systemPromptAddition).toContain("Acme assignment");
    expect(res.systemPromptAddition).toContain("provenance=trusted_project_state");
  });

  it("holds one snapshot for the model calls of a run", async () => {
    await writeFile(memoryPath, "Original");
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });

    const first = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(first.systemPromptAddition).toContain("Original");

    // The file changes during the run; this run's later calls keep its snapshot.
    await writeFile(memoryPath, "Updated");
    const second = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(second.systemPromptAddition).toContain("Original");
    expect(second.systemPromptAddition).not.toContain("Updated");
  });

  it("re-reads an empty snapshot within a run and holds it once content appears", async () => {
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });

    // First assemble: no files exist yet — snapshot is empty.
    const first = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(first.systemPromptAddition ?? "").not.toContain("Seeded memory entry");

    // Files appear after the session already started (the provision race).
    await writeFile(memoryPath, "Seeded memory entry");

    // Second assemble on the SAME session must pick the content up.
    const second = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(second.systemPromptAddition).toContain("Seeded memory entry");

    // And once non-empty, the run holds it: later writes do not appear.
    await writeFile(memoryPath, "Rewritten later");
    const third = await engine.assemble({ sessionId: "s1", messages: [] });
    expect(third.systemPromptAddition).toContain("Seeded memory entry");
    expect(third.systemPromptAddition).not.toContain("Rewritten later");
  });

  it("reads edited memory on the next turn, which gets a new engine", async () => {
    // resolveContextEngine builds an engine per run; an edit reaches the next
    // turn of the same session (the intended behaviour, not a frozen session).
    const turn = () =>
      new MagisterMemoryContextEngine({
        memoryPath,
        userPath,
        projectPath,
        brandPath,
        inner: new LegacyContextEngine(),
      }).assemble({ sessionId: "s1", messages: [] });
    await writeFile(memoryPath, "Original");
    expect((await turn()).systemPromptAddition).toContain("Original");

    await writeFile(memoryPath, "Updated");
    const next = await turn();
    expect(next.systemPromptAddition).toContain("Updated");
    expect(next.systemPromptAddition).not.toContain("Original");
  });

  it("re-reads for a new session", async () => {
    await writeFile(memoryPath, "Original");
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    await engine.assemble({ sessionId: "s1", messages: [] });

    await writeFile(memoryPath, "Updated");
    const fresh = await engine.assemble({ sessionId: "s2", messages: [] });
    expect(fresh.systemPromptAddition).toContain("Updated");
  });

  it("production factory scopes file paths to the provided workspaceDir", async () => {
    // Simulates an agent with its own workspace (e.g. heartbeat): the engine
    // must read that workspace's files, not the hardcoded marketing root.
    await writeFile(memoryPath, "Workspace-scoped memory");
    const engine = createMagisterMemoryContextEngine({ workspaceDir: dir });
    const result = await engine.assemble({ sessionId: "ws1", messages: [] });
    expect(result.systemPromptAddition).toContain("Workspace-scoped memory");
  });

  it("injects bounded sourced brand claims, with the full block for brand work", async () => {
    await writeFile(
      brandPath,
      [
        "# Brand context",
        "",
        "Content outside the generated markers is user-owned and takes precedence.",
        "",
        "Confirmed voice: precise and warm.",
        "<!-- MAGISTER:GENERATED BRAND START -->",
        "Audit inference: energetic tone.",
        "<!-- MAGISTER:GENERATED BRAND END -->",
      ].join("\n"),
    );
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });

    const relevant = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "Draft homepage copy in our brand voice",
    });
    expect(relevant.systemPromptAddition).toContain("Confirmed voice: precise and warm.");
    expect(relevant.systemPromptAddition).toContain("Audit inference: energetic tone.");
    expect(relevant.systemPromptAddition).toContain(
      "provenance=user_authored_content source=brand_file_overrides",
    );
    expect(relevant.systemPromptAddition).toContain(
      "provenance=trusted_project_state source=current_audit_inference",
    );
    expect(relevant.systemPromptAddition!.indexOf("Confirmed voice")).toBeLessThan(
      relevant.systemPromptAddition!.indexOf("Audit inference"),
    );
    expect(relevant.systemPromptAddition!.length).toBeLessThan(6_000);
  });

  // The old gate matched none of these, so every one of them produced a
  // deliverable with no brand context at all. They are the formats users
  // actually name, so they are pinned here.
  const BRAND_TASK_PROMPTS = [
    "Write me a blog post on how solar tax credits changed",
    "Make an X post announcing the launch",
    "Draft an Instagram caption for this photo",
    "Write an article about AI in energy",
    "Generate an image for the hero section",
    "Make a LinkedIn post",
    "Write a newsletter",
    "Create a carousel for Instagram",
    "Give me 5 headline ideas",
    "Write a case study",
    "Make a poster for the event",
    "What should we post today?",
    "Write a product announcement",
    "Draft a press release",
    "Write a tweet about our new feature",
  ];

  it.each(BRAND_TASK_PROMPTS)("treats %j as brand work", async (prompt) => {
    // Sized to fit the full 4,500-char tier but not the 1,200-char core tier.
    const filler = "Positioning detail. ".repeat(100);
    await writeFile(
      brandPath,
      [
        "<!-- MAGISTER:GENERATED BRAND START -->",
        "### Generated from the latest marketing audit",
        "",
        "## Voice",
        "",
        "Tone: precise, warm",
        "",
        "## Visual identity",
        "",
        "Colors: #040404, #e50a13",
        "",
        "## Ideal customer",
        "",
        filler,
        "<!-- MAGISTER:GENERATED BRAND END -->",
      ].join("\n"),
    );
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    const res = await engine.assemble({ sessionId: "s1", messages: [], prompt });
    // The full tier admits the long trailing section; the core tier would not.
    expect(res.systemPromptAddition).toContain("Positioning detail.");
  });

  it("keeps the full brand tier for the rest of a session once it was needed", async () => {
    await writeFile(
      brandPath,
      [
        "<!-- MAGISTER:GENERATED BRAND START -->",
        "### Generated from the latest marketing audit",
        "",
        "## Voice",
        "",
        "Tone: precise, warm",
        "",
        "## Ideal customer",
        "",
        "Positioning detail. ".repeat(100),
        "<!-- MAGISTER:GENERATED BRAND END -->",
      ].join("\n"),
    );
    // resolveContextEngine builds a new engine for every run, so each turn
    // here gets its own instance, as on a machine.
    const turn = (sessionId: string, prompt: string) =>
      new MagisterMemoryContextEngine({
        memoryPath,
        userPath,
        projectPath,
        brandPath,
        inner: new LegacyContextEngine(),
      }).assemble({ sessionId, messages: [], prompt });
    const notBrand = "What is the current server uptime?";
    const first = await turn("s1", notBrand);
    expect(first.systemPromptAddition).not.toContain("Positioning detail.");

    // A workflow's brand-shaped step steps the session up to the full tier…
    const brand = await turn("s1", "Draft homepage copy in our brand voice");
    expect(brand.systemPromptAddition).toContain("Positioning detail.");
    // …and the next step keeps it byte-identical, so the prompt cache holds.
    const next = await turn("s1", notBrand);
    expect(next.systemPromptAddition).toBe(brand.systemPromptAddition);

    // Another session still starts at the core tier.
    const other = await turn("s2", notBrand);
    expect(other.systemPromptAddition).toBe(first.systemPromptAddition);
  });

  it("still injects a voice and visual floor when the prompt is not brand work", async () => {
    await writeFile(
      brandPath,
      [
        "<!-- MAGISTER:GENERATED BRAND START -->",
        "### Generated from the latest marketing audit",
        "",
        "## Voice",
        "",
        "Tone: precise, warm",
        "",
        "## Visual identity",
        "",
        "Colors: #040404, #e50a13",
        "",
        "## Ideal customer",
        "",
        "Detail. ".repeat(400),
        "<!-- MAGISTER:GENERATED BRAND END -->",
      ].join("\n"),
    );
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    const res = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "What is the current server uptime?",
    });
    // Identity is always available — the agent can no longer be silently blind.
    expect(res.systemPromptAddition).toContain("Tone: precise, warm");
    expect(res.systemPromptAddition).toContain("Colors: #040404, #e50a13");
    // …but the long tail is held back at the core budget, and says so.
    expect(res.systemPromptAddition).not.toContain("Detail. Detail.");
    expect(res.systemPromptAddition).toContain("Omitted for length: Ideal customer");
  });

  it("drops whole trailing sections rather than slicing one in half", async () => {
    await writeFile(
      brandPath,
      [
        "<!-- MAGISTER:GENERATED BRAND START -->",
        "### Generated from the latest marketing audit",
        "",
        "## Essence",
        "",
        "Dependable records for energy teams.",
        "",
        "## Voice",
        "",
        "Tone: precise, warm",
        "",
        "## Visual identity",
        "",
        "Colors: #040404, #e50a13",
        "Fonts: Inter",
        "Logo: https://example.invalid/logo.png",
        "",
        "## Ideal customer",
        "",
        "Segments: ".concat("very long segment prose. ".repeat(300)),
        "",
        "## Messaging pillars",
        "",
        "- Evidence over vibes",
        "<!-- MAGISTER:GENERATED BRAND END -->",
      ].join("\n"),
    );
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    const res = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "Design a launch graphic",
    });
    const addition = res.systemPromptAddition!;
    // Visual identity is the whole point: it must survive.
    expect(addition).toContain("Colors: #040404, #e50a13");
    expect(addition).toContain("Logo: https://example.invalid/logo.png");
    // The oversized section is gone entirely, not truncated mid-sentence.
    expect(addition).not.toContain("very long segment prose.");
    expect(addition).toContain("Omitted for length: Ideal customer, Messaging pillars");
    // Every heading that survives has its body; none is cut in half.
    for (const heading of ["## Essence", "## Voice", "## Visual identity"]) {
      expect(addition).toContain(heading);
    }
  });

  it("bounds a user-authored brand guide on a line break and says it truncated", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Rule ${i}: keep it plain.`);
    await writeFile(brandPath, ["# Brand context", "", ...lines].join("\n"));
    const engine = new MagisterMemoryContextEngine({
      memoryPath,
      userPath,
      projectPath,
      brandPath,
      inner: new LegacyContextEngine(),
    });
    const res = await engine.assemble({
      sessionId: "s1",
      messages: [],
      prompt: "Write a blog post",
    });
    const addition = res.systemPromptAddition!;
    expect(addition).toContain("Rule 0: keep it plain.");
    expect(addition).toContain("Truncated. Read `BRAND.md` for the rest");
    // No half-line at the boundary.
    expect(addition).not.toMatch(/Rule \d+: keep it pl\n/);
  });
});
