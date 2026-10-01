import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import type { SkillEntry } from "./skills/types.js";
import {
  resolveSkillsCatalogForRun,
  resolveSkillsPromptForRun,
  SKILL_INDEX_RELATIVE_PATH,
} from "./skills/workspace.js";

describe("resolveSkillsPromptForRun", () => {
  it("carries no catalog: the legacy snapshot prompt is never rendered", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("");
  });
  it("renders nothing for entries without preloaded skills", () => {
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
      }),
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
      runtimeChannel: "webchat",
    });
    expect(prompt).toBe("");
  });

  it("preloads the full skill body only on configured runtime channels", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "skill-preload-"));
    const skillDir = join(workspaceDir, "skills", "channel-contract");
    const filePath = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: channel-contract",
        "description: Render interactive channel controls",
        'metadata: {"openclaw":{"preloadChannels":["webchat"]}}',
        "---",
        "",
        "# Channel contract",
        "",
        "PRELOADED_BODY_MARKER",
      ].join("\n"),
      "utf8",
    );
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "channel-contract",
        description: "Render interactive channel controls",
        filePath,
        baseDir: skillDir,
        source: "openclaw-workspace",
      }),
      frontmatter: {},
      metadata: { preloadChannels: ["webchat"] },
    };

    try {
      const webchatPrompt = resolveSkillsPromptForRun({
        entries: [entry],
        workspaceDir,
        runtimeChannel: "webchat",
      });
      const slackPrompt = resolveSkillsPromptForRun({
        entries: [entry],
        workspaceDir,
        runtimeChannel: "slack",
      });

      expect(webchatPrompt).toContain("<preloaded_skills>");
      expect(webchatPrompt).toContain('name="channel-contract"');
      expect(webchatPrompt).toContain("PRELOADED_BODY_MARKER");
      expect(webchatPrompt).not.toContain("preloadChannels");
      expect(slackPrompt).not.toContain("<preloaded_skills>");
      expect(slackPrompt).not.toContain("PRELOADED_BODY_MARKER");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("lists every skill with its description in the catalog and writes the on-demand index", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "skill-catalog-"));
    const seo = createFixtureSkill({
      name: "seo-audit",
      description: "Audit technical SEO, keywords, and search performance",
      filePath: "/app/skills/seo-audit/SKILL.md",
      baseDir: "/app/skills/seo-audit",
      source: "openclaw-workspace",
    });
    const gmail = createFixtureSkill({
      name: "magister-gmail",
      description: "Read and send Gmail messages",
      filePath: "/app/skills/magister-gmail/SKILL.md",
      baseDir: "/app/skills/magister-gmail",
      source: "openclaw-workspace",
    });
    try {
      const catalog = resolveSkillsCatalogForRun({
        skillsSnapshot: { prompt: "legacy 90k prompt", skills: [], resolvedSkills: [gmail, seo] },
        workspaceDir,
      });

      // No keyword shortlist: the model sees every skill, whatever the task.
      expect(catalog).toContain("Audit technical SEO");
      expect(catalog).toContain("Read and send Gmail messages");
      expect(catalog).not.toContain("legacy 90k prompt");

      const index = readFileSync(join(workspaceDir, SKILL_INDEX_RELATIVE_PATH), "utf8");
      expect(index).toContain("`seo-audit`");
      expect(index).toContain("`magister-gmail`");
      expect(index).toContain("Audit technical SEO, keywords, and search performance");
      expect(index).toContain("Read and send Gmail messages");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps legacy entries with disableModelInvocation hidden when exposure metadata is absent", () => {
    const hidden: SkillEntry = {
      skill: createFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
        disableModelInvocation: true,
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsCatalogForRun({
      entries: [hidden],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("inherits agents.defaults.skills when rebuilding prompt for an agent", () => {
    const visible: SkillEntry = {
      skill: createFixtureSkill({
        name: "github",
        description: "GitHub",
        filePath: "/app/skills/github/SKILL.md",
        baseDir: "/app/skills/github",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const hidden: SkillEntry = {
      skill: createFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsCatalogForRun({
      entries: [visible, hidden],
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).toContain("/app/skills/github/SKILL.md");
    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("uses agents.list[].skills as a full replacement for defaults", () => {
    const inheritedEntry: SkillEntry = {
      skill: createFixtureSkill({
        name: "weather",
        description: "Weather",
        filePath: "/app/skills/weather/SKILL.md",
        baseDir: "/app/skills/weather",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const explicitEntry: SkillEntry = {
      skill: createFixtureSkill({
        name: "docs-search",
        description: "Docs",
        filePath: "/app/skills/docs-search/SKILL.md",
        baseDir: "/app/skills/docs-search",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsCatalogForRun({
      entries: [inheritedEntry, explicitEntry],
      config: {
        agents: {
          defaults: {
            skills: ["weather"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).not.toContain("/app/skills/weather/SKILL.md");
    expect(prompt).toContain("/app/skills/docs-search/SKILL.md");
  });
});

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation?: boolean;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}
