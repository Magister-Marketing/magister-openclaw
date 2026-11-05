import { readFileSync } from "node:fs";
import { SsrFBlockedError } from "./ssrf.js";

/**
 * Webflow content is read through Webflow's API and no other way.
 *
 * Webflow rejected the Magister app on 2026-11-04 because, after a disconnect, a
 * new chat read the site's public address with `web_fetch`. The Gateway enforces
 * the same rule on everything it serves (`gateway/app/services/webflow_public_read.py`);
 * this is the machine's half, because `web_fetch`, `image` and `pdf` fetch directly.
 *
 * `*.webflow.io` is refused unconditionally, so a stale or missing file cannot open
 * it. A brand's own Webflow hosts arrive in the egress allowlist file the Gateway
 * writes at claim, on wake and on any chat turn where they changed.
 */
const STAGING_DOMAIN = "webflow.io";
const DEFAULT_ALLOWLIST_PATH = "/data/.openclaw/egress-allowlist.json";

export const REFUSED_HOST_MESSAGE =
  "This is a Webflow site, and Webflow content is read only through the Webflow " +
  "connection, never by fetching or scraping its public pages. If Webflow is connected, " +
  "read it with service `webflow` (site pages, page DOM, CMS items). If it is not, tell " +
  "the user this needs Webflow connected and stop; do not try another way to read the page.";

function brandHosts(path: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const listed = (parsed as { refused_hosts?: unknown } | null)?.refused_hosts;
    return Array.isArray(listed)
      ? listed.filter((host): host is string => typeof host === "string" && host.length > 0)
      : [];
  } catch {
    // No machine file (a lane being set up, a test, the desktop app): the staging
    // rule still holds, and the Gateway refuses the brand's hosts on what it serves.
    return [];
  }
}

function normalize(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host.startsWith("www.") ? host.slice(4) : host;
}

function covers(host: string, refused: string): boolean {
  return host === refused || host.endsWith(`.${refused}`);
}

export function isRefusedHost(
  hostname: string,
  allowlistPath: string = process.env.MAGISTER_EGRESS_ALLOWLIST || DEFAULT_ALLOWLIST_PATH,
): boolean {
  const host = normalize(hostname);
  return (
    covers(host, STAGING_DOMAIN) || brandHosts(allowlistPath).some((item) => covers(host, item))
  );
}

/** Raises what callers already treat as final: no provider fallback runs after it. */
export function assertHostNotRefused(hostname: string): void {
  if (isRefusedHost(hostname)) {
    throw new SsrFBlockedError(REFUSED_HOST_MESSAGE);
  }
}
