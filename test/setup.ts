import { beforeEach } from "vitest";
import { clearWebflowSiteCache, webflowDns } from "../src/infra/net/refused-hosts.js";
import { installSharedTestSetup } from "./setup.shared.js";

installSharedTestSetup();

// Magister: the Webflow hosting check resolves real DNS (src/infra/net/refused-hosts.ts).
// Tests answer "no records" with a plain function, which vi.resetAllMocks cannot
// empty; one that needs a Webflow answer spies on webflowDns.resolve.
beforeEach(() => {
  clearWebflowSiteCache();
  webflowDns.resolve = async () => ({ names: [], addresses: [] });
});
