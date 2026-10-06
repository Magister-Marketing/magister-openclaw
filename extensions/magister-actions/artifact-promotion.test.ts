import { createHash } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactPromotionError,
  handleArtifactPromotion,
  promoteArtifact,
} from "./artifact-promotion.js";

const roots: string[] = [];
const previousEnforcement = process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT;
const previousGatewayToken = process.env.GATEWAY_TOKEN;
const previousGatewayUrl = process.env.GATEWAY_INTERNAL_URL;
const previousWorkspace = process.env.OPENCLAW_WORKSPACE_DIR;
const previousAgentToolUid = process.env.MAGISTER_AGENT_TOOL_UID;
// chmod cannot refuse root, so the permission-shaped tests need a real user.
const runsAsRoot = process.getuid?.() === 0;
let diagnostics: DiagnosticEventPayload[] = [];
let stopDiagnostics: (() => void) | undefined;

afterEach(() => {
  stopDiagnostics?.();
  stopDiagnostics = undefined;
  vi.unstubAllGlobals();
  for (const [key, value] of [
    ["OPENCLAW_WORKSPACE_DIR", previousWorkspace],
    ["MAGISTER_AGENT_TOOL_UID", previousAgentToolUid],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (previousEnforcement === undefined) {
    delete process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT;
  } else {
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = previousEnforcement;
  }
  if (previousGatewayToken === undefined) {
    delete process.env.GATEWAY_TOKEN;
  } else {
    process.env.GATEWAY_TOKEN = previousGatewayToken;
  }
  if (previousGatewayUrl === undefined) {
    delete process.env.GATEWAY_INTERNAL_URL;
  } else {
    process.env.GATEWAY_INTERNAL_URL = previousGatewayUrl;
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  resetDiagnosticEventsForTest();
  diagnostics = [];
  stopDiagnostics = onInternalDiagnosticEvent((event) => {
    diagnostics.push(event);
  });
  process.env.GATEWAY_TOKEN = "broker-local";
  process.env.GATEWAY_INTERNAL_URL = "http://127.0.0.1:18796";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = url.endsWith("/attest")
        ? { commit_expires_at: new Date(Date.now() + 60_000).toISOString() }
        : { status: "ok" };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

function fixture(content = "bounded artifact") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magister-promotion-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const attempt = "attempt-1";
  const attemptRoot = path.join(workspace, ".magister", "tmp", "attempts", attempt);
  fs.mkdirSync(path.join(attemptRoot, "promote"), { recursive: true });
  const staged = path.join(attemptRoot, "promote", "report.txt");
  fs.writeFileSync(staged, content);
  return {
    workspace,
    attempt,
    staged,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function request(row: ReturnType<typeof fixture>) {
  return {
    attempt_id: row.attempt,
    staged_path: "promote/report.txt",
    destination_path: "deliverables/report.txt",
    sha256: row.sha256,
    mutation_context: {
      project_id: "project-1",
      operation_id: "operation-1",
      owner_id: "gateway-owner-1",
      project_fence: 7,
      mode: "enforce",
    },
  };
}

describe("artifact promotion", () => {
  it("atomically promotes one owned staged file under a current fence", async () => {
    const row = fixture();
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
    const result = await promoteArtifact(request(row), {
      workspace: row.workspace,
      agentToolUid: process.getuid?.() ?? 501,
    });
    expect(result).toMatchObject({
      status: "promoted",
      destination_path: "deliverables/report.txt",
      sha256: row.sha256,
      project_fence: 7,
    });
    expect(fs.readFileSync(path.join(row.workspace, "deliverables", "report.txt"), "utf8")).toBe(
      "bounded artifact",
    );
    expect(fs.existsSync(row.staged)).toBe(false);
  });

  it("leaves a promoted artifact readable by the agent's tools, and staging owner-only", async () => {
    // Promoted at 0600 inside a 0700 directory, an artifact was invisible to
    // `exec` until the next restart re-ran the boot-time read-surface pass.
    const row = fixture();
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
    const mode = (target: string) => fs.statSync(target).mode & 0o777;
    const stagingRoot = path.join(row.workspace, ".magister", "tmp");
    fs.chmodSync(stagingRoot, 0o700);
    const nested = { ...request(row), destination_path: "deliverables/q3/report.txt" };

    await promoteArtifact(nested, {
      workspace: row.workspace,
      agentToolUid: process.getuid?.() ?? 501,
    });

    const destination = path.join(row.workspace, "deliverables", "q3", "report.txt");
    expect(mode(destination)).toBe(0o644);
    expect(mode(path.join(row.workspace, "deliverables", "q3"))).toBe(0o755);
    expect(mode(path.join(row.workspace, "deliverables"))).toBe(0o755);
    expect(mode(destination) & 0o022).toBe(0);
    // Only the destination chain is widened; the staging tree is not.
    expect(mode(stagingRoot)).toBe(0o700);
  });

  it("heals an artifact an earlier promotion left owner-only", async () => {
    const row = fixture();
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
    const destination = path.join(row.workspace, "deliverables", "report.txt");
    fs.mkdirSync(path.dirname(destination), { mode: 0o700 });
    fs.writeFileSync(destination, "bounded artifact", { mode: 0o600 });
    fs.chmodSync(destination, 0o600);

    const result = await promoteArtifact(request(row), {
      workspace: row.workspace,
      agentToolUid: process.getuid?.() ?? 501,
    });

    expect(result.status).toBe("already_current");
    expect(fs.statSync(destination).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.dirname(destination)).mode & 0o777).toBe(0o755);
  });

  it("rejects missing fences and platform-managed destinations", async () => {
    const row = fixture();
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
    await expect(
      promoteArtifact(
        { ...request(row), mutation_context: undefined },
        {
          workspace: row.workspace,
          agentToolUid: process.getuid?.() ?? 501,
        },
      ),
    ).rejects.toThrow("current enforced mutation fence");
    await expect(
      promoteArtifact(
        { ...request(row), destination_path: ".magister/state/escape" },
        {
          workspace: row.workspace,
          agentToolUid: process.getuid?.() ?? 501,
        },
      ),
    ).rejects.toBeInstanceOf(ArtifactPromotionError);
  });

  it("requires the expected hash before replacing a user file", async () => {
    const row = fixture("new content");
    fs.mkdirSync(path.join(row.workspace, "deliverables"));
    fs.writeFileSync(path.join(row.workspace, "deliverables", "report.txt"), "user edit");
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
    await expect(
      promoteArtifact(request(row), {
        workspace: row.workspace,
        agentToolUid: process.getuid?.() ?? 501,
      }),
    ).rejects.toThrow("replacement was not authorized");
    expect(fs.readFileSync(path.join(row.workspace, "deliverables", "report.txt"), "utf8")).toBe(
      "user edit",
    );
  });

  it.skipIf(runsAsRoot)(
    "keeps a committed promotion when the staging directory refuses cleanup",
    async () => {
      // The sandbox creates `promote/<sub>/` as agent-tool under umask 0027, so
      // the host can read the staged file but not unlink it. The artifact is
      // already at its destination and the ledger says promoted; answering 500
      // here told the agent a delivered file had failed (MAGISTER-GATEWAY-CW).
      const row = fixture();
      process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
      const subdir = path.join(path.dirname(row.staged), "sub");
      fs.mkdirSync(subdir);
      const staged = path.join(subdir, "report.txt");
      fs.renameSync(row.staged, staged);
      fs.chmodSync(subdir, 0o550);
      const nested = { ...request(row), staged_path: "promote/sub/report.txt" };
      const options = { workspace: row.workspace, agentToolUid: process.getuid?.() ?? 501 };
      try {
        await expect(promoteArtifact(nested, options)).resolves.toMatchObject({
          status: "promoted",
        });
        // A retry finds the same refused staging and must still succeed.
        await expect(promoteArtifact(nested, options)).resolves.toMatchObject({
          status: "already_current",
        });
      } finally {
        fs.chmodSync(subdir, 0o750);
      }
      expect(fs.readFileSync(path.join(row.workspace, "deliverables", "report.txt"), "utf8")).toBe(
        "bounded artifact",
      );
      // Left for the supervisor's scratch reaper, which runs as root.
      expect(fs.existsSync(staged)).toBe(true);
      const cleanup = diagnostics.filter((event) => event.type === "plugin.cleanup.failed");
      expect(cleanup).toHaveLength(2);
      expect(cleanup[0]).toMatchObject({
        pluginId: "magister-actions",
        toolName: "magister_artifact_promotion",
        reasonCode: "eacces",
      });
      expect(diagnostics.some((event) => event.type === "http.request.error")).toBe(false);
    },
  );
});

function fakeExchange(body: unknown) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
  }) as unknown as IncomingMessage;
  const response = { status: 0, body: "" };
  const res = {
    set statusCode(value: number) {
      response.status = value;
    },
    setHeader: () => undefined,
    end: (chunk: string) => {
      response.body = chunk;
    },
  } as unknown as ServerResponse;
  return { req, res, response };
}

describe("artifact promotion route", () => {
  it.skipIf(runsAsRoot)(
    "reports an unexpected failure once, by errno code and never by path",
    async () => {
      const row = fixture();
      process.env.OPENCLAW_WORKSPACE_DIR = row.workspace;
      process.env.MAGISTER_AGENT_TOOL_UID = String(process.getuid?.() ?? 501);
      const tmpRoot = path.join(row.workspace, ".magister", "tmp");
      fs.chmodSync(tmpRoot, 0o000);
      const { req, res, response } = fakeExchange(request(row));
      try {
        await handleArtifactPromotion(req, res);
      } finally {
        fs.chmodSync(tmpRoot, 0o755);
      }

      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
        error: "promotion_rejected",
        message: "promotion failed",
      });
      const failures = diagnostics.filter((event) => event.type === "http.request.error");
      expect(failures).toEqual([
        expect.objectContaining({
          type: "http.request.error",
          surface: "plugin_http",
          failureKind: "handler_exception",
          toolName: "magister_artifact_promotion",
          reasonCode: "eacces",
        }),
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain(row.workspace);
    },
  );

  it("keeps expected rejections quiet", async () => {
    const row = fixture();
    process.env.OPENCLAW_WORKSPACE_DIR = row.workspace;
    process.env.MAGISTER_AGENT_TOOL_UID = String(process.getuid?.() ?? 501);
    const { req, res, response } = fakeExchange({
      ...request(row),
      destination_path: "AGENTS.md",
    });

    await handleArtifactPromotion(req, res);

    expect(response.status).toBe(403);
    expect(diagnostics.some((event) => event.type === "http.request.error")).toBe(false);
  });
});
