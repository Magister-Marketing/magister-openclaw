import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalCorpusJson,
  putCorpusReadCache,
  recordFetchedCorpusSource,
} from "./corpus-index.js";
import {
  actionTimeoutMs,
  createContextualMagisterActionTool,
  createMagisterActionTool,
  holdForApprovalDecision,
  magisterStandaloneToolNames,
  nativeActionContract,
  parseActionEnvelope,
} from "./index.js";

const dir = dirname(fileURLToPath(import.meta.url));
const action = nativeActionContract.actions.find((row) => row.action === "get_brand");
if (!action) {
  throw new Error("get_brand contract missing");
}
const writeAction = nativeActionContract.actions.find((row) => row.action === "send_email");
if (!writeAction) {
  throw new Error("send_email contract missing");
}
const socialDraftAction = nativeActionContract.actions.find(
  (row) => row.action === "create_social_draft",
);
if (!socialDraftAction) {
  throw new Error("create_social_draft contract missing");
}
const completionAction = nativeActionContract.actions.find(
  (row) => row.action === "submit_workflow_completion",
);
if (!completionAction) {
  throw new Error("submit_workflow_completion contract missing");
}
const integrationsAction = nativeActionContract.actions.find(
  (row) => row.action === "list_integrations",
);
if (!integrationsAction) {
  throw new Error("list_integrations contract missing");
}
const temporaryDirectories: string[] = [];

function api(config: Record<string, unknown> = {}) {
  return { pluginConfig: config } as unknown as Parameters<typeof createMagisterActionTool>[0];
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    operation_id: "op_12345678",
    resource_id: null,
    status: {
      state: "succeeded",
      terminal: true,
      poll_after_seconds: 0,
      stale_seconds: 0,
    },
    side_effect: "none",
    idempotency_key: null,
    receipt: { brand: null },
    artifacts: [],
    error: null,
    ...overrides,
  };
}

function resultJson(
  result: Awaited<ReturnType<ReturnType<typeof createMagisterActionTool>["execute"]>>,
) {
  const content = result.content?.[0] as { type: string; text: string } | undefined;
  return JSON.parse(content?.text ?? "null") as Record<string, unknown>;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected a string request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GATEWAY_TOKEN;
  delete process.env.GATEWAY_INTERNAL_URL;
  delete process.env.MAGISTER_BROKER_BASE_URL;
  delete process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_WORKSPACE_DIR;
  delete process.env.FLY_APP_NAME;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Magister action manifest contract", () => {
  it("declares every registered tool exactly once", () => {
    const manifest = JSON.parse(readFileSync(join(dir, "openclaw.plugin.json"), "utf8")) as {
      contracts: { tools: string[] };
    };
    const tools = [
      ...magisterStandaloneToolNames,
      ...nativeActionContract.actions.map((row) => row.tool_name),
    ];
    expect(new Set(tools).size).toBe(tools.length);
    expect(manifest.contracts.tools).toEqual(tools);
  });

  it("uses strict schemas and never exposes project_id", () => {
    for (const row of nativeActionContract.actions) {
      expect(row.input_schema.additionalProperties).toBe(false);
      const properties = new Set(Object.keys(row.input_schema.properties ?? {}));
      const requiredFields = (row.input_schema.required ?? []) as string[];
      for (const required of requiredFields) {
        expect(properties.has(required)).toBe(true);
      }
      expect(JSON.stringify(row.input_schema)).not.toContain("project_id");
    }
  });

  it("routes exact inline permissions through the trusted server-owned card", () => {
    const tool = createMagisterActionTool(api(), writeAction, async () => {
      throw new Error("not called");
    });

    expect(tool.description).toContain('receipt.approval_presentation is "inline_web"');
    expect(tool.description).toContain("do not print receipt.approval_url");
    expect(tool.description).toContain('receipt.approval_presentation is "slack_card_scheduled"');
    expect(tool.description).toContain("never call message(action=send)");
    expect(tool.description).toContain('receipt.approval_presentation is "link_only"');
    expect(tool.description).toContain("show receipt.approval_url once");
    expect(tool.description).toContain("when the runtime holds this call open");
    expect(tool.description).toContain(
      "never re-request a denied action or pursue its outcome through another tool",
    );
    expect(tool.sideEffect).toBe("external_write");
  });
});

describe("typed gateway execution", () => {
  it("sends the machine token only to the fixed internal action endpoint", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    let request: { input: string; init?: RequestInit } | undefined;
    const tool = createMagisterActionTool(api(), action, async (input, init) => {
      request = { input: requestUrl(input), init };
      return new Response(JSON.stringify(envelope()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const output = resultJson(await tool.execute("call-1", {}));
    expect(output.ok).toBe(true);
    expect(request?.input).toBe(
      "http://magister-gateway.internal:8081/api/agent/actions/get_brand",
    );
    expect(request?.init?.headers).toMatchObject({
      authorization: "Bearer secret-machine-token",
    });
    expect(requestBody(request?.init)).toEqual({ arguments: {} });
  });

  it("forwards trusted workflow context without exposing it in tool arguments", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    let request: { init?: RequestInit } | undefined;
    const tool = createMagisterActionTool(
      api(),
      action,
      async (_input, init) => {
        request = { init };
        return new Response(JSON.stringify(envelope()), { status: 200 });
      },
      { sessionKey: "workflow_run:00000000-0000-4000-8000-000000000001" },
    );

    await tool.execute("call-workflow", {});
    expect(request?.init?.headers).toMatchObject({
      "x-magister-session-key": "workflow_run:00000000-0000-4000-8000-000000000001",
    });
    expect(requestBody(request?.init)).toEqual({ arguments: {} });
  });

  it("forwards only canonical web chat session keys", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    let request: { init?: RequestInit } | undefined;
    const tool = createMagisterActionTool(
      api(),
      action,
      async (_input, init) => {
        request = { init };
        return new Response(JSON.stringify(envelope()), { status: 200 });
      },
      {
        sessionKey: "agent:main:webchat:00000000-0000-4000-8000-000000000001",
        sessionId: "11111111-1111-4111-8111-111111111111",
      },
    );

    await tool.execute("call-chat", {});
    expect(request?.init?.headers).toMatchObject({
      "x-magister-session-key": "agent:main:webchat:00000000-0000-4000-8000-000000000001",
      "x-magister-session-id": "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not forward a malformed web chat session key", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    let request: { init?: RequestInit } | undefined;
    const tool = createMagisterActionTool(
      api(),
      action,
      async (_input, init) => {
        request = { init };
        return new Response(JSON.stringify(envelope()), { status: 200 });
      },
      { sessionKey: "agent:main:webchat:session-1" },
    );

    await tool.execute("call-malformed-chat", {});
    expect(request?.init?.headers).not.toHaveProperty("x-magister-session-key");
    expect(request?.init?.headers).not.toHaveProperty("x-magister-session-id");
  });

  it("forwards a trusted Slack thread session outside tool arguments", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    let request: { init?: RequestInit } | undefined;
    const sessionKey = "agent:main:slack:channel:c123:thread:1784596943.935399";
    const tool = createMagisterActionTool(
      api(),
      action,
      async (_input, init) => {
        request = { init };
        return new Response(JSON.stringify(envelope()), { status: 200 });
      },
      { sessionKey },
    );

    await tool.execute("call-slack", {});
    expect(request?.init?.headers).toMatchObject({ "x-magister-session-key": sessionKey });
    expect(requestBody(request?.init)).toEqual({ arguments: {} });
  });

  it("does not forward a malformed Slack session key", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    let request: { init?: RequestInit } | undefined;
    const tool = createMagisterActionTool(
      api(),
      action,
      async (_input, init) => {
        request = { init };
        return new Response(JSON.stringify(envelope()), { status: 200 });
      },
      { sessionKey: "agent:main:slack:channel:c123:thread:not-a-timestamp" },
    );

    await tool.execute("call-malformed-slack", {});
    expect(request?.init?.headers).not.toHaveProperty("x-magister-session-key");
  });

  it("fails closed without a machine token", async () => {
    const tool = createMagisterActionTool(api(), action, async () => {
      throw new Error("fetch must not run");
    });
    const output = resultJson(await tool.execute("call-2", {}));
    expect(output.ok).toBe(false);
    expect((output.error as { code: string }).code).toBe("transport_unavailable");
  });

  it("uses the fixed local broker without exposing a gateway credential", async () => {
    process.env.MAGISTER_BROKER_BASE_URL = "http://127.0.0.1:18796";
    let request: { input: string; init?: RequestInit } | undefined;
    const tool = createMagisterActionTool(api(), action, async (input, init) => {
      request = { input: requestUrl(input), init };
      return new Response(JSON.stringify(envelope()), { status: 200 });
    });

    const output = resultJson(await tool.execute("call-broker", {}));

    expect(output.ok).toBe(true);
    expect(request?.input).toBe("http://127.0.0.1:18796/api/agent/actions/get_brand");
    expect(request?.init?.headers).toMatchObject({ authorization: "Bearer broker-local" });
  });

  it.each([
    ["image", "exact.jpg", "image/jpeg", Buffer.from("exact-jpeg-bytes")],
    ["video", "exact.mp4", "video/mp4", Buffer.from("exact-mp4-bytes")],
  ])(
    "uploads exact local %s bytes before creating a social draft",
    async (_kind, filename, expectedContentType, exactBytes) => {
      process.env.GATEWAY_TOKEN = "secret-machine-token";
      const workspace = await mkdtemp(join(tmpdir(), "magister-social-media-"));
      try {
        await mkdir(join(workspace, "resources"));
        const localPath = join(workspace, "resources", filename);
        await writeFile(localPath, exactBytes);
        const publicUrl = `https://media.zernio.com/${filename}`;
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const tool = createMagisterActionTool(
          api({ workspaceDir: workspace }),
          socialDraftAction,
          async (input, init) => {
            const url = requestUrl(input);
            calls.push({ url, init });
            if (
              url ===
              "http://magister-gateway.internal:8081/api/agent/actions/social_media_upload_ticket"
            ) {
              const ticketRequest = requestBody(init);
              expect(ticketRequest.content_type).toBe(expectedContentType);
              expect(ticketRequest.account_ids).toEqual(["account-1"]);
              expect(ticketRequest.filename).toMatch(
                new RegExp(`^[a-f0-9]{64}\\.${filename.split(".").at(-1)}$`),
              );
              return new Response(
                JSON.stringify({
                  uploadUrl: "https://uploads.example/exact-signed-target",
                  publicUrl,
                }),
                { status: 200 },
              );
            }
            if (url === "https://uploads.example/exact-signed-target") {
              const headers = new Headers(init?.headers);
              expect(headers.get("authorization")).toBeNull();
              expect(headers.get("content-type")).toBe(expectedContentType);
              expect(Buffer.isBuffer(init?.body)).toBe(true);
              expect(Buffer.from(init?.body as Buffer)).toEqual(exactBytes);
              return new Response(null, { status: 200 });
            }
            expect(url).toBe(
              "http://magister-gateway.internal:8081/api/agent/actions/create_social_draft",
            );
            expect(requestBody(init)).toMatchObject({
              arguments: { media_urls: [publicUrl] },
            });
            return new Response(
              JSON.stringify(envelope({ side_effect: "draft", receipt: { post_id: "post-1" } })),
              { status: 200 },
            );
          },
        );

        const output = resultJson(
          await tool.execute("social-local-media", {
            content: "Exact media",
            platforms: [{ platform: "instagram", account_id: "account-1" }],
            media_urls: [localPath],
            idempotency_key: "social-local-media-1",
          }),
        );

        expect(output.ok).toBe(true);
        expect(calls.map((call) => call.url)).toEqual([
          "http://magister-gateway.internal:8081/api/agent/actions/social_media_upload_ticket",
          "https://uploads.example/exact-signed-target",
          "http://magister-gateway.internal:8081/api/agent/actions/create_social_draft",
        ]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("rejects local social media that escapes generated media and resources", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    const workspace = await mkdtemp(join(tmpdir(), "magister-social-escape-"));
    try {
      await mkdir(join(workspace, "resources"));
      const outside = join(workspace, "outside.jpg");
      await writeFile(outside, "not approved local media");
      let fetched = false;
      const tool = createMagisterActionTool(
        api({ workspaceDir: workspace }),
        socialDraftAction,
        async () => {
          fetched = true;
          return new Response(JSON.stringify(envelope()), { status: 200 });
        },
      );

      const output = resultJson(
        await tool.execute("social-media-escape", {
          content: "No escape",
          platforms: [{ platform: "instagram", account_id: "account-1" }],
          media_urls: [outside],
          idempotency_key: "social-media-escape-1",
        }),
      );

      expect(output.ok).toBe(false);
      expect((output.error as { code: string }).code).toBe("validation_error");
      expect((output.error as { message: string }).message).toContain("generated media");
      expect(fetched).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uploads exact local media through the enforced credential broker", async () => {
    process.env.MAGISTER_BROKER_BASE_URL = "http://127.0.0.1:18796";
    const workspace = await mkdtemp(join(tmpdir(), "magister-social-broker-"));
    try {
      await mkdir(join(workspace, "resources"));
      const localPath = join(workspace, "resources", "brokered.png");
      const exactBytes = Buffer.from("exact-brokered-png-bytes");
      await writeFile(localPath, exactBytes);
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const tool = createMagisterActionTool(
        api({ workspaceDir: workspace }),
        socialDraftAction,
        async (input, init) => {
          const url = requestUrl(input);
          calls.push({ url, init });
          if (url.endsWith("/social_media_upload_ticket")) {
            expect(init?.headers).toMatchObject({ authorization: "Bearer broker-local" });
            return new Response(
              JSON.stringify({
                uploadUrl: "https://uploads.example/brokered-signed-target",
                publicUrl: "https://media.zernio.com/brokered.png",
              }),
              { status: 200 },
            );
          }
          if (url === "https://uploads.example/brokered-signed-target") {
            expect(new Headers(init?.headers).get("authorization")).toBeNull();
            expect(Buffer.from(init?.body as Buffer)).toEqual(exactBytes);
            return new Response(null, { status: 200 });
          }
          expect(init?.headers).toMatchObject({ authorization: "Bearer broker-local" });
          expect(requestBody(init)).toMatchObject({
            arguments: { media_urls: ["https://media.zernio.com/brokered.png"] },
          });
          return new Response(JSON.stringify(envelope({ side_effect: "draft" })), {
            status: 200,
          });
        },
      );

      const output = resultJson(
        await tool.execute("social-brokered-media", {
          content: "Exact brokered media",
          platforms: [{ platform: "instagram", account_id: "account-1" }],
          media_urls: [localPath],
          idempotency_key: "social-brokered-media-1",
        }),
      );

      expect(output.ok).toBe(true);
      expect(calls.map((call) => call.url)).toEqual([
        "http://127.0.0.1:18796/api/agent/actions/social_media_upload_ticket",
        "https://uploads.example/brokered-signed-target",
        "http://127.0.0.1:18796/api/agent/actions/create_social_draft",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reuses only freshness-valid cached integration reads", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const workspace = mkdtempSync(join(tmpdir(), "magister-read-cache-"));
    temporaryDirectories.push(workspace);
    process.env.OPENCLAW_WORKSPACE_DIR = workspace;
    process.env.FLY_APP_NAME = "project-app-1";
    let fetches = 0;
    const tool = createMagisterActionTool(api(), integrationsAction, async () => {
      fetches += 1;
      return new Response(
        JSON.stringify(envelope({ receipt: { integrations: [{ service: "ga4" }] } })),
        { status: 200 },
      );
    });

    const first = resultJson(await tool.execute("call-cache-1", {}));
    const second = resultJson(await tool.execute("call-cache-2", {}));

    expect(fetches).toBe(1);
    expect((first.receipt as Record<string, unknown>).cache_freshness).toMatchObject({
      cached: false,
    });
    expect((second.receipt as Record<string, unknown>).cache_freshness).toMatchObject({
      cached: true,
    });
  });

  it("never caches a non-terminal read result", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const workspace = mkdtempSync(join(tmpdir(), "magister-running-cache-"));
    temporaryDirectories.push(workspace);
    process.env.OPENCLAW_WORKSPACE_DIR = workspace;
    process.env.FLY_APP_NAME = "project-app-running";
    let fetches = 0;
    const tool = createMagisterActionTool(api(), integrationsAction, async () => {
      fetches += 1;
      return new Response(
        JSON.stringify(
          fetches === 1
            ? envelope({
                status: {
                  state: "running",
                  terminal: false,
                  poll_after_seconds: 3,
                  stale_seconds: 0,
                },
                receipt: { stage: "running" },
              })
            : envelope({ receipt: { integrations: [{ service: "ga4" }] } }),
        ),
        { status: 200 },
      );
    });

    const running = resultJson(await tool.execute("call-running-1", {}));
    const terminal = resultJson(await tool.execute("call-running-2", {}));
    const cached = resultJson(await tool.execute("call-running-3", {}));

    expect(fetches).toBe(2);
    expect((running.receipt as Record<string, unknown>).cache_freshness).toBeUndefined();
    expect((terminal.receipt as Record<string, unknown>).cache_freshness).toMatchObject({
      cached: false,
    });
    expect((cached.receipt as Record<string, unknown>).cache_freshness).toMatchObject({
      cached: true,
    });
  });

  it("ignores a non-terminal envelope written by an older cache policy", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const workspace = mkdtempSync(join(tmpdir(), "magister-legacy-running-cache-"));
    temporaryDirectories.push(workspace);
    process.env.OPENCLAW_WORKSPACE_DIR = workspace;
    process.env.FLY_APP_NAME = "project-app-legacy-running";
    const inputHash = createHash("sha256").update(canonicalCorpusJson({})).digest("hex");
    const fetchedAt = Date.now();
    const source = recordFetchedCorpusSource({
      workspace,
      projectScope: "project-app-legacy-running",
      url: `magister-action:list_integrations:${inputHash}`,
      contentHash: "a".repeat(64),
      provenance: "integration_discovery",
      fetchedAt,
      freshnessTtlSeconds: 300,
    });
    putCorpusReadCache(
      workspace,
      {
        projectScope: "project-app-legacy-running",
        inputHash,
        sourceRevision: source.sourceRevision,
        fetchedAt,
        freshnessTtlSeconds: 300,
      },
      envelope({
        status: {
          state: "running",
          terminal: false,
          poll_after_seconds: 3,
          stale_seconds: 0,
        },
        receipt: { stage: "stale-running" },
      }),
    );
    let fetches = 0;
    const tool = createMagisterActionTool(api(), integrationsAction, async () => {
      fetches += 1;
      return new Response(JSON.stringify(envelope({ receipt: { integrations: [] } })), {
        status: 200,
      });
    });

    const result = resultJson(await tool.execute("call-legacy-running", {}));

    expect(fetches).toBe(1);
    expect((result.receipt as Record<string, unknown>).cache_freshness).toMatchObject({
      cached: false,
    });
  });

  it("exposes workflow-only tools only in their trusted runtime contexts", () => {
    expect(
      createContextualMagisterActionTool(api(), completionAction, fetch, {
        sessionKey: "agent:main:webchat:session-1",
      }),
    ).toBeNull();
    expect(
      createContextualMagisterActionTool(api(), completionAction, fetch, {
        sessionKey: "workflow_run:00000000-0000-4000-8000-000000000001",
      }),
    ).not.toBeNull();
  });

  it("gives artifact promotion an outer timeout above the broker budget", () => {
    expect(actionTimeoutMs("get_brand", 45_000)).toBe(45_000);
    expect(actionTimeoutMs("promote_artifact", 45_000)).toBe(90_000);
    expect(actionTimeoutMs("promote_artifact", 120_000)).toBe(120_000);
    expect(actionTimeoutMs("create_social_draft", 45_000)).toBe(300_000);
    expect(actionTimeoutMs("create_social_draft", 360_000)).toBe(360_000);
  });

  it("rejects a raw legacy result instead of inferring success", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const tool = createMagisterActionTool(
      api(),
      action,
      async () => new Response(JSON.stringify({ brand: { voice: "warm" } }), { status: 200 }),
    );
    const output = resultJson(await tool.execute("call-3", {}));
    expect(output.ok).toBe(false);
    expect((output.error as { code: string }).code).toBe("transport_unavailable");
  });

  it("rejects an operator-configured non-internal endpoint before fetch", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const tool = createMagisterActionTool(
      api({ endpoint: "https://attacker.example/api/agent/actions" }),
      action,
      async () => {
        throw new Error("fetch must not run");
      },
    );
    const output = resultJson(await tool.execute("call-4", {}));
    expect(output.ok).toBe(false);
    expect((output.error as { code: string }).code).toBe("transport_unavailable");
  });

  it("bounds gateway response bytes", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const tool = createMagisterActionTool(
      api({ maxResponseBytes: 1024 }),
      action,
      async () => new Response("x".repeat(1025), { status: 200 }),
    );
    const output = resultJson(await tool.execute("call-5", {}));
    expect(output.ok).toBe(false);
    expect((output.error as { message: string }).message).toContain("size limit");
  });

  it("retries read-only 5xx responses but never blindly retries a write", async () => {
    process.env.GATEWAY_TOKEN = "token";
    const readTool = createMagisterActionTool(
      api(),
      action,
      async () => new Response("unavailable", { status: 503 }),
    );
    const writeTool = createMagisterActionTool(
      api(),
      writeAction,
      async () => new Response("unavailable", { status: 503 }),
    );

    const read = resultJson(await readTool.execute("read-503", {}));
    const write = resultJson(await writeTool.execute("write-503", {}));

    expect((read.error as { retryable: boolean }).retryable).toBe(true);
    expect((read.error as { retry_after_seconds: number | null }).retry_after_seconds).toBeNull();
    expect((write.error as { retryable: boolean }).retryable).toBe(false);
    expect((write.error as { user_action: string }).user_action).toContain("Read back");
  });

  it("verifies and attests completion artifacts from the workspace", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    const workspace = await mkdtemp(join(tmpdir(), "magister-actions-"));
    try {
      await mkdir(join(workspace, "resources"));
      const content = "verified report line with real analysis in it\n".repeat(16);
      await writeFile(join(workspace, "resources", "report.md"), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const sessionKey = "workflow_run:00000000-0000-4000-8000-000000000001";
      let request: { init?: RequestInit } | undefined;
      const tool = createMagisterActionTool(
        api({ workspaceDir: workspace }),
        completionAction,
        async (_input, init) => {
          request = { init };
          return new Response(JSON.stringify(envelope()), { status: 200 });
        },
        { sessionKey },
      );
      const argumentsPayload = {
        version: 1,
        idempotency_key: "plan-task-key-1",
        verification: [
          {
            requirement: "The report exists.",
            status: "passed",
            evidence_refs: [`artifact:${sha256}`],
          },
        ],
        artifacts: [{ path: "resources/report.md", sha256, kind: "file" }],
        blocker: null,
        finding_headline: "Report completed",
        key_metrics: {},
      };

      const output = resultJson(await tool.execute("completion-1", argumentsPayload));

      expect(output.ok).toBe(true);
      expect(requestBody(request?.init)).toEqual({ arguments: argumentsPayload });
      const manifest = [["resources/report.md", sha256, "file"]];
      const expected = createHmac("sha256", "secret-machine-token")
        .update(`${sessionKey}\n${JSON.stringify(manifest)}`)
        .digest("hex");
      expect(request?.init?.headers).toMatchObject({
        "x-magister-artifact-attestation": `v1=${expected}`,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("leaves completion attestation to the credential broker", async () => {
    process.env.MAGISTER_BROKER_BASE_URL = "http://127.0.0.1:18796";
    const workspace = await mkdtemp(join(tmpdir(), "magister-actions-broker-"));
    try {
      await mkdir(join(workspace, "resources"));
      const content = "brokered report line with real analysis in it\n".repeat(16);
      await writeFile(join(workspace, "resources", "report.md"), content);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const sessionKey = "workflow_run:00000000-0000-4000-8000-000000000001";
      let request: { init?: RequestInit } | undefined;
      const tool = createMagisterActionTool(
        api({ workspaceDir: workspace }),
        completionAction,
        async (_input, init) => {
          request = { init };
          return new Response(JSON.stringify(envelope()), { status: 200 });
        },
        { sessionKey },
      );
      const artifacts = [{ path: "resources/report.md", sha256, kind: "file" }];

      const output = resultJson(await tool.execute("completion-broker", { artifacts }));

      expect(output.ok).toBe(true);
      expect(requestBody(request?.init)).toEqual({ arguments: { artifacts } });
      expect(request?.init?.headers).toMatchObject({
        authorization: "Bearer broker-local",
        "x-magister-session-key": sessionKey,
      });
      expect(request?.init?.headers).not.toHaveProperty("x-magister-artifact-attestation");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("computes and attests the hash itself when sha256 is omitted", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    const workspace = await mkdtemp(join(tmpdir(), "magister-actions-"));
    try {
      await mkdir(join(workspace, "resources"));
      const content = "auto-hashed report line with real analysis in it\n".repeat(16);
      await writeFile(join(workspace, "resources", "report.md"), content);
      const expectedSha = createHash("sha256").update(content).digest("hex");
      const sessionKey = "workflow_run:00000000-0000-4000-8000-000000000001";
      let request: { init?: RequestInit } | undefined;
      const tool = createMagisterActionTool(
        api({ workspaceDir: workspace }),
        completionAction,
        async (_input, init) => {
          request = { init };
          return new Response(JSON.stringify(envelope()), { status: 200 });
        },
        { sessionKey },
      );

      const output = resultJson(
        await tool.execute("completion-auto-hash", {
          artifacts: [{ path: "resources/report.md" }],
        }),
      );

      expect(output.ok).toBe(true);
      // The forwarded body carries the plugin-computed hash, not the raw input.
      expect(requestBody(request?.init)).toEqual({
        arguments: {
          artifacts: [{ path: "resources/report.md", sha256: expectedSha, kind: "file" }],
        },
      });
      const manifest = [["resources/report.md", expectedSha, "file"]];
      const expected = createHmac("sha256", "secret-machine-token")
        .update(`${sessionKey}\n${JSON.stringify(manifest)}`)
        .digest("hex");
      expect(request?.init?.headers).toMatchObject({
        "x-magister-artifact-attestation": `v1=${expected}`,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a placeholder-sized completion artifact before any upstream call", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    const workspace = await mkdtemp(join(tmpdir(), "magister-actions-"));
    try {
      await mkdir(join(workspace, "resources"));
      // Run 6e06af15 shipped exactly this: a 3-byte test-vector file whose
      // hash the model knew from memory.
      await writeFile(join(workspace, "resources", "report.md"), "abc");
      let fetched = false;
      const tool = createMagisterActionTool(
        api({ workspaceDir: workspace }),
        completionAction,
        async () => {
          fetched = true;
          return new Response(JSON.stringify(envelope()), { status: 200 });
        },
        { sessionKey: "workflow_run:00000000-0000-4000-8000-000000000001" },
      );

      const output = resultJson(
        await tool.execute("completion-placeholder", {
          artifacts: [{ path: "resources/report.md" }],
        }),
      );

      expect(output.ok).toBe(false);
      expect((output.error as { code: string }).code).toBe("asset_invalid");
      expect((output.error as { message: string }).message).toContain("too small");
      expect(fetched).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a completion artifact whose bytes do not match its hash", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    const workspace = await mkdtemp(join(tmpdir(), "magister-actions-"));
    try {
      await mkdir(join(workspace, "resources"));
      await writeFile(
        join(workspace, "resources", "report.md"),
        "actual report bytes that differ from the supplied hash\n".repeat(10),
      );
      let fetched = false;
      const tool = createMagisterActionTool(
        api({ workspaceDir: workspace }),
        completionAction,
        async () => {
          fetched = true;
          return new Response(JSON.stringify(envelope()), { status: 200 });
        },
        { sessionKey: "workflow_run:00000000-0000-4000-8000-000000000001" },
      );

      const output = resultJson(
        await tool.execute("completion-2", {
          artifacts: [{ path: "resources/report.md", sha256: "a".repeat(64), kind: "file" }],
        }),
      );

      expect(output.ok).toBe(false);
      expect((output.error as { code: string }).code).toBe("asset_invalid");
      expect((output.error as { message: string }).message).toContain("hash mismatch");
      expect(fetched).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("envelope validator", () => {
  it("accepts the complete closed contract", () => {
    expect(parseActionEnvelope(envelope())).not.toBeNull();
  });

  it("rejects success with an error and unknown side effects", () => {
    expect(parseActionEnvelope(envelope({ error: { code: "conflict" } }))).toBeNull();
    expect(parseActionEnvelope(envelope({ side_effect: "root_shell" }))).toBeNull();
  });

  it("rejects unknown top-level, status, and error fields", () => {
    expect(parseActionEnvelope({ ...envelope(), injected: true })).toBeNull();
    expect(
      parseActionEnvelope(
        envelope({
          status: {
            state: "succeeded",
            terminal: true,
            poll_after_seconds: 0,
            stale_seconds: 0,
            started_at: "secret",
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseActionEnvelope(
        envelope({
          ok: false,
          status: {
            state: "failed",
            terminal: true,
            poll_after_seconds: 0,
            stale_seconds: 0,
          },
          error: {
            code: "upstream_failed",
            message: "failed",
            retryable: true,
            retry_after_seconds: null,
            user_action: null,
            internal_detail: "secret",
          },
        }),
      ),
    ).toBeNull();
  });

  it("accepts a successful poll that observes a terminal operation failure", () => {
    expect(
      parseActionEnvelope(
        envelope({
          status: {
            state: "failed",
            terminal: true,
            poll_after_seconds: 0,
            stale_seconds: 0,
          },
        }),
      ),
    ).not.toBeNull();
  });

  it("rejects contradictory terminal state combinations", () => {
    expect(
      parseActionEnvelope(
        envelope({
          ok: false,
          status: {
            state: "succeeded",
            terminal: true,
            poll_after_seconds: 0,
            stale_seconds: 0,
          },
          error: {
            code: "upstream_failed",
            message: "failed",
            retryable: false,
            retry_after_seconds: null,
            user_action: null,
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseActionEnvelope(
        envelope({
          status: {
            state: "running",
            terminal: true,
            poll_after_seconds: 0,
            stale_seconds: 0,
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseActionEnvelope(
        envelope({
          status: {
            state: "succeeded",
            terminal: true,
            poll_after_seconds: 3,
            stale_seconds: 0,
          },
        }),
      ),
    ).toBeNull();
  });

  it("rejects retryable write envelopes that could trigger a blind redispatch", () => {
    expect(
      parseActionEnvelope(
        envelope({
          ok: false,
          status: {
            state: "failed",
            terminal: true,
            poll_after_seconds: 0,
            stale_seconds: 0,
          },
          side_effect: "draft",
          error: {
            code: "upstream_failed",
            message: "response lost",
            retryable: true,
            retry_after_seconds: null,
            user_action: "Read back the draft.",
          },
        }),
      ),
    ).toBeNull();
  });

  it("accepts a closed non-terminal approval envelope", () => {
    expect(
      parseActionEnvelope(
        envelope({
          ok: false,
          status: {
            state: "running",
            terminal: false,
            poll_after_seconds: 5,
            stale_seconds: 0,
          },
          side_effect: "external_write",
          error: {
            code: "not_authorized",
            message: "Human approval is required.",
            retryable: false,
            retry_after_seconds: null,
            user_action: "Open the approval page.",
          },
        }),
      ),
    ).not.toBeNull();
  });
});

describe("hold-the-turn approvals", () => {
  const pendingHoldEnvelope = () =>
    parseActionEnvelope(
      envelope({
        ok: false,
        operation_id: "op_hold_1",
        side_effect: "external_write",
        status: {
          state: "running",
          terminal: false,
          poll_after_seconds: 5,
          stale_seconds: 0,
        },
        receipt: {
          approval_id: "11111111-1111-4111-8111-111111111111",
          approval_state: "pending",
          approval_presentation: "inline_web",
          permission_continuation: "automatic",
          permission_hold: true,
          hold_deadline: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
          hold_poll_seconds: 5,
        },
        error: {
          code: "approval_required",
          message: "User permission is required",
          retryable: false,
          retry_after_seconds: null,
          user_action: null,
        },
      }),
    );

  const terminalPollEnvelope = (state = "succeeded") =>
    envelope({
      operation_id: "op_poll_identity",
      side_effect: "none",
      status: {
        state: state === "succeeded" ? "succeeded" : "failed",
        terminal: true,
        poll_after_seconds: 0,
        stale_seconds: 0,
      },
      receipt: {
        approval: {
          operation_id: "op_hold_1",
          state,
          terminal: true,
          receipt: { state, action: "send_email" },
        },
      },
    });

  function holdOptions(fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response>) {
    const held = pendingHoldEnvelope();
    if (!held) {
      throw new Error("pending hold envelope failed to parse");
    }
    return {
      envelope: held,
      endpoint: "http://magister-gateway.internal:8081/api/agent/actions",
      gatewayToken: "secret",
      fetchImpl: fetchImpl as never,
      maxResponseBytes: 512 * 1024,
      sleep: async () => {},
    };
  }

  it("publishes an inline approval update before entering the hold", async () => {
    process.env.GATEWAY_TOKEN = "secret-machine-token";
    const pending = pendingHoldEnvelope();
    if (!pending) {
      throw new Error("pending hold envelope failed to parse");
    }
    const tool = createMagisterActionTool(
      api(),
      writeAction,
      async () => new Response(JSON.stringify(pending), { status: 200 }),
    );
    const controller = new AbortController();
    controller.abort();
    const updates: unknown[] = [];

    const result = await tool.execute(
      "call-held-approval",
      {
        idempotency_key: "held-approval-test",
        to: ["member@example.com"],
        subject: "Approval test",
        body: "Test body",
      },
      controller.signal,
      (update) => updates.push(update),
    );

    expect(updates).toHaveLength(1);
    const updateContent = (updates[0] as { content?: Array<{ text?: string }> }).content?.[0];
    const updatePayload = JSON.parse(updateContent?.text ?? "null") as Record<string, unknown>;
    expect(updatePayload).toMatchObject({
      operation_id: "op_hold_1",
      receipt: {
        approval_id: "11111111-1111-4111-8111-111111111111",
        approval_state: "pending",
        approval_presentation: "inline_web",
        permission_hold: true,
      },
    });
    expect(resultJson(result)).toMatchObject({
      operation_id: "op_hold_1",
      status: { terminal: false },
    });
  });

  it("polls until terminal, acknowledges, and keeps the original identity", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (input: unknown, init?: RequestInit) => {
      const url = requestUrl(input as string);
      calls.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
      if (url.endsWith("/approval_resolution_ack")) {
        return new Response(JSON.stringify({ delivered: true }), { status: 200 });
      }
      const body =
        calls.filter((c) => c.url.endsWith("/get_action_approval")).length < 2
          ? envelope({
              status: {
                state: "running",
                terminal: false,
                poll_after_seconds: 5,
                stale_seconds: 0,
              },
              receipt: { approval: { state: "pending", terminal: false } },
            })
          : terminalPollEnvelope("denied");
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const result = await holdForApprovalDecision(holdOptions(fetchImpl));

    expect(result).not.toBeNull();
    expect(result?.status.terminal).toBe(true);
    // Original call identity survives: the model reads this as the gated
    // action's own outcome, not as a get_action_approval result.
    expect(result?.operation_id).toBe("op_hold_1");
    expect(result?.side_effect).toBe("external_write");
    const approval = result?.receipt["approval"] as Record<string, unknown>;
    expect(approval["state"]).toBe("denied");
    const ack = calls.find((c) => c.url.endsWith("/approval_resolution_ack"));
    expect(ack).toBeDefined();
    expect(ack?.body).toEqual({ operation_id: "op_hold_1" });
    const polls = calls.filter((c) => c.url.endsWith("/get_action_approval"));
    expect(polls.length).toBe(2);
    expect(polls[0]?.body).toEqual({ arguments: { operation_id: "op_hold_1" } });
  });

  it("retries transport failures within the hold instead of surrendering it", async () => {
    let attempts = 0;
    const fetchImpl = async (input: unknown, init?: RequestInit) => {
      const url = requestUrl(input as string);
      if (url.endsWith("/approval_resolution_ack")) {
        return new Response("{}", { status: 200 });
      }
      attempts += 1;
      if (attempts === 1) {
        throw new Error("socket hang up");
      }
      return new Response(JSON.stringify(terminalPollEnvelope()), { status: 200 });
    };

    const result = await holdForApprovalDecision(holdOptions(fetchImpl));

    expect(result?.status.terminal).toBe(true);
    expect(attempts).toBe(2);
  });

  it("stands down when the user queues a message (release_requested)", async () => {
    const fetchImpl = async (input: unknown) => {
      const url = requestUrl(input as string);
      if (url.endsWith("/approval_resolution_ack")) {
        throw new Error("must not ack a released hold");
      }
      return new Response(
        JSON.stringify(
          envelope({
            status: {
              state: "running",
              terminal: false,
              poll_after_seconds: 5,
              stale_seconds: 0,
            },
            receipt: {
              approval: { state: "pending", terminal: false, release_requested: true },
            },
          }),
        ),
        { status: 200 },
      );
    };

    expect(await holdForApprovalDecision(holdOptions(fetchImpl))).toBeNull();
  });

  it("stands down when delivery belongs to the continuation", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify(
          envelope({
            status: {
              state: "running",
              terminal: false,
              poll_after_seconds: 30,
              stale_seconds: 0,
            },
            receipt: {
              approval: { state: "pending", terminal: false, delivery: "continuation" },
            },
          }),
        ),
        { status: 200 },
      );

    expect(await holdForApprovalDecision(holdOptions(fetchImpl))).toBeNull();
  });

  it("never holds an envelope without the hold marker", async () => {
    const fetchImpl = async () => {
      throw new Error("must not poll a non-hold pending envelope");
    };
    const held = pendingHoldEnvelope();
    if (!held) {
      throw new Error("pending hold envelope failed to parse");
    }
    held.receipt = { approval_id: "x", permission_continuation: "automatic" };

    const result = await holdForApprovalDecision({
      ...holdOptions(fetchImpl as never),
      envelope: held,
    });

    expect(result).toBeNull();
  });

  it("respects the server deadline", async () => {
    let clock = Date.now();
    const fetchImpl = async () => {
      throw new Error("deadline in the past must not poll");
    };
    const held = pendingHoldEnvelope();
    if (!held) {
      throw new Error("pending hold envelope failed to parse");
    }
    held.receipt = {
      ...held.receipt,
      hold_deadline: new Date(clock - 1000).toISOString(),
    };

    const result = await holdForApprovalDecision({
      ...holdOptions(fetchImpl as never),
      envelope: held,
      now: () => clock,
    });

    expect(result).toBeNull();
  });

  it("an aborted run ends the hold immediately", async () => {
    const fetchImpl = async () => {
      throw new Error("aborted hold must not poll");
    };
    const controller = new AbortController();
    controller.abort();

    const result = await holdForApprovalDecision({
      ...holdOptions(fetchImpl as never),
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });
});
