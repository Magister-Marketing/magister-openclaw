import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryRuntime } from "./library-runtime.js";

const admissionMode = vi.spyOn(LibraryRuntime.prototype, "admissionMode");

async function reconcile(body: string | undefined) {
  vi.stubEnv("GATEWAY_TOKEN", "fixture-token");
  admissionMode.mockResolvedValue("legacy");
  const { handleLibraryReconcile } = await import("./library-integration.js");
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  (req as { method?: string }).method = "POST";
  if (body === undefined) req.end();
  else req.end(body);
  const res = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 } as unknown as ServerResponse;
  await handleLibraryReconcile(req, res);
  return admissionMode.mock.calls.at(-1)?.[0];
}

afterEach(() => {
  vi.unstubAllEnvs();
  admissionMode.mockReset();
});

describe("handleLibraryReconcile", () => {
  it("passes the Gateway's turn id from the body to admission", async () => {
    await expect(reconcile('{"through_sequence": 4, "turn_id": "turn-1"}')).resolves.toEqual({
      fromGateway: true,
      turnId: "turn-1",
    });
  });

  it("admits with no turn for an older Gateway's body, an empty body, or a bad one", async () => {
    for (const body of [
      '{"through_sequence": 4}',
      "",
      undefined,
      "not json",
      '{"turn_id": "a b"}',
    ]) {
      await expect(reconcile(body)).resolves.toEqual({ fromGateway: true, turnId: undefined });
    }
  });
});
