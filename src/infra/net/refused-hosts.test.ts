import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertHostNotRefused, isRefusedHost, REFUSED_HOST_MESSAGE } from "./refused-hosts.js";
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
