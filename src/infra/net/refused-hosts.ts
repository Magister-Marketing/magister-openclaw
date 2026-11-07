import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { SsrFBlockedError } from "./ssrf.js";

/**
 * Webflow content is read through Webflow's API and no other way.
 *
 * Webflow rejected the Magister app on 2026-11-04 because, after a disconnect, a
 * new chat read the site's public address with `web_fetch`. Asked whether the rule
 * covers an unrelated public site that runs on Webflow, Webflow answered on
 * 2026-11-06: yes, custom domains included, whoever asks and however public the
 * page is. The Gateway enforces the same rule on everything it serves
 * (`gateway/app/services/webflow_hosting.py`); this is the machine's half, because
 * `web_fetch`, `image` and `pdf` fetch directly.
 *
 * A site is Webflow's by name (`*.webflow.io`, Webflow's asset CDNs), by DNS (a
 * CNAME to Webflow hosting, or an address in Webflow's networks), or, behind a
 * proxy, by its response's own marks. The rules match
 * `webapp/src/lib/webflow-hosting.json` in the monorepo; its
 * `gateway/tests/test_services/test_webflow_hosting.py` compares them.
 *
 * A brand's own Webflow hosts also arrive in the egress allowlist file the Gateway
 * writes at claim, on wake and on any chat turn where they changed.
 */
export const WEBFLOW_DOMAINS = ["webflow.io", "website-files.com", "uploads-ssl.webflow.com"];
export const WEBFLOW_NETWORKS = [
  "198.202.211.0/24",
  "2620:cb:2000::/48",
  "75.2.70.75/32",
  "99.83.190.102/32",
];
const WEBFLOW_CNAME = /^(?:cdn|proxy-ssl(?:-geo(?:-\d+)?)?)\.webflow\.com$/;
const WEBFLOW_HEADER_PREFIX = "x-wf-";
const WEBFLOW_HTML =
  /data-wf-(?:site|page)=|<meta[^>]+content=["']Webflow["'][^>]+name=["']generator|<meta[^>]+name=["']generator["'][^>]+content=["']Webflow/i;
const DEFAULT_ALLOWLIST_PATH = "/data/.openclaw/egress-allowlist.json";
const DNS_TIMEOUT_MS = 3000;
const FOUND_TTL_MS = 60 * 60 * 1000;
const CLEAR_TTL_MS = 15 * 60 * 1000;
const MAX_CACHED = 4096;
const NO_RECORD = new Set(["ENODATA", "ENOTFOUND", "NOTFOUND", "NODATA", "EBADNAME", "BADNAME"]);

const networks = new BlockList();
for (const network of WEBFLOW_NETWORKS) {
  const [address, prefix] = network.split("/");
  networks.addSubnet(address, Number(prefix), isIP(address) === 6 ? "ipv6" : "ipv4");
}
const hostedCache = new Map<string, { expires: number; found: boolean }>();

export const REFUSED_HOST_MESSAGE =
  "This site is built on Webflow, and Webflow content is read only through the Webflow " +
  "connection, never by fetching, crawling or scraping its public pages, even when the " +
  "user asks and the page is public. If this brand's Webflow site is connected, read it " +
  "with service `webflow` (site pages, page DOM, CMS items). Otherwise tell the user " +
  "Magister can't read sites built on Webflow unless the site's owner connects it, and " +
  "stop. Do not try, or offer, another way to get the page's content.";

export const WEBFLOW_CHECK_UNAVAILABLE_MESSAGE =
  "Magister couldn't confirm this site isn't built on Webflow, whose sites are read only " +
  "through the Webflow connection, because DNS did not answer. Try again in a minute; do " +
  "not try another way to read the page.";

function brandHosts(path: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const listed = (parsed as { refused_hosts?: unknown } | null)?.refused_hosts;
    return Array.isArray(listed)
      ? listed.filter((host): host is string => typeof host === "string" && host.length > 0)
      : [];
  } catch {
    // No machine file (a lane being set up, a test, the desktop app): the name and
    // DNS rules still hold, and the Gateway refuses the brand's hosts on what it serves.
    return [];
  }
}

function bare(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
}

function normalize(hostname: string): string {
  const host = bare(hostname);
  return host.startsWith("www.") ? host.slice(4) : host;
}

function covers(host: string, refused: string): boolean {
  return host === refused || host.endsWith(`.${refused}`);
}

/** By name alone: a host only Webflow serves, or one of the brand's own Webflow hosts. */
export function isRefusedHost(
  hostname: string,
  allowlistPath: string = process.env.MAGISTER_EGRESS_ALLOWLIST || DEFAULT_ALLOWLIST_PATH,
): boolean {
  const host = normalize(hostname);
  return (
    WEBFLOW_DOMAINS.some((domain) => covers(host, domain)) ||
    brandHosts(allowlistPath).some((item) => covers(host, item))
  );
}

/** Raises what callers already treat as final: no provider fallback runs after it. */
export function assertHostNotRefused(hostname: string): void {
  if (isRefusedHost(hostname)) {
    throw new SsrFBlockedError(REFUSED_HOST_MESSAGE);
  }
}

export function isWebflowAddress(address: string): boolean {
  const value = bare(address);
  const family = isIP(value);
  return family !== 0 && networks.check(value, family === 6 ? "ipv6" : "ipv4");
}

export function cnameIsWebflow(name: string): boolean {
  return WEBFLOW_CNAME.test(bare(name));
}

/** Webflow's own marks on a response, for a site whose DNS hides its host. */
export function responseIsWebflow(
  headers: Pick<Headers, "get"> | null | undefined,
  html?: string | null,
): boolean {
  const names: string[] = [];
  const all = headers as Partial<Headers> | null | undefined;
  if (typeof all?.forEach === "function") {
    all.forEach((_value, name) => names.push(name));
  }
  if (
    names.some((name) => name.toLowerCase().startsWith(WEBFLOW_HEADER_PREFIX)) ||
    // A minimal header object can still say so through the header Webflow always sends.
    Boolean(headers?.get?.("x-wf-region"))
  ) {
    return true;
  }
  return Boolean(html && WEBFLOW_HTML.test(html));
}

/** No such record is an answer; any other failure means DNS could not say. */
async function records(lookup: () => Promise<string[]>): Promise<string[]> {
  try {
    return await lookup();
  } catch (err) {
    if (NO_RECORD.has((err as { code?: string })?.code ?? "")) {
      return [];
    }
    throw err;
  }
}

/** Every CNAME target and address a host resolves to. Exported for tests to replace. */
export const webflowDns = {
  async resolve(host: string): Promise<{ names: string[]; addresses: string[] }> {
    const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
    const [names, v4, v6] = await Promise.all([
      records(() => resolver.resolveCname(host)),
      records(() => resolver.resolve4(host)),
      records(() => resolver.resolve6(host)),
    ]);
    return { names, addresses: [...v4, ...v6] };
  },
};

async function isHosted(host: string): Promise<boolean> {
  if (isIP(host)) {
    return isWebflowAddress(host);
  }
  const now = Date.now();
  const cached = hostedCache.get(host);
  if (cached && cached.expires > now) {
    return cached.found;
  }
  const { names, addresses } = await webflowDns.resolve(host);
  const found = names.some(cnameIsWebflow) || addresses.some(isWebflowAddress);
  if (hostedCache.size >= MAX_CACHED) {
    hostedCache.clear();
  }
  hostedCache.set(host, { expires: now + (found ? FOUND_TTL_MS : CLEAR_TTL_MS), found });
  return found;
}

/** A host and its `www` twin, which a fetch of it may be redirected to. */
function withTwin(host: string): string[] {
  if (isIP(host)) {
    return [host];
  }
  return host.startsWith("www.") ? [host, host.slice(4)] : [host, `www.${host}`];
}

/**
 * Refuse a site Webflow serves, by name or by DNS (the host and its `www` twin).
 * `failClosed` refuses when DNS cannot answer: for the address a tool was handed. A
 * redirect hop leaves an unanswered lookup to the address and response checks in the
 * guarded fetch.
 */
export async function assertNotWebflowSite(
  hostname: string,
  options: { failClosed?: boolean } = {},
): Promise<void> {
  assertHostNotRefused(hostname);
  const host = bare(hostname);
  if (!host) {
    return;
  }
  const verdicts = await Promise.all(
    withTwin(host).map(async (twin) => {
      try {
        return await isHosted(twin);
      } catch {
        return "unknown" as const;
      }
    }),
  );
  if (verdicts.includes(true)) {
    throw new SsrFBlockedError(REFUSED_HOST_MESSAGE);
  }
  if (options.failClosed && verdicts.includes("unknown")) {
    throw new SsrFBlockedError(WEBFLOW_CHECK_UNAVAILABLE_MESSAGE);
  }
}

/** For tests. */
export function clearWebflowSiteCache(): void {
  hostedCache.clear();
}
