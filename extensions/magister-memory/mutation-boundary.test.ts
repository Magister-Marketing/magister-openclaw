import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withHostMutationBoundary } from "./mutation-boundary.js";

describe("host semantic mutation boundary", () => {
  beforeEach(() => {
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
    process.env.GATEWAY_INTERNAL_URL = "http://127.0.0.1:18796";
    process.env.GATEWAY_TOKEN = "broker-local";
  });

  afterEach(() => {
    delete process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT;
    delete process.env.GATEWAY_INTERNAL_URL;
    delete process.env.GATEWAY_TOKEN;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attests the exact final content before the atomic memory write", async () => {
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const action = url.split("/").at(-1) ?? "";
        events.push(action);
        if (action === "acquire") {
          return new Response(
            JSON.stringify({
              project_id: "project-1",
              operation_id: "host-memory-1",
              owner_id: "gateway-owner",
              project_fence: 9,
              mode: "enforce",
            }),
            { status: 200 },
          );
        }
        if (action === "attest") {
          if (typeof init?.body !== "string") {
            throw new Error("expected a JSON request body");
          }
          const body = JSON.parse(init.body) as Record<string, unknown>;
          expect(body).toMatchObject({ resource: "MEMORY.md" });
          expect(body.content_hash).toMatch(/^[a-f0-9]{64}$/);
          return new Response(
            JSON.stringify({ commit_expires_at: new Date(Date.now() + 30_000).toISOString() }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }),
    );

    await withHostMutationBoundary(
      { operationId: "host-memory-1", target: "memory", content: "bounded fact" },
      async () => {
        events.push("write");
      },
    );

    expect(events).toEqual(["acquire", "attest", "write", "complete", "release"]);
  });

  it("fails closed before writing when the live fence cannot be attested", async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/acquire")) {
          return new Response(
            JSON.stringify({
              project_id: "project-1",
              operation_id: "host-memory-1",
              owner_id: "stale-owner",
              project_fence: 8,
              mode: "enforce",
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/attest")) {
          return new Response(JSON.stringify({ detail: "stale fence" }), { status: 409 });
        }
        return new Response(JSON.stringify({ status: "released" }), { status: 200 });
      }),
    );

    await expect(
      withHostMutationBoundary(
        { operationId: "host-memory-1", target: "memory", content: "must not land" },
        write,
      ),
    ).rejects.toThrow("rejected attest");
    expect(write).not.toHaveBeenCalled();
  });
});
