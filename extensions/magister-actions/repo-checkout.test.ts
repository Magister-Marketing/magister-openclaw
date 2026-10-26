import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECKOUT_TTL_MS,
  CheckoutError,
  COMMIT_AUTHOR_EMAIL,
  awaitRepositoryIdle,
  checkoutRepository,
  CI_DEFINITION_PATHS,
  detectPackageManager,
  ensureRepoRoot,
  handleRepoCheckout,
  INSTALL_POLL_SECONDS,
  installRepoDependencies,
  isCiDefinition,
  actionManifestReferences,
  pipelineIncludes,
  workflowActionDirs,
  MAX_MANIFEST_PATH_CHARS,
  makeReadableByTools,
  measureTree,
  normalizeRepoPath,
  parseBranch,
  parseInstallRequest,
  parseProvider,
  parsePushRequest,
  parseRef,
  parseRepo,
  parseRequest,
  prepareRepoCommit,
  pushRepoBranch,
  resolveRepoDir,
  reviewUrls,
  scrubToken,
  sweepExpiredCheckouts,
  workLayer,
} from "./repo-checkout.js";

const temporary: string[] = [];

afterEach(() => {
  delete process.env.MAGISTER_REPO_ROOT;
  delete process.env.MAGISTER_TOOL_SANDBOX_LAUNCHER;
  delete process.env.MAGISTER_CHECKOUT_LOCK_WAIT_MS;
  for (const root of temporary.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A real upstream repository plus a real shallow checkout of it, so the
 *  refresh, dirty-refusal, and idempotency paths run against actual git. */
function upstreamAndCheckout(): { origin: string; repoDir: string; root: string } {
  const origin = scratch("magister-origin-");
  git(origin, "init", "--quiet", "--initial-branch=main");
  fs.writeFileSync(path.join(origin, "README.md"), "first\n");
  git(origin, "add", "README.md");
  git(origin, "commit", "--quiet", "-m", "first");

  const root = scratch("magister-repos-");
  process.env.MAGISTER_REPO_ROOT = root;
  const repoDir = path.join(root, "acme", "site");
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  git(root, "clone", "--quiet", "--depth", "1", `file://${origin}`, repoDir);
  return { origin, repoDir, root };
}

/** A *bare* upstream, which is what push needs: git refuses to update the
 *  checked-out branch of a repository that has a working tree. */
function bareUpstreamAndCheckout(): {
  origin: string;
  seed: string;
  repoDir: string;
  root: string;
} {
  const seed = scratch("magister-seed-");
  git(seed, "init", "--quiet", "--initial-branch=main");
  fs.writeFileSync(path.join(seed, "README.md"), "first\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "--quiet", "-m", "first");

  const origin = scratch("magister-bare-");
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(seed, "push", "--quiet", `file://${origin}`, "main");

  const root = scratch("magister-repos-");
  process.env.MAGISTER_REPO_ROOT = root;
  const repoDir = path.join(root, "acme", "site");
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  git(root, "clone", "--quiet", "--depth", "1", `file://${origin}`, repoDir);
  git(repoDir, "checkout", "--quiet", "--detach", "HEAD");
  return { origin, seed, repoDir, root };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/site",
    provider: "github",
    discard_local_changes: false,
    token: "ghu_test_token",
    ...overrides,
  } as Parameters<typeof checkoutRepository>[0];
}

function prepare(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/site",
    provider: "github",
    message: "Update the readme",
    ...overrides,
  } as Parameters<typeof prepareRepoCommit>[0];
}

function push(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/site",
    provider: "github",
    branch: "magister/readme",
    token: "ghu_test_token",
    ...overrides,
  } as Parameters<typeof pushRepoBranch>[0];
}

function remoteTip(origin: string, branch: string): string | null {
  const listed = git(origin, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
  return listed.trim() || null;
}

describe("repository identity validation", () => {
  it("accepts a plain owner/name pair", () => {
    expect(parseRepo("acme/site").full).toBe("acme/site");
    expect(parseRepo("a-b/e.f-g_h").full).toBe("a-b/e.f-g_h");
    expect(parseRepo("acme/site").provider).toBe("github");
  });

  it("rejects traversal segments that a naive owner/name pattern would allow", () => {
    // `^[^/\s]+/[^/\s]+$` matches all of these; each resolves outside the root.
    for (const value of ["../etc", "../..", "acme/..", "./x", "acme/."]) {
      expect(() => parseRepo(value)).toThrow(CheckoutError);
      expect(() => parseRepo(value, "gitlab")).toThrow(CheckoutError);
    }
  });

  it("rejects GitHub shapes that are not exactly two segments", () => {
    for (const value of ["acme", "acme/site/extra", "/site", "acme/", "acme site", 7, null]) {
      expect(() => parseRepo(value)).toThrow(CheckoutError);
    }
  });

  it("holds a GitHub owner to GitHub's own rule, which is what keeps it from ever spelling a hostname", () => {
    // A GitLab checkout lives under `gitlab.com/…`; an owner with a dot could
    // collide with that directory, and GitHub forbids the dot anyway.
    for (const owner of ["gitlab.com", "a.b", "a_b", "-lead", "x".repeat(40)]) {
      expect(() => parseRepo(`${owner}/site`)).toThrow(CheckoutError);
    }
    expect(parseRepo("a-b/site").full).toBe("a-b/site");
  });

  it("accepts nested GitLab groups up to the provider's depth and no further", () => {
    expect(parseRepo("group/project", "gitlab").full).toBe("group/project");
    expect(parseRepo("group/sub/deeper/project", "gitlab").segments).toEqual([
      "group",
      "sub",
      "deeper",
      "project",
    ]);
    expect(parseRepo("g.roup/sub_1/project", "gitlab").provider).toBe("gitlab");
    expect(() => parseRepo("a/b/c/d/e/f/g", "gitlab")).toThrow(CheckoutError);
    expect(() => parseRepo("lonely", "gitlab")).toThrow(CheckoutError);
  });

  it("reads an absent provider as GitHub and refuses one it does not know", () => {
    expect(parseProvider(undefined)).toBe("github");
    expect(parseProvider(null)).toBe("github");
    expect(parseProvider("gitlab")).toBe("gitlab");
    for (const value of ["bitbucket", "", "GITHUB", 1, {}]) {
      expect(() => parseProvider(value)).toThrow(CheckoutError);
    }
  });

  it("keeps a resolved checkout directory inside the repository root", () => {
    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    expect(resolveRepoDir(parseRepo("acme/site"))).toBe(path.join(root, "acme", "site"));
  });

  it("gives every host but GitHub its own directory, so the same path on two hosts never collides", () => {
    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    expect(resolveRepoDir(parseRepo("acme/site", "gitlab"))).toBe(
      path.join(root, "gitlab.com", "acme", "site"),
    );
    expect(resolveRepoDir(parseRepo("group/sub/project", "gitlab"))).toBe(
      path.join(root, "gitlab.com", "group", "sub", "project"),
    );
    // GitHub keeps the original layout, so nothing already on disk is orphaned.
    expect(resolveRepoDir(parseRepo("acme/site", "github"))).toBe(path.join(root, "acme", "site"));
  });

  it("renders review links in each host's own URL grammar", () => {
    expect(reviewUrls("github", "acme/site", "main", "magister/x")).toEqual({
      branch_url: "https://github.com/acme/site/tree/magister/x",
      pull_request_url: "https://github.com/acme/site/compare/main...magister/x?expand=1",
    });
    const gitlab = reviewUrls("gitlab", "group/sub/project", "main", "magister/x");
    expect(gitlab.branch_url).toBe("https://gitlab.com/group/sub/project/-/tree/magister/x");
    expect(gitlab.pull_request_url).toBe(
      "https://gitlab.com/group/sub/project/-/merge_requests/new?merge_request%5Bsource_branch%5D=magister%2Fx&merge_request%5Btarget_branch%5D=main",
    );
  });
});

describe("ref validation", () => {
  it("accepts branches, tags, and full commit SHAs", () => {
    expect(parseRef("main")).toEqual({ ref: "main", isSha: false });
    expect(parseRef("release/2026.8")).toEqual({ ref: "release/2026.8", isSha: false });
    expect(parseRef("v1.2.3")).toEqual({ ref: "v1.2.3", isSha: false });
    const sha = "a".repeat(40);
    expect(parseRef(sha)).toEqual({ ref: sha, isSha: true });
  });

  it("treats an absent ref as the default branch", () => {
    expect(parseRef(undefined)).toBeNull();
    expect(parseRef("")).toBeNull();
  });

  it("rejects a leading dash, which would be argv injection into git", () => {
    expect(() => parseRef("--upload-pack=touch /tmp/pwned")).toThrow(CheckoutError);
    expect(() => parseRef("-x")).toThrow(CheckoutError);
  });

  it("rejects traversal and malformed ref punctuation", () => {
    for (const value of ["a..b", "a//b", "trailing/", "with space", "tab\there"]) {
      expect(() => parseRef(value)).toThrow(CheckoutError);
    }
  });
});

describe("request parsing", () => {
  it("rejects unknown fields and a missing credential", () => {
    expect(() => parseRequest({ repo: "acme/site", token: "t", surprise: 1 })).toThrow(
      /unknown fields/,
    );
    expect(() => parseRequest({ repo: "acme/site" })).toThrow(/credential/);
    expect(() => parseRequest("nope")).toThrow(CheckoutError);
  });

  it("defaults the discard flag to false so dirty work is never dropped by omission", () => {
    expect(parseRequest({ repo: "acme/site", token: "t" }).discard_local_changes).toBe(false);
    expect(
      parseRequest({ repo: "acme/site", token: "t", discard_local_changes: true })
        .discard_local_changes,
    ).toBe(true);
  });

  it("carries the provider through every request shape, defaulting to GitHub", () => {
    expect(parseRequest({ repo: "acme/site", token: "t" }).provider).toBe("github");
    expect(
      parseRequest({ repo: "group/sub/project", provider: "gitlab", token: "t" }).provider,
    ).toBe("gitlab");
    // A three-segment path is only a repository on a host that nests groups.
    expect(() => parseRequest({ repo: "group/sub/project", token: "t" })).toThrow(CheckoutError);
    expect(() => parseRequest({ repo: "acme/site", provider: "svn", token: "t" })).toThrow(
      /provider/,
    );
    expect(
      parsePushRequest({ ...push(), commit_sha: "a".repeat(40), provider: "gitlab" }).provider,
    ).toBe("gitlab");
  });
});

describe("token scrubbing", () => {
  it("removes every occurrence of the credential from text", () => {
    expect(scrubToken("fatal: ghu_secret rejected ghu_secret", "ghu_secret")).toBe(
      "fatal: *** rejected ***",
    );
    expect(scrubToken("clean output", "")).toBe("clean output");
  });
});

describe("tree measurement", () => {
  it("counts files and bytes without following symlinks", async () => {
    const root = scratch("magister-measure-");
    fs.mkdirSync(path.join(root, "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "a.txt"), "12345");
    fs.writeFileSync(path.join(root, "nested", "b.txt"), "678");
    fs.symlinkSync("/etc/passwd", path.join(root, "link"));

    const stats = await measureTree(root, { maxFiles: 100, maxBytes: 1_000 });
    expect(stats.exceeded).toBe(false);
    expect(stats.files).toBe(3);
    expect(stats.bytes).toBe(8);
  });

  it("stops early once a limit is passed", async () => {
    const root = scratch("magister-measure-");
    for (let index = 0; index < 20; index += 1) {
      fs.writeFileSync(path.join(root, `f${index}.txt`), "x");
    }
    const stats = await measureTree(root, { maxFiles: 5, maxBytes: 1_000 });
    expect(stats.exceeded).toBe(true);
    expect(stats.files).toBeLessThan(20);
  });
});

describe("sandbox readability", () => {
  it("mirrors owner read/execute onto other without granting any write bit", async () => {
    const root = scratch("magister-perms-");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    const plain = path.join(root, "README.md");
    const script = path.join(root, "bin", "build.sh");
    fs.writeFileSync(plain, "text");
    fs.writeFileSync(script, "#!/bin/sh\n");
    // What a clone under the host's 0027 umask actually produces.
    fs.chmodSync(root, 0o750);
    fs.chmodSync(path.join(root, "bin"), 0o750);
    fs.chmodSync(plain, 0o640);
    fs.chmodSync(script, 0o750);

    await makeReadableByTools(root);

    const mode = (target: string) => fs.statSync(target).mode & 0o777;
    expect(mode(root)).toBe(0o755);
    expect(mode(path.join(root, "bin"))).toBe(0o755);
    expect(mode(plain)).toBe(0o644);
    // An executable stays executable; the sandbox runs build scripts it reads.
    expect(mode(script)).toBe(0o755);
    for (const target of [root, path.join(root, "bin"), plain, script]) {
      expect(mode(target) & 0o022).toBe(0);
    }
  });

  it("leaves a checked-out tree readable by a non-owner", async () => {
    const { repoDir } = upstreamAndCheckout();
    await checkoutRepository(request());
    expect(fs.statSync(path.join(repoDir, "README.md")).mode & 0o004).toBe(0o004);
    expect(fs.statSync(repoDir).mode & 0o005).toBe(0o005);
  });

  it("creates a missing repository root traversable, not 0700", async () => {
    // Every other mkdir here is `recursive: true` with mode 0700 for the
    // staging directory, and a recursive mkdir applies its mode to every
    // directory it creates. If one of those created the root, it would land
    // 0700 and the tool user could not traverse it — the bind would mount
    // fine and every checkout would be silently unreadable.
    const root = path.join(scratch("magister-parent-"), "repos");
    process.env.MAGISTER_REPO_ROOT = root;
    expect(fs.existsSync(root)).toBe(false);

    await ensureRepoRoot();

    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
  });

  it("repairs a root that is already too restrictive", async () => {
    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    fs.chmodSync(root, 0o700);

    await ensureRepoRoot();

    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
  });
});

describe("brokered checkout against a real repository", () => {
  it("reports an unchanged checkout as already_current", async () => {
    upstreamAndCheckout();
    const receipt = await checkoutRepository(request());
    expect(receipt.status).toBe("already_current");
    expect(receipt.repo).toBe("acme/site");
    expect(receipt.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.file_count).toBeGreaterThan(0);
  });

  it("fast-forwards to a new upstream commit", async () => {
    const { origin, repoDir } = upstreamAndCheckout();
    fs.writeFileSync(path.join(origin, "README.md"), "second\n");
    git(origin, "commit", "--quiet", "-am", "second");

    const receipt = await checkoutRepository(request());
    expect(receipt.status).toBe("refreshed");
    expect(fs.readFileSync(path.join(repoDir, "README.md"), "utf8")).toBe("second\n");
  });

  it("refuses to overwrite dirty work and never discards it implicitly", async () => {
    const { repoDir } = upstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "local edit\n");

    await expect(checkoutRepository(request())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("uncommitted changes"),
    });
    // The refusal must leave the user's work exactly as it was.
    expect(fs.readFileSync(path.join(repoDir, "README.md"), "utf8")).toBe("local edit\n");
  });

  it("discards dirty work only when the caller asks explicitly", async () => {
    const { repoDir } = upstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "local edit\n");
    fs.writeFileSync(path.join(repoDir, "untracked.txt"), "scratch\n");

    const receipt = await checkoutRepository(request({ discard_local_changes: true }));
    expect(receipt.status).toBe("already_current");
    expect(fs.readFileSync(path.join(repoDir, "README.md"), "utf8")).toBe("first\n");
    expect(fs.existsSync(path.join(repoDir, "untracked.txt"))).toBe(false);
  });

  it("keeps its bookkeeping out of the working tree", async () => {
    const { repoDir } = upstreamAndCheckout();
    await checkoutRepository(request());
    // A marker written beside the source would make git status non-empty, and
    // the dirty-work refusal would then reject every subsequent refresh.
    expect(git(repoDir, "status", "--porcelain").trim()).toBe("");
    expect(fs.existsSync(path.join(repoDir, ".git", "magister-checkout.json"))).toBe(true);
  });

  it("serialises concurrent checkouts of the same repository", async () => {
    upstreamAndCheckout();
    const first = checkoutRepository(request());
    await expect(checkoutRepository(request())).rejects.toMatchObject({ statusCode: 409 });
    await first;
    // The slot must clear so later work is not latched out.
    await expect(checkoutRepository(request())).resolves.toMatchObject({
      status: "already_current",
    });
  });
});

describe("TTL sweeping", () => {
  it("removes a checkout past its TTL and prunes the empty owner directory", async () => {
    const { repoDir, root } = upstreamAndCheckout();
    const stale = new Date(Date.now() - CHECKOUT_TTL_MS - 60_000).toISOString();
    fs.writeFileSync(
      path.join(repoDir, ".git", "magister-checkout.json"),
      JSON.stringify({ last_used_at: stale, repo: "acme/site" }),
    );

    const swept = await sweepExpiredCheckouts();
    expect(swept.removed).toContain(repoDir);
    expect(fs.existsSync(repoDir)).toBe(false);
    expect(fs.existsSync(path.join(root, "acme"))).toBe(false);
  });

  it("keeps a checkout that is still inside its TTL", async () => {
    const { repoDir } = upstreamAndCheckout();
    await checkoutRepository(request());
    const swept = await sweepExpiredCheckouts();
    expect(swept.removed).not.toContain(repoDir);
    expect(fs.existsSync(repoDir)).toBe(true);
  });

  it("never deletes a checkout an operation is standing in", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    // The marker is only stamped when an operation *finishes*, and the sweeper
    // also runs on its own hourly timer — so a prepare against a day-old
    // checkout is exactly when the two collide.
    const pending = prepareRepoCommit(prepare());

    const swept = await sweepExpiredCheckouts(Date.now() + CHECKOUT_TTL_MS * 2);

    expect(swept.removed).toEqual([]);
    await expect(pending).resolves.toMatchObject({ status: "prepared" });
    expect(fs.existsSync(repoDir)).toBe(true);
    // Once it is idle again the same sweep does collect it.
    const after = await sweepExpiredCheckouts(Date.now() + CHECKOUT_TTL_MS * 2);
    expect(after.removed).toContain(repoDir);
  });

  /** The supervisor makes `.work/<owner>` root-owned 0755 the first time a
   *  command runs in any of that owner's checkouts; read-only stands in for
   *  it here. Returns the sibling checkout that has no layer of its own. */
  function staleSiblingUnderRootOwnedWork(): { repoDir: string; sibling: string; owner: string } {
    const { origin, repoDir, root } = upstreamAndCheckout();
    const sibling = path.join(root, "acme", "other");
    git(root, "clone", "--quiet", "--depth", "1", `file://${origin}`, sibling);
    const stale = new Date(Date.now() - CHECKOUT_TTL_MS - 60_000).toISOString();
    fs.writeFileSync(
      path.join(sibling, ".git", "magister-checkout.json"),
      JSON.stringify({ last_used_at: stale, repo: "acme/other" }),
    );
    fs.mkdirSync(workLayer(repoDir).root, { recursive: true });
    const owner = path.dirname(workLayer(repoDir).root);
    fs.chmodSync(owner, 0o555);
    return { repoDir, sibling, owner };
  }

  it("an idle sibling it cannot lock never fails another repository's checkout", async () => {
    const { repoDir, sibling, owner } = staleSiblingUnderRootOwnedWork();
    try {
      await expect(checkoutRepository(request())).resolves.toMatchObject({
        status: "already_current",
      });
      expect(fs.existsSync(repoDir)).toBe(true);
      // Not removable by the host alone; a later sweep gets another try.
      expect(fs.existsSync(sibling)).toBe(true);
    } finally {
      fs.chmodSync(owner, 0o755);
    }
  });

  it("asks the supervisor for a layer the host cannot create, then sweeps", async () => {
    const { sibling, owner, repoDir } = staleSiblingUnderRootOwnedWork();
    const log = fakeLauncher(path.dirname(path.dirname(repoDir)), { rootOwnedWork: true });
    try {
      const swept = await sweepExpiredCheckouts();

      expect(swept.removed).toContain(sibling);
      expect(fs.existsSync(sibling)).toBe(false);
      expect(fs.readFileSync(log, "utf8")).toContain("maintenance reset-work-layer");
    } finally {
      fs.chmodSync(owner, 0o755);
    }
  });

  it("removes a staging tree orphaned by a crashed clone", async () => {
    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    const orphan = path.join(root, ".staging", "clone-1-1");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "partial"), "x");
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(orphan, old, old);

    const swept = await sweepExpiredCheckouts();
    expect(swept.removed).toContain(orphan);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe("a GitLab checkout in the host-named layout", () => {
  /** A real upstream cloned into where a GitLab checkout lives, so the refresh
   *  path runs against actual git under a nested group path. */
  function gitlabUpstreamAndCheckout(): { origin: string; repoDir: string; root: string } {
    const origin = scratch("magister-origin-");
    git(origin, "init", "--quiet", "--initial-branch=main");
    fs.writeFileSync(path.join(origin, "README.md"), "first\n");
    git(origin, "add", "README.md");
    git(origin, "commit", "--quiet", "-m", "first");

    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    const repoDir = path.join(root, "gitlab.com", "group", "sub", "project");
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    git(root, "clone", "--quiet", "--depth", "1", `file://${origin}`, repoDir);
    return { origin, repoDir, root };
  }

  const gitlab = (overrides: Record<string, unknown> = {}) =>
    request({ repo: "group/sub/project", provider: "gitlab", token: "glpat_test", ...overrides });

  it("refreshes in place and reports its host and nested path", async () => {
    const { origin, repoDir } = gitlabUpstreamAndCheckout();
    fs.writeFileSync(path.join(origin, "README.md"), "second\n");
    git(origin, "commit", "--quiet", "-am", "second");

    const receipt = await checkoutRepository(gitlab());
    expect(receipt.status).toBe("refreshed");
    expect(receipt.provider).toBe("gitlab");
    expect(receipt.repo).toBe("group/sub/project");
    expect(receipt.path).toBe(repoDir);
    expect(fs.readFileSync(path.join(repoDir, "README.md"), "utf8")).toBe("second\n");
  });

  it("authenticates as the host's own fixed username, not GitHub's", async () => {
    const { root } = gitlabUpstreamAndCheckout();
    await checkoutRepository(gitlab());
    const helper = fs.readFileSync(path.join(root, ".staging", "askpass-oauth2.sh"), "utf8");
    expect(helper).toContain("'oauth2'");
    expect(helper).not.toContain("x-access-token");
    // The credential itself is never written into the helper.
    expect(helper).not.toContain("glpat_test");
    expect(fs.existsSync(path.join(root, ".staging", "askpass-x-access-token.sh"))).toBe(false);
  });

  it("is found by the sweeper under its nested path and leaves no empty group directories behind", async () => {
    const { repoDir, root } = gitlabUpstreamAndCheckout();
    const stale = new Date(Date.now() - CHECKOUT_TTL_MS - 60_000).toISOString();
    fs.writeFileSync(
      path.join(repoDir, ".git", "magister-checkout.json"),
      JSON.stringify({ last_used_at: stale, repo: "group/sub/project" }),
    );

    const swept = await sweepExpiredCheckouts();
    expect(swept.removed).toContain(repoDir);
    expect(fs.existsSync(path.join(root, "gitlab.com"))).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("is never swept while an operation on it is in flight", async () => {
    const { repoDir } = gitlabUpstreamAndCheckout();
    git(repoDir, "checkout", "--quiet", "--detach", "HEAD");
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    // The lock key and the sweeper's key must agree on a nested GitLab path,
    // or the sweeper would delete the tree a prepare is standing in.
    const pending = prepareRepoCommit(prepare({ repo: "group/sub/project", provider: "gitlab" }));

    const swept = await sweepExpiredCheckouts(Date.now() + CHECKOUT_TTL_MS * 2);

    expect(swept.removed).toEqual([]);
    await expect(pending).resolves.toMatchObject({ status: "prepared" });
    expect(fs.existsSync(repoDir)).toBe(true);
  });

  it("keeps the two layouts apart: the same path on GitHub is a different checkout", async () => {
    const { root } = gitlabUpstreamAndCheckout();
    await expect(
      prepareRepoCommit(prepare({ repo: "group/sub", provider: "github", message: "x" })),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not checked out"),
    });
    expect(fs.existsSync(path.join(root, "group"))).toBe(false);
  });
});

describe("branch validation", () => {
  it("accepts ordinary branch names", () => {
    expect(parseBranch("magister/readme")).toBe("magister/readme");
    expect(parseBranch("fix-1.2")).toBe("fix-1.2");
  });

  it("rejects a value that would nest inside refs/heads twice", () => {
    // `refs/heads/x` becomes `refs/heads/refs/heads/x` when interpolated.
    expect(() => parseBranch("refs/heads/main")).toThrow(CheckoutError);
  });

  it("rejects git's own reserved ref shapes and argv injection", () => {
    for (const value of ["-x", "a..b", "feature.lock", "feature/.hidden", "a//b", ""]) {
      expect(() => parseBranch(value)).toThrow(CheckoutError);
    }
  });

  it("rejects a commit SHA, which is a ref but never a branch to create", () => {
    expect(() => parseBranch("a".repeat(40))).toThrow(CheckoutError);
  });
});

describe("push request parsing", () => {
  it("requires a full SHA and a credential, and rejects unknown fields", () => {
    expect(() => parsePushRequest({ ...push(), commit_sha: "abc123" })).toThrow(/40-character/);
    expect(() =>
      parsePushRequest({ repo: "acme/site", branch: "b", commit_sha: "a".repeat(40) }),
    ).toThrow(/credential/);
    expect(() => parsePushRequest({ ...push(), commit_sha: "a".repeat(40), extra: 1 })).toThrow(
      /unknown fields/,
    );
  });

  it("treats an absent expected_remote_sha as 'this branch must not exist'", () => {
    const parsed = parsePushRequest({ ...push(), commit_sha: "a".repeat(40) });
    expect(parsed.expected_remote_sha).toBeUndefined();
  });
});

describe("preparing a commit", () => {
  it("freezes the working tree and reports the change against the checkout base", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const base = git(repoDir, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    fs.writeFileSync(path.join(repoDir, "NEW.md"), "new\n");

    const receipt = await prepareRepoCommit(prepare());

    expect(receipt.status).toBe("prepared");
    expect(receipt.base_sha).toBe(base);
    expect(receipt.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.commit_sha).not.toBe(base);
    expect(receipt.changed_file_count).toBe(2);
    expect(receipt.changed_files).toEqual(
      expect.arrayContaining([
        { path: "README.md", change: "modified" },
        { path: "NEW.md", change: "added" },
      ]),
    );
    expect(git(repoDir, "status", "--porcelain").trim()).toBe("");
  });

  it("attributes the commit to the agent, never to the connected user", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    await prepareRepoCommit(prepare());
    expect(git(repoDir, "log", "-1", "--format=%ae").trim()).toBe(COMMIT_AUTHOR_EMAIL);
    expect(git(repoDir, "log", "-1", "--format=%ce").trim()).toBe(COMMIT_AUTHOR_EMAIL);
  });

  it("refuses when the agent has not changed anything", async () => {
    bareUpstreamAndCheckout();
    await expect(prepareRepoCommit(prepare())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("nothing to commit"),
    });
  });

  it("repeats as already_prepared instead of creating an empty second commit", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    const first = await prepareRepoCommit(prepare());

    const again = await prepareRepoCommit(prepare());

    expect(again.status).toBe("already_prepared");
    expect(again.commit_sha).toBe(first.commit_sha);
    expect(again.changed_file_count).toBe(1);
    expect(git(repoDir, "rev-list", "--count", "HEAD").trim()).toBe("2");
  });

  it("never commits what the repository's own .gitignore excludes", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(repoDir, ".env"), "SECRET=1\n");

    const receipt = await prepareRepoCommit(prepare());

    expect(receipt.changed_files.map((entry) => entry.path)).toEqual([".gitignore"]);
  });

  it("stacks a second commit and still reports the whole change set", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const base = git(repoDir, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repoDir, "one.md"), "1\n");
    await prepareRepoCommit(prepare({ message: "first pass" }));
    fs.writeFileSync(path.join(repoDir, "two.md"), "2\n");

    const receipt = await prepareRepoCommit(prepare({ message: "second pass" }));

    expect(receipt.base_sha).toBe(base);
    expect(receipt.changed_file_count).toBe(2);
  });

  it("refuses to prepare a repository that is not checked out", async () => {
    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    await expect(prepareRepoCommit(prepare())).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("manifest paths address real files", () => {
  it("keeps a non-ASCII path verbatim, sizes it, and widens its read bits", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const name = "docs/café — ⚙.md";
    fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, name), "hello\n");
    fs.chmodSync(path.join(repoDir, "docs"), 0o750);
    fs.chmodSync(path.join(repoDir, name), 0o640);

    const receipt = await prepareRepoCommit(prepare());

    // git's default --name-status would have reported this as
    // `"docs/caf\303\251 ..."`, which matches no file on disk — so the byte
    // budget would have skipped it and its permissions would never have moved.
    expect(receipt.changed_files).toEqual([{ path: name, change: "added" }]);
    expect(receipt.byte_size).toBe(6);
    expect(fs.statSync(path.join(repoDir, name)).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(repoDir, "docs")).mode & 0o777).toBe(0o755);
  });

  it("widens every directory it created, not only the file inside them", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.mkdirSync(path.join(repoDir, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "deep", "index.ts"), "export {};\n");
    fs.chmodSync(path.join(repoDir, "src", "deep", "index.ts"), 0o640);
    fs.chmodSync(path.join(repoDir, "src", "deep"), 0o750);
    fs.chmodSync(path.join(repoDir, "src"), 0o750);

    await prepareRepoCommit(prepare());

    // A 0750 folder is untraversable for the sandbox user, so a correctly
    // permissioned file inside one is still unreachable.
    expect(fs.statSync(path.join(repoDir, "src")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(repoDir, "src", "deep")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(repoDir, "src", "deep", "index.ts")).mode & 0o777).toBe(0o644);
  });

  it("shortens a long path in the receipt only, keeping the file name", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const segment = "d".repeat(60);
    const relative = path.join(segment, segment, segment, segment, "config.json");
    expect(relative.length).toBeGreaterThan(MAX_MANIFEST_PATH_CHARS);
    fs.mkdirSync(path.dirname(path.join(repoDir, relative)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, relative), "{}\n");
    fs.chmodSync(path.join(repoDir, relative), 0o600);

    const receipt = await prepareRepoCommit(prepare());

    const entry = receipt.changed_files[0];
    expect(entry?.path).toHaveLength(MAX_MANIFEST_PATH_CHARS);
    expect(entry?.path.startsWith("…")).toBe(true);
    expect(entry?.path.endsWith("config.json")).toBe(true);
    // Cosmetic only: the whole path was still measured and widened.
    expect(receipt.byte_size).toBe(3);
    expect(fs.statSync(path.join(repoDir, relative)).mode & 0o777).toBe(0o644);
  });
});

describe("refreshing a checkout that holds frozen work", () => {
  it("refuses, because a prepared commit leaves the tree clean", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    const prepared = await prepareRepoCommit(prepare());

    await expect(checkoutRepository(request())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("never pushed"),
    });
    expect(git(repoDir, "rev-parse", "HEAD").trim()).toBe(prepared.commit_sha);
  });

  it("discards it only on an explicit request, and resets the base", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const base = git(repoDir, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    const prepared = await prepareRepoCommit(prepare());

    await checkoutRepository(request({ discard_local_changes: true }));

    expect(git(repoDir, "rev-parse", "HEAD").trim()).toBe(base);
    await expect(pushRepoBranch(push({ commit_sha: prepared.commit_sha }))).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("pushing a branch", () => {
  async function prepared(): Promise<{
    origin: string;
    seed: string;
    repoDir: string;
    sha: string;
  }> {
    const context = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(context.repoDir, "README.md"), "edited\n");
    const receipt = await prepareRepoCommit(prepare());
    return { ...context, sha: receipt.commit_sha };
  }

  it("creates the branch and verifies it by reading the remote back", async () => {
    const { origin, sha } = await prepared();

    const receipt = await pushRepoBranch(push({ commit_sha: sha }));

    expect(receipt.status).toBe("pushed");
    expect(receipt.verified_sha).toBe(sha);
    expect(receipt.previous_remote_sha).toBeNull();
    expect(receipt.default_branch).toBe("main");
    expect(receipt.pull_request_url).toContain("compare/main...magister/readme");
    expect(remoteTip(origin, "magister/readme")).toBe(sha);
  });

  it("reports already_pushed when the branch is already at that commit", async () => {
    const { sha } = await prepared();
    await pushRepoBranch(push({ commit_sha: sha }));

    // The retry after a lost response must not trip the "branch exists" rule
    // that its own successful push created.
    const receipt = await pushRepoBranch(push({ commit_sha: sha }));

    expect(receipt.status).toBe("already_pushed");
    expect(receipt.verified_sha).toBe(sha);
  });

  it("refuses the default branch", async () => {
    const { sha } = await prepared();
    await expect(pushRepoBranch(push({ branch: "main", commit_sha: sha }))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("default branch"),
    });
  });

  it("refuses a branch this checkout did not create", async () => {
    const { origin, sha } = await prepared();
    git(origin, "branch", "human-work", "main");

    await expect(
      pushRepoBranch(push({ branch: "human-work", commit_sha: sha })),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not created by this checkout"),
    });
    expect(remoteTip(origin, "human-work")).not.toBe(sha);
  });

  it("refuses an expected SHA for a branch that does not exist yet", async () => {
    const { sha } = await prepared();
    await expect(
      pushRepoBranch(push({ commit_sha: sha, expected_remote_sha: "b".repeat(40) })),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("compares and swaps when updating a branch it already owns", async () => {
    const { origin, repoDir, sha } = await prepared();
    await pushRepoBranch(push({ commit_sha: sha }));
    fs.writeFileSync(path.join(repoDir, "SECOND.md"), "second\n");
    const next = await prepareRepoCommit(prepare({ message: "second pass" }));

    await expect(
      pushRepoBranch(push({ commit_sha: next.commit_sha, expected_remote_sha: "c".repeat(40) })),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("has moved") });

    const receipt = await pushRepoBranch(
      push({ commit_sha: next.commit_sha, expected_remote_sha: sha }),
    );
    expect(receipt.status).toBe("pushed");
    expect(remoteTip(origin, "magister/readme")).toBe(next.commit_sha);
  });

  it("cannot overwrite work that landed on its own branch, because it never forces", async () => {
    const { origin, seed, repoDir, sha } = await prepared();
    await pushRepoBranch(push({ commit_sha: sha }));
    // Someone else advances the branch to an unrelated commit.
    fs.writeFileSync(path.join(seed, "THEIRS.md"), "theirs\n");
    git(seed, "add", "THEIRS.md");
    git(seed, "commit", "--quiet", "-m", "theirs");
    git(seed, "push", "--quiet", "--force", `file://${origin}`, "main:magister/readme");
    const theirs = remoteTip(origin, "magister/readme");

    fs.writeFileSync(path.join(repoDir, "OURS.md"), "ours\n");
    const next = await prepareRepoCommit(prepare({ message: "ours" }));

    await expect(
      pushRepoBranch(push({ commit_sha: next.commit_sha, expected_remote_sha: theirs ?? "" })),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(remoteTip(origin, "magister/readme")).toBe(theirs);
  });

  it("refuses a commit that was never frozen here", async () => {
    await prepared();
    await expect(pushRepoBranch(push({ commit_sha: "d".repeat(40) }))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("not prepared"),
    });
  });
});

describe("the CI guard at push time", () => {
  /** A bare remote whose default branch is `main`, plus a checkout of `ref`
   *  (full history when `depth` is null), detached as the host leaves it. */
  function checkoutOf(options: {
    ref?: string;
    depth?: number | null;
    provider?: "github" | "gitlab";
    seedFiles?: Record<string, string>;
  }): { origin: string; seed: string; repoDir: string } {
    const seed = scratch("magister-seed-");
    git(seed, "init", "--quiet", "--initial-branch=main");
    fs.writeFileSync(path.join(seed, "README.md"), "first\n");
    git(seed, "add", "README.md");
    git(seed, "commit", "--quiet", "-m", "first");
    const origin = scratch("magister-bare-");
    git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
    git(seed, "push", "--quiet", `file://${origin}`, "main");
    if (options.ref) {
      git(seed, "checkout", "--quiet", "-b", options.ref);
      for (const [file, body] of Object.entries(options.seedFiles ?? {})) {
        fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
        fs.writeFileSync(path.join(seed, file), body);
        git(seed, "add", file);
      }
      git(seed, "commit", "--quiet", "-m", "branch work");
      git(seed, "push", "--quiet", `file://${origin}`, options.ref);
    }

    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    const provider = options.provider ?? "github";
    const repoDir = resolveRepoDir(parseRepo("acme/site", provider));
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    const depth = options.depth === undefined ? 1 : options.depth;
    git(
      root,
      "clone",
      "--quiet",
      ...(depth === null ? [] : ["--depth", String(depth)]),
      ...(options.ref ? ["--branch", options.ref] : []),
      `file://${origin}`,
      repoDir,
    );
    git(repoDir, "checkout", "--quiet", "--detach", "HEAD");
    return { origin, seed, repoDir };
  }

  function write(repoDir: string, file: string, body = "x\n"): void {
    fs.mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, file), body);
  }

  it("matches the Gateway's CI paths after normalising, and refuses `..`", () => {
    expect(CI_DEFINITION_PATHS.github.map(([, exact]) => exact)).toEqual([
      ".github/workflows",
      ".github/actions",
    ]);
    for (const file of [
      ".github/workflows/a.yml",
      ".github/actions/x/action.yml",
      "./.github//workflows/a.yml",
      ".GitHub/Workflows/a.yml",
      "a/../.github/workflows/b.yml",
    ]) {
      expect(isCiDefinition(file, "github")).toBe(true);
    }
    for (const file of [".gitlab-ci.yml", ".GitLab-CI.yml", ".gitlab/ci/build.yml"]) {
      expect(isCiDefinition(file, "gitlab")).toBe(true);
    }
    expect(isCiDefinition("deploy/pipeline.yml", "gitlab", "deploy/pipeline.yml")).toBe(true);
    expect(isCiDefinition("deploy/pipeline.yml", "gitlab")).toBe(false);
    expect(isCiDefinition("docs/workflows.md", "github")).toBe(false);
    expect(isCiDefinition(".github/CODEOWNERS", "github")).toBe(false);
    expect(normalizeRepoPath("./A//b/./C.yml")).toBe("a/b/c.yml");
    expect(normalizeRepoPath("a/../b")).toBeNull();
  });

  it("refuses a workflow the remote branch head does not have", async () => {
    const { origin, repoDir } = checkoutOf({});
    write(repoDir, "README.md", "edited\n");
    const first = await prepareRepoCommit(prepare());
    await pushRepoBranch(push({ commit_sha: first.commit_sha }));

    write(repoDir, ".github/workflows/ci.yml", "on: push\n");
    const next = await prepareRepoCommit(prepare({ message: "add ci" }));

    await expect(
      pushRepoBranch(push({ commit_sha: next.commit_sha, expected_remote_sha: first.commit_sha })),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(".github/workflows/ci.yml"),
    });
    expect(remoteTip(origin, "magister/readme")).toBe(first.commit_sha);
  });

  it("refuses a new branch whose base the remote no longer holds when it carries a workflow", async () => {
    // The checkout's base adds the workflow; its branch is then deleted, so the
    // prepared commit's own change set (README only) says nothing about it.
    const { origin, repoDir } = checkoutOf({
      ref: "feature",
      depth: null,
      seedFiles: { ".github/workflows/deploy.yml": "on: push\n" },
    });
    git(origin, "branch", "-D", "feature");
    write(repoDir, "README.md", "edited\n");
    const receipt = await prepareRepoCommit(prepare());
    expect(receipt.changed_files).toEqual([{ path: "README.md", change: "modified" }]);

    await expect(pushRepoBranch(push({ commit_sha: receipt.commit_sha }))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(".github/workflows/deploy.yml"),
    });
    expect(remoteTip(origin, "magister/readme")).toBeNull();
  });

  it("refuses a shallow checkout's workflow from a base the remote no longer holds", async () => {
    const { origin, repoDir } = checkoutOf({
      ref: "feature",
      depth: 1,
      seedFiles: { ".github/workflows/deploy.yml": "on: push\n" },
    });
    git(origin, "branch", "-D", "feature");
    write(repoDir, "README.md", "edited\n");
    const receipt = await prepareRepoCommit(prepare());

    await expect(pushRepoBranch(push({ commit_sha: receipt.commit_sha }))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(".github/workflows/deploy.yml"),
    });
    expect(remoteTip(origin, "magister/readme")).toBeNull();
  });

  it("refuses a new branch cut from an old commit whose workflow the default branch has since changed", async () => {
    // The base holds workflow v1; main then moves to v2. The prepared commit
    // touches only the README, and its merge base with main is the base
    // itself, so only a tree-to-tree comparison sees the branch would run v1.
    const { origin, seed, repoDir } = checkoutOf({
      ref: "feature",
      depth: null,
      seedFiles: { ".github/workflows/deploy.yml": "on: push # v1\n" },
    });
    git(seed, "checkout", "--quiet", "main");
    git(seed, "merge", "--quiet", "--ff-only", "feature");
    fs.writeFileSync(path.join(seed, ".github/workflows/deploy.yml"), "on: push # v2\n");
    git(seed, "commit", "--quiet", "-am", "workflow v2");
    git(seed, "push", "--quiet", `file://${origin}`, "main");
    git(origin, "branch", "-D", "feature");
    write(repoDir, "README.md", "edited\n");
    const receipt = await prepareRepoCommit(prepare());

    await expect(pushRepoBranch(push({ commit_sha: receipt.commit_sha }))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(".github/workflows/deploy.yml"),
    });
    expect(remoteTip(origin, "magister/readme")).toBeNull();
  });

  it("pushes a clean change, including an ordinary file under .github", async () => {
    const { origin, repoDir } = checkoutOf({});
    write(repoDir, "README.md", "edited\n");
    write(repoDir, ".github/CODEOWNERS", "* @acme\n");
    const receipt = await prepareRepoCommit(prepare());

    const pushed = await pushRepoBranch(push({ commit_sha: receipt.commit_sha }));

    expect(pushed.status).toBe("pushed");
    expect(remoteTip(origin, "magister/readme")).toBe(receipt.commit_sha);
  });

  it("refuses a GitLab project's own pipeline file when the Gateway names it", async () => {
    const { origin, repoDir } = checkoutOf({ provider: "gitlab" });
    write(repoDir, "deploy/Pipeline.yml", "stages: []\n");
    const receipt = await prepareRepoCommit(prepare({ provider: "gitlab" }));

    const request = push({
      provider: "gitlab",
      token: "glpat_test",
      commit_sha: receipt.commit_sha,
    });
    await expect(
      pushRepoBranch({ ...request, ci_config_path: "deploy/pipeline.yml" }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("CI definition") });
    expect(remoteTip(origin, "magister/readme")).toBeNull();

    // Without a custom pipeline file it is an ordinary file.
    const pushed = await pushRepoBranch(request);
    expect(pushed.status).toBe("pushed");
  });

  it("accepts a GitLab pipeline path only for GitLab, normalised, never with `..`", () => {
    const base = { ...push(), commit_sha: "a".repeat(40) };
    expect(
      parsePushRequest({ ...base, provider: "gitlab", ci_config_path: "./Deploy//CI.yml" })
        .ci_config_path,
    ).toBe("deploy/ci.yml");
    expect(parsePushRequest({ ...base, provider: "gitlab" }).ci_config_path).toBeUndefined();
    expect(() => parsePushRequest({ ...base, ci_config_path: "ci.yml" })).toThrow(
      /only meaningful/,
    );
    expect(() =>
      parsePushRequest({ ...base, provider: "gitlab", ci_config_path: "a/../ci.yml" }),
    ).toThrow(CheckoutError);
  });
});

describe("CI code the definitions name from elsewhere in the tree", () => {
  /** A bare remote whose default branch `main` holds `files`, and a checkout of it. */
  function checkoutWith(
    files: Record<string, string>,
    provider: "github" | "gitlab" = "github",
  ): { origin: string; repoDir: string } {
    const seed = scratch("magister-seed-");
    git(seed, "init", "--quiet", "--initial-branch=main");
    for (const [file, body] of Object.entries({ "README.md": "first\n", ...files })) {
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      fs.writeFileSync(path.join(seed, file), body);
    }
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", "first");
    const origin = scratch("magister-bare-");
    git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
    git(seed, "push", "--quiet", `file://${origin}`, "main");
    process.env.MAGISTER_REPO_ROOT = scratch("magister-repos-");
    const repoDir = resolveRepoDir(parseRepo("acme/site", provider));
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    git(path.dirname(repoDir), "clone", "--quiet", "--depth", "1", `file://${origin}`, repoDir);
    git(repoDir, "checkout", "--quiet", "--detach", "HEAD");
    return { origin, repoDir };
  }

  async function pushEdit(
    repoDir: string,
    file: string,
    provider: "github" | "gitlab" = "github",
  ): Promise<unknown> {
    fs.mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, file), "edited\n");
    const receipt = await prepareRepoCommit(prepare({ provider }));
    return pushRepoBranch(
      push({
        provider,
        commit_sha: receipt.commit_sha,
        ...(provider === "gitlab" ? { token: "glpat_test" } : {}),
      }),
    );
  }

  const WORKFLOW = [
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: ./ci/setup # the team's composite action",
    "",
  ].join("\n");
  const COMPOSITE = [
    "runs:",
    "  using: composite",
    "  steps:",
    "    - run: ${{ github.action_path }}/install.sh",
    "      shell: bash",
    "    - uses: './tools/lint'",
    "",
  ].join("\n");

  const workflow = (steps: string) =>
    `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;

  it("reads the local actions a workflow runs, in every YAML spelling", () => {
    expect(workflowActionDirs(WORKFLOW, "acme/site")).toEqual(["ci/setup"]);
    expect(
      workflowActionDirs(
        workflow(
          [
            "      # - uses: ./retired",
            '      - { uses: "./Flow/Step", with: { a: 1 } }',
            '      - "uses": ./quoted',
            "      - uses: docker://alpine:3",
            "      - uses: ./",
            "      - uses: actions/checkout@v4",
            "      - uses: ACME/Site/tools/lint@main",
            "      - uses: >-",
            "          ./folded",
          ].join("\n"),
        ),
        "acme/site",
      ),
    ).toEqual(["flow/step", "quoted", "", "tools/lint", "folded"]);
    // Two steps on one line, and steps reached through an anchor.
    expect(
      workflowActionDirs(
        [
          "jobs:",
          "  a:",
          "    steps: &shared [{uses: ./one}, {uses: ./two}]",
          "  b:",
          "    steps: *shared",
          "  c:",
          "    uses: ./.github/workflows/reusable.yml",
          "",
        ].join("\n"),
        "acme/site",
      ),
    ).toEqual(["one", "two", "one", "two", ".github/workflows/reusable.yml"]);
    expect(workflowActionDirs("on: push\n", "acme/site")).toEqual([]);
  });

  it("refuses a workflow it cannot read with certainty", () => {
    for (const unreadable of [
      workflow("      - uses: ./../outside"),
      workflow("      - uses: *setup"),
      workflow("      - uses: ./${{ matrix.action }}"),
      workflow("      - uses: $ACTION"),
      workflow("      - uses: 42"),
      workflow("      - uses: not-an-action"),
      workflow("      - uses: ./a\n      - uses: ./b\n    steps: []"),
      "jobs: [build]\n",
      "jobs:\n  build: run\n",
      "jobs:\n  build:\n    steps: notalist\n",
      "jobs:\n  build:\n    steps:\n      - just a string\n",
      "jobs:\n  build:\n    steps: [{uses: ./x",
      "jobs:\n  build:\n    steps:\n      - uses: !custom ./x\n",
      "jobs:\n  ? [a, b]\n  : {}\n",
    ]) {
      expect(workflowActionDirs(unreadable, "acme/site")).toBeNull();
    }
  });

  it("reads what an action manifest runs, from its own directory", () => {
    expect(actionManifestReferences(COMPOSITE, "ci/setup", "acme/site")).toEqual({
      dirs: ["tools/lint"],
      files: [],
    });
    expect(
      actionManifestReferences(
        [
          "runs:",
          "  using: node20",
          "  main: dist/index.js",
          "  pre: ../../outside.js",
          "  post: ./cleanup.js",
          "",
        ].join("\n"),
        "ci/setup",
        "acme/site",
      ),
    ).toEqual({ dirs: [], files: ["ci/setup/dist/index.js", "outside.js", "ci/setup/cleanup.js"] });
    expect(
      actionManifestReferences(
        [
          "runs:",
          "  using: docker",
          "  image: ../shared/Dockerfile",
          "  entrypoint: entrypoint.sh",
          "  post-entrypoint: /usr/bin/cleanup",
          "",
        ].join("\n"),
        "ci/docker",
        "acme/site",
      ),
    ).toEqual({ dirs: [], files: ["ci/shared/dockerfile", "ci/docker/entrypoint.sh"] });
    expect(
      actionManifestReferences(
        "runs:\n  using: docker\n  image: docker://alpine\n",
        "",
        "acme/site",
      ),
    ).toEqual({ dirs: [], files: [] });
    expect(actionManifestReferences("name: no runs\n", "ci/x", "acme/site")).toEqual({
      dirs: [],
      files: [],
    });
  });

  it("refuses an action manifest it cannot read with certainty", () => {
    for (const unreadable of [
      "runs:\n  using: node20\n  main: ../../../escapes.js\n",
      "runs:\n  using: node20\n  main: $MAIN\n",
      "runs:\n  using: [composite]\n",
      "runs:\n  using: composite\n  steps:\n    - uses: ./${{ inputs.action }}\n",
      "runs:\n  using: composite\n  steps: {uses: ./x}\n",
      "runs: composite\n",
      "runs:\n  main: a.js\nruns:\n  main: b.js\n",
    ]) {
      expect(actionManifestReferences(unreadable, "ci/setup", "acme/site")).toBeNull();
    }
  });

  it("reads a GitLab pipeline's local includes, in every form and at any depth", () => {
    const pipeline = [
      "spec:",
      "  inputs:",
      "    stage:",
      "      default: test",
      "---",
      "include:",
      "  - local: '/templates/build.yml'",
      "    rules:",
      '      - if: $CI_COMMIT_BRANCH == "main"',
      "  - '/templates/test.yml'",
      "  - remote: 'https://example.com/ci.yml'",
      "  - project: 'group/other'",
      "    ref: main",
      "    file:",
      "      - '/shared.yml'",
      "  - template: Auto-DevOps.gitlab-ci.yml",
      "  - artifact: generated.yml",
      "    job: generate",
      ".child: &child",
      "  trigger:",
      "    include: ci/child-*.yml",
      "deploy:",
      "  <<: *child",
      "  stage: $[[ inputs.stage ]]",
      "nested:",
      "  deeper:",
      "    trigger:",
      "      include: { local: configs/**.yml }",
      "",
    ].join("\n");
    // The hidden `.child` template and the job merged from it both carry the include.
    expect(pipelineIncludes(pipeline, "acme/site")).toEqual([
      "templates/build.yml",
      "templates/test.yml",
      "ci/child-*.yml",
      "ci/child-*.yml",
      "configs/**.yml",
    ]);
    expect(pipelineIncludes("include: [a.yml, {local: b.yml}]\n", "acme/site")).toEqual([
      "a.yml",
      "b.yml",
    ]);
    expect(pipelineIncludes("include: 'https://example.com/ci.yml'\n", "acme/site")).toEqual([]);
    expect(pipelineIncludes("", "acme/site")).toEqual([]);
  });

  it("refuses a pipeline it cannot read with certainty", () => {
    for (const unreadable of [
      "include:\n  - local: $CI_DIR/build.yml\n",
      "include:\n  - project: acme/site\n    file: /ci.yml\n",
      "include:\n  - project: /ACME/Site/\n    file: /ci.yml\n",
      "include:\n  - project: $CI_PROJECT_PATH\n    file: /ci.yml\n",
      "include:\n  - project: group/other\n    file: $FILE\n",
      "include:\n  - project: group/other\n    ref: $REF\n    file: /ci.yml\n",
      "include:\n  - component: $CI_SERVER_FQDN/acme/site/comp@1.0\n",
      "include:\n  - component: gitlab.com/acme/site/comp@1.0\n",
      "include:\n  - local: ../outside.yml\n",
      "include:\n  - local: a.yml\n    unknown: 1\n",
      "include: 1\n",
      "include:\n",
      "include: [a.yml\n",
      "include: a.yml\ninclude: b.yml\n",
      "include: *missing\n",
      "build:\n  script: !reference [.base, script]\n",
      "deploy:\n  trigger:\n    include: [{local: a.yml}, 3]\n",
    ]) {
      expect(pipelineIncludes(unreadable, "acme/site")).toBeNull();
    }
    expect(
      pipelineIncludes("include:\n  - component: gitlab.com/group/other/comp@1.0\n", "acme/site"),
    ).toEqual([]);
  });

  it("refuses a push that edits a local action a workflow runs, outside .github", async () => {
    const { origin, repoDir } = checkoutWith({
      ".github/workflows/ci.yml": WORKFLOW,
      "ci/setup/action.yml": COMPOSITE,
      "ci/setup/install.sh": "echo setup\n",
      "tools/lint/action.yaml": "runs:\n  using: node20\n  main: index.js\n",
      "tools/lint/index.js": "lint()\n",
    });

    await expect(pushEdit(repoDir, "ci/setup/install.sh")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("ci/setup/install.sh is, or may be, a CI definition"),
    });
    expect(remoteTip(origin, "magister/readme")).toBeNull();
  });

  it("follows a local action into the actions it runs", async () => {
    const { origin, repoDir } = checkoutWith({
      ".github/workflows/ci.yml": WORKFLOW,
      "ci/setup/action.yml": COMPOSITE,
      "tools/lint/action.yaml": "runs:\n  using: node20\n  main: index.js\n",
      "tools/lint/index.js": "lint()\n",
    });

    await expect(pushEdit(repoDir, "tools/lint/index.js")).rejects.toMatchObject({
      message: expect.stringContaining("tools/lint/index.js"),
    });
    expect(remoteTip(origin, "magister/readme")).toBeNull();
  });

  it("refuses a push that edits a file a manifest's runs names outside its directory", async () => {
    const { origin, repoDir } = checkoutWith({
      ".github/workflows/ci.yml": "jobs:\n  build:\n    steps: [{uses: ./ci/setup}]\n",
      "ci/setup/action.yml": "runs:\n  using: node20\n  main: ../../outside.js\n",
      "outside.js": "run()\n",
    });

    await expect(pushEdit(repoDir, "outside.js")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("outside.js is, or may be, a CI definition"),
    });
    expect(remoteTip(origin, "magister/readme")).toBeNull();
  });

  it("refuses an action manifest anywhere, and pushes code no definition names", async () => {
    const manifest = checkoutWith({ ".github/workflows/ci.yml": WORKFLOW });
    await expect(pushEdit(manifest.repoDir, "packages/deploy/action.yml")).rejects.toMatchObject({
      message: expect.stringContaining("packages/deploy/action.yml"),
    });

    const clean = checkoutWith({ ".github/workflows/ci.yml": WORKFLOW });
    await expect(pushEdit(clean.repoDir, "src/app.ts")).resolves.toMatchObject({
      status: "pushed",
    });
  });

  it("refuses a push that edits a file the GitLab pipeline includes, nested or by wildcard", async () => {
    const files = {
      ".gitlab-ci.yml": "include:\n  - local: ci/build.yml\n  - local: 'ci/jobs/*.yml'\n",
      "ci/build.yml": "include: '/scripts/more.yml'\n",
      "ci/jobs/test.yml": "test:\n  script: [make test]\n",
      "scripts/more.yml": "lint:\n  script: [make lint]\n",
    };
    for (const file of ["ci/build.yml", "scripts/more.yml", "ci/jobs/deploy.yml"]) {
      const { origin, repoDir } = checkoutWith(files, "gitlab");
      await expect(pushEdit(repoDir, file, "gitlab")).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(`${file} is, or may be, a CI definition`),
      });
      expect(remoteTip(origin, "magister/readme")).toBeNull();
    }

    const { repoDir } = checkoutWith(files, "gitlab");
    await expect(pushEdit(repoDir, "README.md", "gitlab")).resolves.toMatchObject({
      status: "pushed",
    });
  });

  it("refuses any push when a pipeline's includes cannot be read", async () => {
    const { origin, repoDir } = checkoutWith(
      { ".gitlab-ci.yml": "include: ci/a.yml\ninclude: ci/b.yml\n" },
      "gitlab",
    );

    await expect(pushEdit(repoDir, "README.md", "gitlab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("could not be read"),
    });
    expect(remoteTip(origin, "magister/readme")).toBeNull();
  });
});

describe("prepare with an unusable base", () => {
  it("refuses rather than reporting a commit as having changed nothing", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    // A marker whose base is not a commit: every `base..sha` diff would come
    // back empty and the receipt would claim an empty change set.
    fs.writeFileSync(
      path.join(repoDir, ".git", "magister-checkout.json"),
      JSON.stringify({ last_used_at: new Date().toISOString(), repo: "acme/site", base_sha: "" }),
    );

    await expect(prepareRepoCommit(prepare())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("base commit"),
    });
  });
});

// ── Phase 3.5: the work layer, installs, and evidence ─────────────────────

/** A stand-in for the tool-sandbox launcher: records every invocation and
 *  does, on the real filesystem, what the supervisor's overlay would make
 *  the sandbox's writes look like from the host. */
function fakeLauncher(
  root: string,
  options: { fetchExit?: number; rootOwnedWork?: boolean } = {},
): string {
  const dir = scratch("magister-launcher-");
  const log = path.join(dir, "launcher.log");
  const script = path.join(dir, "launcher.sh");
  const record = String.raw`printf '{"at":"%s","cwd":".","command":"%s","exit_code":0,"duration_ms":5}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LAYER/runs.jsonl"`;
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `ROOT='${root}'`,
      `LOG='${log}'`,
      'W=""; P=""',
      'while [ $# -gt 0 ]; do case "$1" in',
      '  --workspace) W="$2"; shift 2;;',
      '  --profile) P="$2"; shift 2;;',
      "  --attempt|--timeout) shift 2;;",
      "  --) shift; break;;",
      "  *) shift;;",
      "esac; done",
      String.raw`printf '%s %s\n' "$P" "$*" >> "$LOG"`,
      'REL="${W#$ROOT/}"; LAYER="$ROOT/.work/$REL"',
      'case "$P" in',
      `  fetcher) mkdir -p "$LAYER/upper/node_modules"; echo x > "$LAYER/upper/node_modules/.installed"; exit ${options.fetchExit ?? 0};;`,
      `  tool) mkdir -p "$LAYER"; ${record}; exit 0;;`,
      // The real supervisor is root; this stand-in runs as the test user, so
      // it lifts the read-only owner directory a root-owned one stands for.
      `  maintenance) ${options.rootOwnedWork ? 'chmod u+w "$(dirname "$LAYER")";' : ""} if [ "$1" = "remove-work-layer" ]; then rm -rf "$LAYER"; else rm -rf "$LAYER/upper" "$LAYER/work"; mkdir -p "$LAYER/upper"; fi; exit 0;;`,
      "esac",
      "exit 70",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.MAGISTER_TOOL_SANDBOX_LAUNCHER = script;
  return log;
}

function readMarkerFile(repoDir: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(repoDir, ".git", "magister-checkout.json"), "utf8"),
  ) as Record<string, unknown>;
}

async function settled<T>(poll: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await poll();
    if (done(value) || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const install = () =>
  ({ repo: "acme/site", provider: "github" }) as Parameters<typeof installRepoDependencies>[0];

describe("choosing the package manager", () => {
  it("installs only from a lockfile, in a fixed order of precedence", async () => {
    const dir = scratch("magister-pm-");
    expect(await detectPackageManager(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "requirements.txt"), "pytest\n");
    expect((await detectPackageManager(dir))?.name).toBe("pip");
    fs.writeFileSync(path.join(dir, "uv.lock"), "");
    expect((await detectPackageManager(dir))?.name).toBe("uv");
    fs.writeFileSync(path.join(dir, "yarn.lock"), "");
    const classic = await detectPackageManager(dir);
    expect(classic?.name).toBe("yarn");
    expect(classic?.rebuild).toBeNull();
    fs.writeFileSync(path.join(dir, ".yarnrc.yml"), "");
    expect((await detectPackageManager(dir))?.rebuild).toEqual(["corepack", "yarn", "rebuild"]);
    fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
    expect((await detectPackageManager(dir))?.name).toBe("npm");
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    const pnpm = await detectPackageManager(dir);
    expect(pnpm?.name).toBe("pnpm");
    expect(pnpm?.install).toContain("--ignore-scripts");
    expect(pnpm?.install).toContain("--frozen-lockfile");
  });

  it("parses an install request like the other repository requests", () => {
    expect(parseInstallRequest({ repo: "acme/site" })).toEqual({
      repo: "acme/site",
      provider: "github",
      mutation_context: undefined,
    });
    expect(parseInstallRequest({ repo: "g/s/p", provider: "gitlab" }).provider).toBe("gitlab");
    expect(() => parseInstallRequest({ repo: "acme/site", token: "t" })).toThrow(/unknown fields/);
  });
});

describe("installing dependencies", () => {
  it("runs in the background — fetch then rebuild — and answers installing until done", async () => {
    const { repoDir, root } = upstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), '{"lockfileVersion":3}');
    const log = fakeLauncher(root);

    const first = await installRepoDependencies(install());
    expect(first.status).toBe("installing");
    expect(first.poll_after_seconds).toBe(INSTALL_POLL_SECONDS);
    expect(first.manager).toBe("npm");

    const done = await settled(
      () => installRepoDependencies(install()),
      (r) => r.status !== "installing",
    );
    expect(done.status).toBe("installed");
    expect(done.rebuild).toEqual({ ran: true, exit_code: 0 });
    expect(done.installed_at).toBeDefined();
    expect(fs.existsSync(path.join(workLayer(repoDir).upper, "node_modules", ".installed"))).toBe(
      true,
    );

    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toEqual(["fetcher npm ci --no-audit --no-fund", "tool npm rebuild"]);
    expect((readMarkerFile(repoDir).deps as { state: string }).state).toBe("installed");

    // The same lockfile again is a no-op, and says so at once.
    const again = await installRepoDependencies(install());
    expect(again.status).toBe("installed");
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
    await awaitRepositoryIdle("github", "acme/site");
  });

  it("reports a failed install once, then lets the next call retry", async () => {
    const { repoDir, root } = upstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), "{}");
    fakeLauncher(root, { fetchExit: 1 });

    expect((await installRepoDependencies(install())).status).toBe("installing");
    await settled(
      () => Promise.resolve((readMarkerFile(repoDir).deps as { state: string } | undefined)?.state),
      (state) => state === "failed",
    );
    await expect(installRepoDependencies(install())).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("failed"),
    });
    // Reported once: the marker forgot the failure, so this starts over.
    expect((await installRepoDependencies(install())).status).toBe("installing");
    await awaitRepositoryIdle("github", "acme/site");
  });

  it("refuses a checkout with no lockfile rather than resolving unpinned dependencies", async () => {
    const { root } = upstreamAndCheckout();
    fakeLauncher(root);
    await expect(installRepoDependencies(install())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("no lockfile"),
    });
  });
});

describe("the work layer as evidence", () => {
  it('a sandbox-only edit is refused by name, not as "nothing to commit"', async () => {
    // The case the shadow list exists for, and the one path that could not
    // reach it. A formatter or codegen step that touches only tracked files
    // leaves the real tree byte-identical, so `git diff --cached` is empty and
    // prepare threw before any receipt was built — answering "Edit files in
    // the checkout first" to an agent that had just edited files, and inviting
    // it to run the same command again. Verified live on 2026-09-01, right
    // after the work layer became writable at all.
    const { repoDir } = bareUpstreamAndCheckout();
    const layer = workLayer(repoDir);
    fs.mkdirSync(layer.upper, { recursive: true });
    fs.writeFileSync(path.join(layer.upper, "README.md"), "formatted in the sandbox\n");

    await expect(prepareRepoCommit(prepare())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("changed by a command in the sandbox"),
      userAction: expect.stringContaining("README.md"),
    });
    // And the real tree is still untouched — the refusal is about visibility,
    // not about damage.
    expect(git(repoDir, "status", "--porcelain")).toBe("");
  });

  it("an empty checkout still says plainly that nothing was edited", async () => {
    // The generic message must survive for the case it is actually true of,
    // rather than being replaced by the shadow wording for everyone.
    const { repoDir } = bareUpstreamAndCheckout();
    fs.mkdirSync(workLayer(repoDir).upper, { recursive: true });
    await expect(prepareRepoCommit(prepare())).rejects.toMatchObject({
      statusCode: 409,
      userAction: expect.stringContaining("Edit files in the checkout first"),
    });
  });

  it("a freeze names the tracked files the sandbox shadowed and attaches what was run", async () => {
    const { repoDir, origin } = bareUpstreamAndCheckout();
    const layer = workLayer(repoDir);
    fs.mkdirSync(layer.upper, { recursive: true });
    // A formatter in the sandbox rewrote README.md and dropped a new file.
    fs.writeFileSync(path.join(layer.upper, "README.md"), "formatted\n");
    fs.writeFileSync(path.join(layer.upper, "scratch.txt"), "not tracked\n");
    fs.writeFileSync(
      layer.runsLog,
      [
        '{"at":"2026-01-01T00:00:00Z","cwd":".","command":"npm test","exit_code":1,"duration_ms":900}',
        '{"at":"2026-01-01T00:01:00Z","cwd":".","command":"npm test","exit_code":0,"duration_ms":850}',
      ].join("\n") + "\n",
    );
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited by the file tools\n");

    const frozen = await prepareRepoCommit(prepare());
    expect(frozen.shadowed_tracked_files).toEqual([{ path: "README.md", change: "modified" }]);
    expect(frozen.warnings.some((w) => w.includes("not in this commit"))).toBe(true);
    expect(frozen.verification.map((r) => r.exit_code)).toEqual([1, 0]);
    // The committed README is the file-tool edit, never the sandbox's.
    expect(git(repoDir, "show", `${frozen.commit_sha}:README.md`)).toBe(
      "edited by the file tools\n",
    );

    // Only commands since the previous freeze count for the next one.
    fs.appendFileSync(
      layer.runsLog,
      '{"at":"2999-01-01T00:00:00Z","cwd":".","command":"npm run build","exit_code":0,"duration_ms":10}\n',
    );
    fs.writeFileSync(path.join(repoDir, "second.txt"), "more\n");
    const second = await prepareRepoCommit(prepare({ message: "second" }));
    expect(second.verification.map((r) => r.command)).toEqual(["npm run build"]);

    const pushed = await pushRepoBranch(push({ commit_sha: frozen.commit_sha }));
    expect(pushed.verification.map((r) => r.exit_code)).toEqual([1, 0]);
    expect(remoteTip(origin, "magister/readme")).toBe(frozen.commit_sha);
  });

  it("warns when nothing was run, so an unverified push says so", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "changed\n");
    const frozen = await prepareRepoCommit(prepare());
    expect(frozen.verification).toEqual([]);
    expect(frozen.warnings).toEqual([expect.stringContaining("nothing was verified")]);
  });

  it("discarding resets the work layer and forgets installed dependencies", async () => {
    const { repoDir } = upstreamAndCheckout();
    const layer = workLayer(repoDir);
    fs.mkdirSync(path.join(layer.upper, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".git", "magister-checkout.json"),
      JSON.stringify({
        last_used_at: new Date().toISOString(),
        repo: "acme/site",
        deps: {
          manager: "npm",
          lockfile: "package-lock.json",
          sha256: "x",
          state: "installed",
          started_at: "2026-01-01T00:00:00Z",
        },
      }),
    );

    const kept = await checkoutRepository(request());
    expect(kept.status).toBe("already_current");
    expect(fs.existsSync(path.join(layer.upper, "node_modules"))).toBe(true);

    await checkoutRepository(request({ discard_local_changes: true }));
    expect(fs.existsSync(path.join(layer.upper, "node_modules"))).toBe(false);
    expect(readMarkerFile(repoDir).deps).toBeUndefined();
  });

  it("a host operation waits out a running command, then refuses; a dead holder is stale", async () => {
    process.env.MAGISTER_CHECKOUT_LOCK_WAIT_MS = "150";
    const { repoDir } = bareUpstreamAndCheckout();
    const layer = workLayer(repoDir);
    fs.mkdirSync(layer.lock, { recursive: true });
    fs.writeFileSync(
      path.join(layer.lock, "owner.json"),
      JSON.stringify({ owner: "attempt:t", pid: process.pid }),
    );
    fs.writeFileSync(path.join(repoDir, "README.md"), "changed\n");

    await expect(prepareRepoCommit(prepare())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("still running"),
    });
    fs.writeFileSync(
      path.join(layer.lock, "owner.json"),
      JSON.stringify({ owner: "attempt:t", pid: 2 ** 22 - 1 }),
    );
    await expect(prepareRepoCommit(prepare())).resolves.toMatchObject({ status: "prepared" });
    expect(fs.existsSync(layer.lock)).toBe(false);
  });

  it("the sweeper removes a checkout's work layer with it and reclaims an orphaned one", async () => {
    const { repoDir, root } = upstreamAndCheckout();
    const layer = workLayer(repoDir);
    fs.mkdirSync(path.join(layer.upper, "dist"), { recursive: true });
    fs.writeFileSync(path.join(layer.upper, "dist", "bundle.js"), "x");
    const stale = new Date(Date.now() - CHECKOUT_TTL_MS - 60_000).toISOString();
    fs.writeFileSync(
      path.join(repoDir, ".git", "magister-checkout.json"),
      JSON.stringify({ last_used_at: stale, repo: "acme/site" }),
    );
    const orphan = path.join(root, ".work", "acme", "gone", "upper");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "leftover"), "x");

    const swept = await sweepExpiredCheckouts();
    expect(swept.removed).toContain(repoDir);
    expect(fs.existsSync(repoDir)).toBe(false);
    expect(fs.existsSync(layer.root)).toBe(false);
    expect(fs.existsSync(path.dirname(orphan))).toBe(false);
    expect(fs.existsSync(path.join(root, ".work"))).toBe(true);
  });

  it("asks the supervisor, not the host, to reset a layer when there is one", async () => {
    const { repoDir, root } = upstreamAndCheckout();
    const log = fakeLauncher(root);
    fs.mkdirSync(path.join(workLayer(repoDir).upper, "node_modules"), { recursive: true });
    await checkoutRepository(request({ discard_local_changes: true }));
    expect(fs.readFileSync(log, "utf8")).toContain("maintenance reset-work-layer");
  });
});

describe("brokered checkout route", () => {
  function fakeExchange(body: unknown) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: "POST",
    }) as unknown as IncomingMessage;
    const response = { status: 0, body: "" };
    const res = {
      set statusCode(value: number) {
        response.status = value;
      },
      setHeader: () => undefined,
      end: (chunk: string) => {
        response.body = chunk;
      },
    } as unknown as ServerResponse;
    return { req, res, response };
  }

  let diagnostics: DiagnosticEventPayload[] = [];
  let stop: (() => void) | undefined;
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    diagnostics = [];
    stop = onInternalDiagnosticEvent((event) => {
      diagnostics.push(event);
    });
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it("reports an unexpected failure once, by errno code, without the credential or path", async () => {
    // A repository root that cannot be created fails below every CheckoutError
    // check, which is the branch that answered a bare 500 and recorded nothing
    // (MAGISTER-GATEWAY-C3).
    const blocker = path.join(scratch("magister-blocked-"), "not-a-directory");
    fs.writeFileSync(blocker, "");
    process.env.MAGISTER_REPO_ROOT = path.join(blocker, "repos");
    const { req, res, response } = fakeExchange({ repo: "acme/site", token: "ghu_secret_value" });

    await handleRepoCheckout(req, res);

    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "checkout_rejected",
      message: "checkout failed",
    });
    const failures = diagnostics.filter((event) => event.type === "http.request.error");
    expect(failures).toEqual([
      expect.objectContaining({
        surface: "plugin_http",
        failureKind: "handler_exception",
        toolName: "magister_repo_checkout",
        reasonCode: "enotdir",
      }),
    ]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("ghu_secret_value");
    expect(serialized).not.toContain(blocker);
  });

  it("keeps a refused request quiet", async () => {
    const { req, res, response } = fakeExchange({ repo: "acme/site" });

    await handleRepoCheckout(req, res);

    expect(response.status).toBe(401);
    expect(diagnostics.some((event) => event.type === "http.request.error")).toBe(false);
  });
});
