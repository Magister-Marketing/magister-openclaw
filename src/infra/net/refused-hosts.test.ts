import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allHostedSitesRefused,
  assertHostNotRefused,
  assertNotWebflowSite,
  cnameIsWebflow,
  isRefusedHost,
  isWebflowAddress,
  REFUSED_HOST_MESSAGE,
  responseIsWebflow,
  WEBFLOW_CHECK_UNAVAILABLE_MESSAGE,
  clearWebflowSiteCache,
  webflowDns,
} from "./refused-hosts.js";
import { SsrFBlockedError } from "./ssrf.js";

describe("refused hosts", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "refused-hosts-"));
    file = join(dir, "egress-allowlist.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses every Webflow staging host with no file at all", () => {
    expect(isRefusedHost("site.webflow.io", file)).toBe(true);
    expect(isRefusedHost("WWW.Site.Webflow.IO.", file)).toBe(true);
    expect(isRefusedHost("webflow.io", file)).toBe(true);
  });

  it("leaves Webflow itself and lookalikes alone", () => {
    expect(isRefusedHost("developers.webflow.com", file)).toBe(false);
    expect(isRefusedHost("api.webflow.com", file)).toBe(false);
    expect(isRefusedHost("notwebflow.io", file)).toBe(false);
    expect(isRefusedHost("site.webflow.io.evil.example", file)).toBe(false);
  });

  it("refuses the brand's hosts and subdomains from the Gateway's file", () => {
    writeFileSync(file, JSON.stringify({ version: 1, project: [], refused_hosts: ["acme.com"] }));
    expect(isRefusedHost("acme.com", file)).toBe(true);
    expect(isRefusedHost("www.acme.com", file)).toBe(true);
    expect(isRefusedHost("shop.acme.com", file)).toBe(true);
    expect(isRefusedHost("acme.com.evil.example", file)).toBe(false);
    expect(isRefusedHost("other.example", file)).toBe(false);
  });

  it("follows the file when the Gateway rewrites it", () => {
    writeFileSync(file, JSON.stringify({ refused_hosts: ["a.example"] }));
    expect(isRefusedHost("a.example", file)).toBe(true);
    rmSync(file);
    writeFileSync(file, JSON.stringify({ refused_hosts: ["b.example"] }));
    expect(isRefusedHost("b.example", file)).toBe(true);
  });

  it("survives a malformed file, keeping the staging rule", () => {
    writeFileSync(file, "{not json");
    expect(isRefusedHost("other.example", file)).toBe(false);
    expect(isRefusedHost("site.webflow.io", file)).toBe(true);
    writeFileSync(file, JSON.stringify({ refused_hosts: "acme.com" }));
    expect(isRefusedHost("acme.com", file)).toBe(false);
  });

  it("raises the error that skips the provider fallback, and says what to do", () => {
    expect(() => assertHostNotRefused("site.webflow.io")).toThrow(SsrFBlockedError);
    expect(() => assertHostNotRefused("site.webflow.io")).toThrow(REFUSED_HOST_MESSAGE);
    expect(REFUSED_HOST_MESSAGE).toContain("service `webflow`");
  });
});

// The shapes production's Webflow-built brands showed on 2026-11-06.
const RECORDS: Record<string, { names: string[]; addresses: string[] }> = {
  "acme.com": { names: [], addresses: ["198.202.211.1"] },
  "www.acme.com": { names: ["cdn.webflow.com"], addresses: ["198.202.211.1", "2620:cb:2000::1"] },
  "old.example": { names: ["proxy-ssl.webflow.com"], addresses: ["44.229.220.222"] },
  "www.forward.example": { names: ["cdn.webflow.com"], addresses: ["198.202.211.1"] },
  "developers.webflow.com": { names: [], addresses: ["100.49.212.38"] },
};

describe("sites Webflow serves on custom domains", () => {
  beforeEach(() => {
    vi.spyOn(webflowDns, "resolve").mockImplementation(
      async (host: string) => RECORDS[host] ?? { names: [], addresses: [] },
    );
  });

  it("knows Webflow's names, networks, hosting CNAMEs and response marks", () => {
    expect(isRefusedHost("cdn.prod.website-files.com", "/nonexistent")).toBe(true);
    expect(isWebflowAddress("198.202.211.7")).toBe(true);
    expect(isWebflowAddress("75.2.70.75")).toBe(true);
    expect(isWebflowAddress("198.202.212.1")).toBe(false);
    expect(cnameIsWebflow("proxy-ssl-geo-2.webflow.com.")).toBe(true);
    expect(cnameIsWebflow("webflow.com")).toBe(false);
    expect(responseIsWebflow(new Headers({ "x-wf-region": "us-east-1" }))).toBe(true);
    expect(responseIsWebflow(null, '<html data-wf-site="1">')).toBe(true);
    expect(responseIsWebflow(new Headers({ server: "cloudflare" }), "<p>webflow</p>")).toBe(false);
  });

  it("refuses a custom domain by DNS, and one whose www twin is Webflow's", async () => {
    for (const host of ["acme.com", "www.acme.com", "old.example", "forward.example"]) {
      await expect(assertNotWebflowSite(host)).rejects.toThrow(REFUSED_HOST_MESSAGE);
    }
    await expect(assertNotWebflowSite("independent.example")).resolves.toBeUndefined();
    await expect(assertNotWebflowSite("developers.webflow.com")).resolves.toBeUndefined();
  });

  it("refuses an unanswered lookup only for the address a tool was handed", async () => {
    vi.spyOn(webflowDns, "resolve").mockRejectedValue(
      Object.assign(new Error("timeout"), { code: "ETIMEOUT" }),
    );
    await expect(assertNotWebflowSite("down.example")).resolves.toBeUndefined();
    await expect(assertNotWebflowSite("down.example", { failClosed: true })).rejects.toThrow(
      WEBFLOW_CHECK_UNAVAILABLE_MESSAGE,
    );
  });
});

describe("the Webflow DNS check under a failing resolver", () => {
  it("asks once a minute per host, not once per request", async () => {
    const resolve = vi
      .spyOn(webflowDns, "resolve")
      .mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEOUT" }));
    for (let i = 0; i < 3; i++) {
      await expect(assertNotWebflowSite("slow.example")).resolves.toBeUndefined();
    }
    expect(resolve.mock.calls.map(([host]) => host)).toEqual(["slow.example", "www.slow.example"]);
  });
});

describe("with the Gateway's every-site switch off (2026-11-12)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "refused-hosts-off-"));
    file = join(dir, "egress-allowlist.json");
    vi.stubEnv("MAGISTER_EGRESS_ALLOWLIST", file);
    clearWebflowSiteCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(payload: Record<string, unknown>) {
    writeFileSync(file, JSON.stringify({ version: 1, project: [], ...payload }));
  }

  it("reads a never-connected custom domain Webflow hosts, without looking it up", async () => {
    write({ refuse_all_hosted_sites: false, refused_hosts: ["acme.com"] });
    const resolve = vi
      .spyOn(webflowDns, "resolve")
      .mockResolvedValue({ names: ["cdn.webflow.com"], addresses: ["198.202.211.1"] });

    expect(allHostedSitesRefused()).toBe(false);
    await expect(
      assertNotWebflowSite("iteright.com", { failClosed: true }),
    ).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(isWebflowAddress("198.202.211.1")).toBe(false);
    expect(responseIsWebflow(new Headers({ "x-wf-region": "us" }), '<html data-wf-site="1">')).toBe(
      false,
    );
  });

  it("still refuses authorized hosts and names only Webflow serves", async () => {
    write({ refuse_all_hosted_sites: false, refused_hosts: ["acme.com"] });
    await expect(assertNotWebflowSite("www.acme.com")).rejects.toThrow(REFUSED_HOST_MESSAGE);
    await expect(assertNotWebflowSite("site.webflow.io")).rejects.toThrow(REFUSED_HOST_MESSAGE);
  });

  it("keeps the ruling when the file does not say it is off", async () => {
    write({ refused_hosts: [] });
    expect(allHostedSitesRefused()).toBe(true);
    vi.spyOn(webflowDns, "resolve").mockResolvedValue({
      names: ["cdn.webflow.com"],
      addresses: [],
    });
    await expect(assertNotWebflowSite("iteright.com")).rejects.toThrow(REFUSED_HOST_MESSAGE);
    expect(isWebflowAddress("198.202.211.1")).toBe(true);
  });
});
