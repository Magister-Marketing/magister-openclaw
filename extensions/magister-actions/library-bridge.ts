import type { LibraryBridge } from "./library-types.js";

export class LibraryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Library request failed: HTTP ${status}`);
  }
}

export function createLibraryBridge(): LibraryBridge {
  const base = new URL(process.env.GATEWAY_INTERNAL_URL ?? "http://magister-gateway.internal:8081");
  if (
    base.protocol !== "http:" ||
    !(
      base.hostname === "magister-gateway.internal" ||
      (base.hostname === "127.0.0.1" && base.port === "18796")
    ) ||
    (base.pathname !== "/" && base.pathname !== "")
  )
    throw new Error("Untrusted Library gateway");
  return {
    request: async <T>(
      method: "GET" | "POST",
      endpoint: string,
      values?: Record<string, unknown>,
    ): Promise<T> => {
      const token = process.env.GATEWAY_TOKEN;
      if (!token) throw new Error("Library gateway credential is unavailable");
      if (!/^\/[a-z0-9/_-]+$/.test(endpoint)) throw new Error("Invalid Library route");
      const url = new URL(`/api/library${endpoint}`, base);
      if (method === "GET")
        for (const [key, value] of Object.entries(values ?? {})) {
          if (value !== undefined) url.searchParams.set(key, String(value));
        }
      const response = await fetch(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(values ?? {}) } : {}),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new LibraryHttpError(response.status, body);
      return body as T;
    },
    download: async (raw) => {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Invalid Library download URL");
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new LibraryHttpError(response.status, undefined);
      return Buffer.from(await response.arrayBuffer());
    },
    upload: async (raw, bytes, contentType) => {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Invalid Library upload URL");
      const response = await fetch(url, {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
        headers: { "content-type": contentType },
        body: new Uint8Array(bytes),
      });
      if (!response.ok) throw new LibraryHttpError(response.status, undefined);
    },
  };
}
