import { createHash } from "node:crypto";

type LocalMutationContext = {
  project_id: string;
  operation_id: string;
  owner_id: string;
  project_fence: number;
  account_fence?: number | null;
  mode: "observe" | "enforce";
};

function endpoint(pathname: string): string {
  const raw = (process.env.GATEWAY_INTERNAL_URL ?? "http://magister-gateway.internal:8081").replace(
    /\/+$/,
    "",
  );
  const url = new URL(raw);
  const trusted =
    url.protocol === "http:" &&
    (url.hostname === "magister-gateway.internal" ||
      (url.hostname === "127.0.0.1" && url.port === "18796"));
  if (!trusted || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("memory mutation gateway endpoint is not trusted");
  }
  return `${raw}/api/runtime/mutations/${pathname}`;
}

async function post(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const token = process.env.GATEWAY_TOKEN ?? "";
  if (!token) {
    throw new Error("memory mutation gateway credential is unavailable");
  }
  const response = await fetch(endpoint(pathname), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`memory mutation gateway rejected ${pathname}: HTTP ${response.status}`);
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("memory mutation gateway returned an invalid response");
  }
  return result as Record<string, unknown>;
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
    target: "memory" | "user";
    content: string;
  },
  write: () => Promise<void>,
): Promise<void> {
  if (process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT !== "1") {
    await write();
    return;
  }
  const contentHash = createHash("sha256").update(options.content).digest("hex");
  const resource = options.target === "memory" ? "MEMORY.md" : "USER.md";
  const context = parseContext(
    await post("acquire", {
      operation_id: options.operationId,
      resource_class: options.target === "memory" ? "host:memory" : "host:user",
    }),
  );
  let attested = false;
  try {
    const result = await post("attest", {
      context,
      resource,
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
    await post("complete", { context, resource, content_hash: contentHash });
    attested = false;
  } finally {
    if (attested) {
      await post("complete", { context, resource, content_hash: contentHash }).catch(() => {});
    }
    await post("release", { context });
  }
}
