import { createHash } from "node:crypto";
import { callRuntimeGateway } from "./gateway-runtime.js";

type LocalMutationContext = {
  project_id: string;
  operation_id: string;
  owner_id: string;
  project_fence: number;
  account_fence?: number | null;
  mode: "observe" | "enforce";
};

// USER.md is the one memory file the machine still owns. MEMORY.md is brand
// memory, written by the Gateway under the same project fence
// (brand-memory.ts), so it needs no local lease.
const RESOURCE = "USER.md";

function post(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  return callRuntimeGateway(`mutations/${pathname}`, { method: "POST", body, timeoutMs: 5000 });
}

function parseContext(value: Record<string, unknown>): LocalMutationContext {
  if (
    typeof value.project_id !== "string" ||
    typeof value.operation_id !== "string" ||
    typeof value.owner_id !== "string" ||
    !Number.isSafeInteger(value.project_fence) ||
    Number(value.project_fence) < 1 ||
    value.mode !== "enforce"
  ) {
    throw new Error("memory host mutation lease response is invalid");
  }
  return {
    project_id: value.project_id,
    operation_id: value.operation_id,
    owner_id: value.owner_id,
    project_fence: Number(value.project_fence),
    mode: "enforce",
  };
}

export function memoryOperationId(callId: string, action: string, target: string): string {
  const digest = createHash("sha256")
    .update(`${callId}:${action}:${target}`)
    .digest("hex")
    .slice(0, 32);
  return `host-memory-${digest}`;
}

export async function withHostMutationBoundary(
  options: {
    operationId: string;
    content: string;
  },
  write: () => Promise<void>,
): Promise<void> {
  if (process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT !== "1") {
    await write();
    return;
  }
  const contentHash = createHash("sha256").update(options.content).digest("hex");
  const context = parseContext(
    await post("acquire", {
      operation_id: options.operationId,
      resource_class: "host:user",
    }),
  );
  let attested = false;
  try {
    const result = await post("attest", {
      context,
      resource: RESOURCE,
      content_hash: contentHash,
    });
    const deadline =
      typeof result.commit_expires_at === "string"
        ? Date.parse(result.commit_expires_at)
        : Number.NaN;
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      throw new Error("memory mutation commit attestation expired before write");
    }
    attested = true;
    await write();
    await post("complete", { context, resource: RESOURCE, content_hash: contentHash });
    attested = false;
  } finally {
    if (attested) {
      await post("complete", { context, resource: RESOURCE, content_hash: contentHash }).catch(
        () => {},
      );
    }
    await post("release", { context });
  }
}
