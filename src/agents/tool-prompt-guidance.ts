import type { AgentTool } from "@mariozechner/pi-agent-core";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

export type ToolWithSharedPromptGuidance = AgentTool & { sharedPromptGuidance?: string };

/** MCP clients receive descriptions, not the embedded system prompt. */
export function toolDescriptionWithSharedGuidance(tool: {
  description?: string;
  sharedPromptGuidance?: string;
}): string | undefined {
  return tool.sharedPromptGuidance
    ? `${tool.description ?? ""}\n\n${tool.sharedPromptGuidance}`
    : tool.description;
}

/**
 * Apply after the base prompt cache: changing a tool's guidance must change
 * the rendered prefix even when the names and base prompt are unchanged.
 * Only effective (policy-filtered) tools contribute instructions.
 */
export function appendToolPromptGuidance(
  systemPrompt: string,
  tools: readonly ToolWithSharedPromptGuidance[],
): string {
  const guidance = [
    ...new Set(tools.map((tool) => tool.sharedPromptGuidance?.trim()).filter(Boolean)),
  ].filter((text) => text && !systemPrompt.includes(text));
  if (!guidance.length) {
    return systemPrompt;
  }
  const section = guidance.join("\n\n");
  const boundary = systemPrompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  if (boundary < 0) {
    return `${systemPrompt}\n\n${section}`;
  }
  return `${systemPrompt.slice(0, boundary).trimEnd()}\n\n${section}\n\n${systemPrompt.slice(boundary)}`;
}
