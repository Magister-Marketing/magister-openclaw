import { vi } from "vitest";
import { ENTRY_DELIMITER } from "./memory-store.js";

export type GatewayCall = {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  authorization?: string;
};

/**
 * A stand-in for the Gateway's brand memory routes, holding the list in
 * memory and answering in the contract's shape. Refusals mirror the store's
 * messages for the cases the tests exercise.
 */
export function stubBrandMemoryGateway(initial: string[] = []) {
  const entries = [...initial];
  const calls: GatewayCall[] = [];
  // Paths that answer HTTP 500, to simulate a Gateway failure mid-sync.
  const failing = new Set<string>();
  const list = () => {
    const content = entries.join(ENTRY_DELIMITER);
    return {
      entries: entries.map((text, index) => ({ id: `entry-${index}`, text, source: "hosted" })),
      content,
      char_count: content.length,
      char_limit: 2200,
    };
  };
  const reply = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const match = (needle: string) => {
    const hits = entries.flatMap((entry, index) => (entry.includes(needle) ? [index] : []));
    if (hits.length === 0) {
      return `No entry contains the substring '${needle}'`;
    }
    return hits.length > 1
      ? `Substring '${needle}' matches ${hits.length} entries — use a more unique substring`
      : hits[0];
  };

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path: url.pathname,
      body,
      authorization: headers.get("Authorization") ?? undefined,
    });
    if (failing.has(url.pathname)) {
      return new Response("{}", { status: 500 });
    }

    if (url.pathname === "/api/runtime/brand-memory" && method === "GET") {
      return reply(list());
    }
    if (url.pathname === "/api/runtime/brand-memory/import" && method === "POST") {
      let imported = 0;
      if (entries.length === 0) {
        for (const text of (body?.entries as string[]) ?? []) {
          if (!text.startsWith("[magister_seed:")) {
            entries.push(text);
            imported += 1;
          }
        }
      }
      return reply({ ok: true, imported, ...list() });
    }
    if (url.pathname === "/api/runtime/brand-memory" && method === "POST") {
      const content = typeof body?.content === "string" ? body.content.trim() : "";
      const oldText = typeof body?.old_text === "string" ? body.old_text : "";
      if (body?.action === "add") {
        if (entries.some((entry) => entry.trim().toLowerCase() === content.toLowerCase())) {
          return reply({ ok: false, error: "Entry already exists (duplicate)", ...list() });
        }
        entries.push(content);
        return reply({ ok: true, ...list() });
      }
      const index = match(oldText);
      if (typeof index === "string") {
        return reply({ ok: false, error: index, ...list() });
      }
      if (body?.action === "replace") {
        entries[index] = content;
      } else {
        entries.splice(index, 1);
      }
      return reply({ ok: true, ...list() });
    }
    return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { entries, calls, failing, fetchMock };
}

/** Point the plugin's runtime channel at the machine broker, as on a machine. */
export function useMachineGatewayEnv(): () => void {
  const previous = {
    url: process.env.GATEWAY_INTERNAL_URL,
    token: process.env.GATEWAY_TOKEN,
  };
  process.env.GATEWAY_INTERNAL_URL = "http://127.0.0.1:18796";
  process.env.GATEWAY_TOKEN = "broker-local";
  return () => {
    restore("GATEWAY_INTERNAL_URL", previous.url);
    restore("GATEWAY_TOKEN", previous.token);
  };
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
