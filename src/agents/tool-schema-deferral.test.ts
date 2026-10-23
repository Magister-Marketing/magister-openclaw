import type { AfterToolCallContext, AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  activateToolSchemaDeferral,
  applyConfiguredSchemaDeferral,
  applyRequestedEagerSchemas,
  parseEagerSchemaTools,
  buildDeferredToolDirectoryLines,
  collectPromotedToolNames,
  createToolDescribeTool,
  planToolSchemaDelivery,
  TOOL_DESCRIBE_TOOL_NAME,
  type ToolSchemaDeferralSession,
} from "./tool-schema-deferral.js";
import { ToolInputError, type AnyAgentTool } from "./tools/common.js";

function makeTool(name: string, extra: Partial<AnyAgentTool> = {}): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} does one thing well. It also has a second sentence.`,
    parameters: { type: "object", properties: { id: { type: "string" } } } as never,
    async execute() {
      return { content: [{ type: "text", text: name }], details: undefined };
    },
    ...extra,
  };
}

const eager = () => makeTool("magister_get_brand", { schemaDelivery: "eager" });
const deferred = () =>
  makeTool("magister_send_brief", {
    schemaDelivery: "deferred",
    sideEffect: "external_write",
    sharedPromptGuidance: "Shared permission instructions.",
  });

function assistantToolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: `call_${name}`, name, arguments: args }],
    },
  };
}

function fakeSession(registry: AnyAgentTool[]): ToolSchemaDeferralSession & {
  state: { tools: AgentTool[] };
} {
  const byName = new Map(registry.map((tool) => [tool.name, tool as AgentTool]));
  const state: { tools: AgentTool[] } = { tools: [] };
  return {
    state,
    agent: { afterToolCall: undefined, state },
    getActiveToolNames: () => state.tools.map((tool) => tool.name),
    setActiveToolsByName: (names) => {
      state.tools = names
        .map((name) => byName.get(name))
        .filter((tool): tool is AgentTool => !!tool);
    },
  };
}

function afterToolCallContext(params: {
  name: string;
  details?: unknown;
  isError?: boolean;
  tools: AgentTool[];
  args?: unknown;
}): AfterToolCallContext {
  return {
    assistantMessage: {} as never,
    toolCall: { type: "toolCall", id: "call_1", name: params.name, arguments: params.args ?? {} },
    args: params.args ?? {},
    result: { content: [{ type: "text", text: "result" }], details: params.details },
    isError: params.isError ?? false,
    context: { systemPrompt: "", messages: [], tools: params.tools },
  };
}

describe("applyConfiguredSchemaDeferral", () => {
  it("defers the named native tools and leaves everything else as it came", () => {
    const message = makeTool("message");
    const read = makeTool("read");
    const out = applyConfiguredSchemaDeferral(
      [message, read, eager(), deferred()],
      ["message", "video_generate"],
    );
    expect(out.map((tool) => [tool.name, tool.schemaDelivery])).toEqual([
      ["message", "deferred"],
      ["read", undefined],
      ["magister_get_brand", "eager"],
      ["magister_send_brief", "deferred"],
    ]);
    // Only the deferred copy is new; the untouched tools keep their identity.
    expect(out[1]).toBe(read);
    expect(message.schemaDelivery).toBeUndefined();
  });

  it("never defers tool_describe and does nothing for an empty list", () => {
    const describe = createToolDescribeTool();
    const tools = [describe, makeTool("message")];
    expect(
      applyConfiguredSchemaDeferral(tools, [TOOL_DESCRIBE_TOOL_NAME])[0].schemaDelivery,
    ).toBeUndefined();
    expect(
      applyConfiguredSchemaDeferral(tools, undefined).map((tool) => tool.schemaDelivery),
    ).toEqual([undefined, undefined]);
  });

  it("puts a config-deferred native tool in the directory with its first sentence", () => {
    const describe = createToolDescribeTool();
    const plan = planToolSchemaDelivery(
      applyConfiguredSchemaDeferral([describe, makeTool("message"), makeTool("read")], ["message"]),
    );
    expect(plan.promptTools.map((tool) => tool.name)).toEqual([TOOL_DESCRIBE_TOOL_NAME, "read"]);
    expect(buildDeferredToolDirectoryLines(plan.deferredTools)).toEqual([
      "- message: message does one thing well.",
    ]);
  });
});

describe("planToolSchemaDelivery", () => {
  it("ships every schema when tool_describe did not survive policy", () => {
    const plan = planToolSchemaDelivery([eager(), deferred()]);
    expect(plan.promptTools.map((tool) => tool.name)).toEqual([
      "magister_get_brand",
      "magister_send_brief",
    ]);
    expect(plan.deferredTools).toEqual([]);
    expect(plan.tools).toHaveLength(2);
  });

  it("drops tool_describe when nothing is deferred", () => {
    const plan = planToolSchemaDelivery([createToolDescribeTool(), eager()]);
    expect(plan.tools.map((tool) => tool.name)).toEqual(["magister_get_brand"]);
    expect(plan.promptTools.map((tool) => tool.name)).toEqual(["magister_get_brand"]);
  });

  it("keeps deferred schemas out of the prompt and binds them to tool_describe", async () => {
    const describe = createToolDescribeTool();
    // Wrappers spread tools into new objects; the catalog must survive that.
    const wrapped = { ...describe };
    const plan = planToolSchemaDelivery([wrapped, eager(), deferred()]);

    expect(plan.tools.map((tool) => tool.name)).toEqual([
      TOOL_DESCRIBE_TOOL_NAME,
      "magister_get_brand",
      "magister_send_brief",
    ]);
    expect(plan.promptTools.map((tool) => tool.name)).toEqual([
      TOOL_DESCRIBE_TOOL_NAME,
      "magister_get_brand",
    ]);
    expect(plan.deferredTools.map((tool) => tool.name)).toEqual(["magister_send_brief"]);
    expect([...plan.deferredToolNames]).toEqual(["magister_send_brief"]);

    const loaded = await wrapped.execute("call_1", { name: "magister_send_brief" });
    expect(loaded.details).toMatchObject({
      tool: "magister_send_brief",
      status: "loaded",
      side_effect: "external_write",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    });
    expect((loaded.details as { permission?: string }).permission).toContain("Permission-gated");
    expect((loaded.details as { description: string }).description).toContain(
      "does one thing well",
    );

    await expect(wrapped.execute("call_2", { name: "magister_get_brand" })).rejects.toThrow(
      ToolInputError,
    );
    await expect(wrapped.execute("call_3", { name: "magister_get_brand" })).rejects.toThrow(
      /not a deferred-schema tool.*magister_send_brief/,
    );
    await expect(wrapped.execute("call_4", {})).rejects.toThrow(/exact name/);
  });
});

describe("buildDeferredToolDirectoryLines", () => {
  it("renders sorted name/summary lines with the first sentence and a permission marker", () => {
    const lines = buildDeferredToolDirectoryLines([
      deferred(),
      makeTool("magister_create_workflow", {
        description: `Create a workflow ${"with a very long explanation ".repeat(12)}that never ends. Ignored sentence.`,
      }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^- magister_create_workflow: Create a workflow with a very long/);
    expect(lines[0]?.endsWith("...")).toBe(true);
    expect(lines[0]?.length).toBeLessThanOrEqual("- magister_create_workflow: ".length + 160);
    expect(lines[1]).toBe(
      "- magister_send_brief: magister_send_brief does one thing well. Asks the user for permission.",
    );
  });
});

describe("collectPromotedToolNames", () => {
  it("finds deferred tools this conversation already called or described", () => {
    const deferredToolNames = new Set(["magister_send_brief", "magister_create_workflow"]);
    const promoted = collectPromotedToolNames({
      deferredToolNames,
      entries: [
        { type: "message", message: { role: "user", content: "magister_send_brief please" } },
        assistantToolCall("magister_get_brand"),
        assistantToolCall(TOOL_DESCRIBE_TOOL_NAME, { name: " magister_create_workflow " }),
        assistantToolCall(TOOL_DESCRIBE_TOOL_NAME, { name: "magister_get_brand" }),
        assistantToolCall("magister_send_brief", { id: "b1" }),
        { type: "custom", customType: "x" },
        null,
      ],
    });
    expect([...promoted].toSorted()).toEqual(["magister_create_workflow", "magister_send_brief"]);
  });
});

describe("activateToolSchemaDeferral", () => {
  it("leaves the session alone when nothing is deferred", () => {
    const session = fakeSession([eager()]);
    const setActive = vi.spyOn(session, "setActiveToolsByName");
    const plan = planToolSchemaDelivery([eager()]);
    const activation = activateToolSchemaDeferral({
      session,
      plan,
      registeredToolNames: ["magister_get_brand"],
      transcriptEntries: [],
    });
    expect(activation).toEqual({
      activeToolNames: ["magister_get_brand"],
      promotedFromTranscript: [],
    });
    expect(setActive).not.toHaveBeenCalled();
    expect(session.agent.afterToolCall).toBeUndefined();
  });

  it("activates eager tools plus the ones the transcript already loaded", () => {
    const describe = createToolDescribeTool();
    const registry = [
      describe,
      eager(),
      deferred(),
      makeTool("magister_create_workflow", { schemaDelivery: "deferred" }),
    ];
    const session = fakeSession(registry);
    const plan = planToolSchemaDelivery(registry);
    const activation = activateToolSchemaDeferral({
      session,
      plan,
      registeredToolNames: registry.map((tool) => tool.name),
      transcriptEntries: [assistantToolCall("magister_create_workflow")],
    });
    expect(activation.promotedFromTranscript).toEqual(["magister_create_workflow"]);
    expect(activation.activeToolNames).toEqual([
      TOOL_DESCRIBE_TOOL_NAME,
      "magister_get_brand",
      "magister_create_workflow",
    ]);
    expect(session.getActiveToolNames()).toEqual(activation.activeToolNames);
    expect(typeof session.agent.afterToolCall).toBe("function");
  });

  it("promotes a described tool into the live turn and the session, after the prior hook", async () => {
    const describe = createToolDescribeTool();
    const registry = [describe, eager(), deferred()];
    const session = fakeSession(registry);
    const prior = vi.fn(async () => undefined);
    session.agent.afterToolCall = prior;
    const plan = planToolSchemaDelivery(registry);
    activateToolSchemaDeferral({
      session,
      plan,
      registeredToolNames: registry.map((tool) => tool.name),
      transcriptEntries: [],
    });
    const liveTools = [...session.state.tools];
    expect(liveTools.map((tool) => tool.name)).toEqual([
      TOOL_DESCRIBE_TOOL_NAME,
      "magister_get_brand",
    ]);

    const ctx = afterToolCallContext({
      name: TOOL_DESCRIBE_TOOL_NAME,
      details: { tool: "magister_send_brief", status: "loaded" },
      tools: liveTools,
    });
    const override = await session.agent.afterToolCall?.(ctx);

    expect(override).toBeUndefined();
    expect(prior).toHaveBeenCalledWith(ctx, undefined);
    expect(liveTools.map((tool) => tool.name)).toContain("magister_send_brief");
    expect(session.getActiveToolNames()).toContain("magister_send_brief");
    // Idempotent: a second describe adds nothing twice.
    await session.agent.afterToolCall?.(ctx);
    expect(liveTools.filter((tool) => tool.name === "magister_send_brief")).toHaveLength(1);
  });

  it("turns a direct call to an unloaded deferred tool into a promotion and a retry", async () => {
    const describe = createToolDescribeTool();
    const registry = [describe, eager(), deferred()];
    const session = fakeSession(registry);
    const plan = planToolSchemaDelivery(registry);
    activateToolSchemaDeferral({
      session,
      plan,
      registeredToolNames: registry.map((tool) => tool.name),
      transcriptEntries: [],
    });
    const liveTools = [...session.state.tools];

    const override = await session.agent.afterToolCall?.(
      afterToolCallContext({ name: "magister_send_brief", isError: true, tools: liveTools }),
    );

    expect(override?.isError).toBe(true);
    expect(override?.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("call magister_send_brief again with the same arguments"),
    });
    expect(liveTools.map((tool) => tool.name)).toContain("magister_send_brief");

    // An error from a tool that is already live is somebody else's error.
    const unrelated = await session.agent.afterToolCall?.(
      afterToolCallContext({ name: "magister_get_brand", isError: true, tools: liveTools }),
    );
    expect(unrelated).toBeUndefined();
  });

  it("ignores failed describes and describes of names that are not deferred", async () => {
    const describe = createToolDescribeTool();
    const registry = [describe, eager(), deferred()];
    const session = fakeSession(registry);
    activateToolSchemaDeferral({
      session,
      plan: planToolSchemaDelivery(registry),
      registeredToolNames: registry.map((tool) => tool.name),
      transcriptEntries: [],
    });
    const liveTools = [...session.state.tools];
    await session.agent.afterToolCall?.(
      afterToolCallContext({
        name: TOOL_DESCRIBE_TOOL_NAME,
        isError: true,
        details: { tool: "magister_send_brief", status: "loaded" },
        tools: liveTools,
      }),
    );
    await session.agent.afterToolCall?.(
      afterToolCallContext({
        name: TOOL_DESCRIBE_TOOL_NAME,
        details: { tool: "magister_get_brand", status: "loaded" },
        tools: liveTools,
      }),
    );
    expect(liveTools.map((tool) => tool.name)).toEqual([
      TOOL_DESCRIBE_TOOL_NAME,
      "magister_get_brand",
    ]);
  });
});

describe("requested eager schemas (x-magister-eager-schemas)", () => {
  it("parses a bounded, unique list of valid tool names and never tool_describe", () => {
    expect(parseEagerSchemaTools(undefined)).toEqual([]);
    expect(parseEagerSchemaTools("  ")).toEqual([]);
    expect(
      parseEagerSchemaTools(
        " magister_create_social_draft, magister_publish_social_post ,magister_create_social_draft, tool_describe, Bad-Name, ",
      ),
    ).toEqual(["magister_create_social_draft", "magister_publish_social_post"]);
    const many = Array.from({ length: 40 }, (_, i) => `tool_${i}`).join(",");
    expect(parseEagerSchemaTools(many)).toHaveLength(32);
  });

  it("makes exactly the named deferred tools eager and leaves the rest alone", () => {
    const tools = [
      eager(),
      deferred(),
      makeTool("magister_send_email", { schemaDelivery: "deferred" }),
    ];
    const applied = applyRequestedEagerSchemas(tools, ["magister_send_brief", "unknown_tool"]);
    expect(applied.map((tool) => [tool.name, tool.schemaDelivery])).toEqual([
      ["magister_get_brand", "eager"],
      ["magister_send_brief", "eager"],
      ["magister_send_email", "deferred"],
    ]);
    // The input tools are not mutated and an empty request changes nothing.
    expect(tools[1].schemaDelivery).toBe("deferred");
    expect(applyRequestedEagerSchemas(tools, [])).toEqual(tools);
    expect(applyRequestedEagerSchemas(tools, undefined)).toEqual(tools);
  });

  it("wins over the image config for the tools it names, and only those", () => {
    const configured = applyConfiguredSchemaDeferral(
      [makeTool("message"), makeTool("image_generate"), eager()],
      ["message", "image_generate"],
    );
    const plan = planToolSchemaDelivery([
      ...applyRequestedEagerSchemas(configured, ["message"]),
      createToolDescribeTool(),
    ]);
    expect(plan.promptTools.map((tool) => tool.name)).toEqual([
      "message",
      "magister_get_brand",
      TOOL_DESCRIBE_TOOL_NAME,
    ]);
    expect([...plan.deferredToolNames]).toEqual(["image_generate"]);
  });
});
