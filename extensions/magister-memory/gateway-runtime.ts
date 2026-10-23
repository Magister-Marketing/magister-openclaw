/**
 * The machine's runtime channel to the Gateway: `GATEWAY_INTERNAL_URL` with
 * the machine's `GATEWAY_TOKEN`. The token only ever goes to the Gateway's
 * private host or the machine's credential broker, which forwards an exact
 * allowlist of paths (`openclaw-image/credential_broker.py`), so every path
 * used here must be mapped there as well.
 */
function runtimeEndpoint(path: string): string {
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
    throw new Error("memory gateway endpoint is not trusted");
  }
  return `${raw}/api/runtime/${path}`;
}

export async function callRuntimeGateway(
  path: string,
  options: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
): Promise<Record<string, unknown>> {
  const token = process.env.GATEWAY_TOKEN ?? "";
  if (!token) {
    throw new Error("memory gateway credential is unavailable");
  }
  const response = await fetch(runtimeEndpoint(path), {
    method: options.method,
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      Authorization: `Bearer ${token}`,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    // No runtime route redirects. Following one would resend the token to a
    // same-origin target, and a 307/308 would resend the body, unchecked.
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`memory gateway rejected ${path}: HTTP ${response.status}`);
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("memory gateway returned an invalid response");
  }
  return result as Record<string, unknown>;
}
