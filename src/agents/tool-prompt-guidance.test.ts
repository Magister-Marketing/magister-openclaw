import { describe, expect, it } from "vitest";
import { buildEmbeddedSystemPrompt } from "./pi-embedded-runner/system-prompt.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";
import {
  appendToolPromptGuidance,
  type ToolWithSharedPromptGuidance,
} from "./tool-prompt-guidance.js";

function tool(name: string, sharedPromptGuidance?: string): ToolWithSharedPromptGuidance {
  return { name, sharedPromptGuidance } as ToolWithSharedPromptGuidance;
}

describe("shared tool prompt guidance", () => {
  it("keeps one copy in the stable prefix, including with multiple tool families", () => {
    const prompt = `Stable\n${SYSTEM_PROMPT_CACHE_BOUNDARY}\nDynamic`;
    const result = appendToolPromptGuidance(prompt, [
      tool("publish", "Approval procedure"),
      tool("send", "Approval procedure"),
      tool("repo", "Repository procedure"),
      tool("read"),
    ]);
    expect(result.match(/Approval procedure/g)).toHaveLength(1);
    expect(result).toContain("Repository procedure");
    expect(result.indexOf("Approval procedure")).toBeLessThan(
      result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY),
    );
    expect(result.split(SYSTEM_PROMPT_CACHE_BOUNDARY)[1]).toBe("\nDynamic");
    expect(appendToolPromptGuidance(result, [tool("publish", "Approval procedure")])).toBe(result);
  });

  it("keeps a prompt with no shared guidance byte-identical", () => {
    expect(appendToolPromptGuidance("Custom prompt.\n", [tool("read")])).toBe("Custom prompt.\n");
  });

  it("reflects changed guidance and filtered tools even when the base prompt is cached", () => {
    const params = {
      workspaceDir: "/tmp/shared-tool-guidance",
      reasoningTagHint: false,
      runtimeInfo: { host: "test", os: "linux", arch: "x64", node: "v22", model: "test" },
      modelAliasLines: [],
      userTimezone: "UTC",
    };
    const first = buildEmbeddedSystemPrompt({
      ...params,
      tools: [tool("publish", "Original procedure")],
    });
    const second = buildEmbeddedSystemPrompt({
      ...params,
      tools: [tool("publish", "Updated procedure")],
    });
    const filtered = buildEmbeddedSystemPrompt({ ...params, tools: [tool("read")] });
    expect(first).toContain("Original procedure");
    expect(second).toContain("Updated procedure");
    expect(second).not.toContain("Original procedure");
    expect(filtered).not.toContain("Original procedure");
    expect(filtered).not.toContain("Updated procedure");
  });
});
