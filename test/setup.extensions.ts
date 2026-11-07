import { afterAll, beforeEach } from "vitest";
import { clearWebflowSiteCache, webflowDns } from "../src/infra/net/refused-hosts.js";
import { installSharedTestSetup } from "./setup.shared.js";

const testEnv = installSharedTestSetup({ loadProfileEnv: false });

// Magister: the Webflow hosting check resolves real DNS (src/infra/net/refused-hosts.ts).
// Tests answer "no records"; one that needs a Webflow answer spies on webflowDns.resolve.
beforeEach(() => {
  clearWebflowSiteCache();
  webflowDns.resolve = async () => ({ names: [], addresses: [] });
});

afterAll(() => {
  testEnv.cleanup();
});
