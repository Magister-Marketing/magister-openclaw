import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { toGeminiToolDeclarations } from "./tools.js";

describe("realtime tool declarations", () => {
  it("preserves shared instructions through schema normalization", () => {
    const tool = {
      name: "publish",
      description: "Publish content.",
      sharedPromptGuidance: "Shared approval instructions.",
      parameters: { type: "object", properties: {} },
    } as AnyAgentTool;
    const [declaration] = toGeminiToolDeclarations([tool]);
    expect(declaration.description).toBe("Publish content.\n\nShared approval instructions.");
    expect(declaration.parameters).toEqual(tool.parameters);
  });
});
