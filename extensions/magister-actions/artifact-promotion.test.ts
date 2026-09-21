import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactPromotionError, promoteArtifact } from "./artifact-promotion.js";

const roots: string[] = [];
const previousEnforcement = process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT;
const previousGatewayToken = process.env.GATEWAY_TOKEN;
const previousGatewayUrl = process.env.GATEWAY_INTERNAL_URL;

afterEach(() => {
  vi.unstubAllGlobals();
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
});
