import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { mirrorReadBits } from "./tool-readable.js";

/**
 * Brokered repository checkout, and what can be done with one (Phases 3.1–3.2).
 *
 * The checkout is the primitive: freezing a commit and pushing a branch both
 * operate on a tree this module put on disk and cannot exist without it, which
 * is why all three live here.
 *
 * The Gateway resolves the project's GitHub or GitLab grant and posts it here;
 * this host process runs `git` with the credential reachable only through `GIT_ASKPASS`
 * plus the child's own environment. The credential never appears in argv, in a
 * remote URL, in Git config, in a response body, or anywhere the sandbox can
 * read: the model-directed shell runs `--clearenv --unshare-net --unshare-pid`
 * as a different user, so it can neither inherit the variable nor read this
 * process's `/proc` entry. Freezing a commit is purely local, so that request
 * carries no credential at all.
 *
 * Checkouts live at `/data/repos`, a volume sibling *outside* `OPENCLAW_HOME`.
 * Every recursive walk on a machine — the backup checkpointer, the boot-time
 * workspace chmod, and the restore validator — is rooted at `/data/.openclaw`
 * or narrower, so a sibling is excluded from all of them by construction rather
 * than by six exclusion lists that a seventh walk would silently miss. See
 * `docs/plans/2026-08-24-phase-3-1-checkout-limits-lock.md` in the monorepo.
 */

/** Resolved per call, not frozen at import, matching `corpus-contract.workspaceDir`. */
export function repoRoot(): string {
  return path.resolve(process.env.MAGISTER_REPO_ROOT ?? "/data/repos");
}

export const STAGING_DIR_NAME = ".staging";

export const MAX_REQUEST_BYTES = 16 * 1024;
/** Same number as `backup_checkpoint.MAX_TRACKED_FILES`, so a checkout alone
 *  cannot exhaust the checkpoint budget if the root ever moves inside HOME. */
export const MAX_CHECKOUT_FILES = 20_000;
export const MAX_CHECKOUT_BYTES = 256 * 1024 * 1024;
/** The real guard. A per-checkout cap alone never bounds the root — N
 *  checkouts still fill a 5 GB volume. Mirrors the attempt/total scratch pair
 *  in `sandbox_supervisor.py` (64 MiB / 256 MiB), same 4:1 shape. */
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const CLONE_TIMEOUT_MS = 120_000;
export const GIT_COMMAND_TIMEOUT_MS = 30_000;
export const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** An orphaned staging tree can only come from a crashed clone, so anything
 *  older than a clone's own ceiling is unreachable by definition. */
export const STAGING_TTL_MS = CLONE_TIMEOUT_MS * 2;
const SIZE_POLL_INTERVAL_MS = 3_000;

/** Pushing a packfile is the same kind of network operation as fetching one,
 *  so it shares the clone ceiling. The Gateway's own timeout sits above both,
 *  so a structured refusal always wins the race against a bare transport
 *  timeout. */
export const PUSH_TIMEOUT_MS = CLONE_TIMEOUT_MS;

/** A change touching more than this many files is not a diff a person reviewed,
 *  and the manifest that describes it stops being readable long before here. */
export const MAX_PREPARED_FILES = 1_000;
export const MAX_PREPARED_BYTES = 32 * 1024 * 1024;
/** The receipt is read by the model on every call, so the manifest is bounded
 *  independently of how many files the commit is allowed to touch. */
export const MAX_MANIFEST_ENTRIES = 100;
/** Display only. A path is truncated when the *receipt* is built, never in the
 *  manifest itself — the same values address real files on disk. */
export const MAX_MANIFEST_PATH_CHARS = 200;
export const MAX_MARKER_HISTORY = 20;

/** Agent commits are attributed to the agent. Borrowing the connected user's
 *  identity would put their name on work they have not read yet, and the
 *  subdomain is deliberately non-routable. */
export const COMMIT_AUTHOR_NAME = "Magister Agent";
export const COMMIT_AUTHOR_EMAIL = "agent@noreply.magistermarketing.com";

/** Where the sandbox's writes to a checkout land (Phase 3.5): a sibling of
 *  the checkouts, mirrored by path. The supervisor mounts the real tree as
 *  the lower layer of an overlay and this as the upper, so build output,
 *  test caches, and a formatter's edits never reach the tree the freeze
 *  reads. Mirrors `sandbox_supervisor.WORK_DIR_NAME`. */
export const WORK_DIR_NAME = ".work";
export const RUNS_LOG_NAME = "runs.jsonl";
const CHECKOUT_LOCK_NAME = ".attempt.lock";
/** A holder that cannot be checked for liveness is presumed dead after this. */
const CHECKOUT_LOCK_STALE_MS = 120_000;
/** How long a host operation waits for a running command before refusing.
 *  Read per call so a test can shorten it. */
function checkoutLockWaitMs(): number {
  const configured = Number(process.env.MAGISTER_CHECKOUT_LOCK_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30_000;
}
/** A dependency install and a rebuild each get this long inside the sandbox. */
export const INSTALL_TIMEOUT_SECONDS = 300;
const SANDBOX_OUTPUT_TAIL_CHARS = 4_000;
/** How many run records a freeze attaches as its evidence. */
export const MAX_VERIFICATION_RECORDS = 20;
export const MAX_SHADOWED_ENTRIES = 100;
/** How many shadowed paths a refusal names outright. The full count is in the
 *  message; this bounds the `user_action` a person actually reads. */
export const SHADOWED_NAMES_IN_MESSAGE = 10;
/** The one client the host uses to reach the sandbox supervisor — the same
 *  launcher the exec tool uses, so there is no second privilege path. Read
 *  per call, like `repoRoot()`. */
function toolSandboxLauncher(): string | undefined {
  return process.env.MAGISTER_TOOL_SANDBOX_LAUNCHER || undefined;
}

const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
/** GitHub owner names are alphanumerics and hyphens. Enforcing that here, not
 *  just trusting GitHub's own rule, is what keeps the two on-disk layouts
 *  apart: a GitLab checkout lives under a host-named directory, and no GitHub
 *  owner can be spelled like a hostname because one has no dot. */
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Every git host a checkout can talk to, and the few things that differ.
 *
 * The Gateway names the provider from the project's grant and the machine
 * owns the host mapping, so no URL ever travels on the wire to be validated —
 * a provider this table does not list is refused outright.
 */
export const REPO_PROVIDERS = {
  github: {
    host: "github.com",
    label: "GitHub",
    /** Installation and user-to-server tokens authenticate as this fixed user. */
    askpassUsername: "x-access-token",
    /** `owner/name` only; GitHub has no nested namespaces. */
    maxSegments: 2,
  },
  gitlab: {
    host: "gitlab.com",
    label: "GitLab",
    /** An OAuth access token is the password for the fixed user `oauth2`. */
    askpassUsername: "oauth2",
    /** `group/subgroup/…/project`: GitLab nests groups. Six is deeper than any
     *  layout seen in practice and keeps the containment check finite. */
    maxSegments: 6,
  },
} as const;
export type RepoProvider = keyof typeof REPO_PROVIDERS;

export type CheckoutRequest = {
  repo: string;
  provider: RepoProvider;
  ref?: string;
  discard_local_changes: boolean;
  token: string;
  mutation_context?: unknown;
};

export type CheckoutReceipt = {
  status: "checked_out" | "refreshed" | "already_current";
  repo: string;
  provider: RepoProvider;
  path: string;
  ref: string;
  commit_sha: string;
  file_count: number;
  byte_size: number;
  expires_at: string;
};

export type PrepareRequest = {
  repo: string;
  provider: RepoProvider;
  message: string;
  /** Deliberately always absent. Freezing a commit is a local `git` operation,
   *  so this is the one brokered request that never carries a credential; the
   *  field is declared so the shared handler still sees a scrubbing contract. */
  token?: undefined;
  mutation_context?: unknown;
};

export type ManifestEntry = { path: string; change: "added" | "modified" | "deleted" };

/** One command the model ran inside the checkout, as the supervisor recorded
 *  it: what, where, how it ended. Never its output. */
export type RunRecord = {
  at: string;
  cwd: string;
  command: string;
  exit_code: number;
  duration_ms: number;
};

export type PrepareReceipt = {
  status: "prepared" | "already_prepared";
  repo: string;
  path: string;
  commit_sha: string;
  base_sha: string;
  message: string;
  changed_file_count: number;
  changed_files: ManifestEntry[];
  byte_size: number;
  /** Tracked files a sandbox command wrote — a formatter, a code generator.
   *  Those writes live in the work layer, not in this commit, and they hide
   *  the committed version from the sandbox's own view. */
  shadowed_tracked_files: ManifestEntry[];
  /** Commands run in the checkout since the previous freeze. */
  verification: RunRecord[];
  warnings: string[];
};

export type InstallRequest = {
  repo: string;
  provider: RepoProvider;
  token?: undefined;
  mutation_context?: unknown;
};

export type InstallReceipt = {
  /** `installing` means the work continues on the machine after this reply;
   *  call again after `poll_after_seconds` for the outcome. An install can
   *  run for minutes, longer than any single hop between the model and this
   *  host is allowed to wait. */
  status: "installing" | "installed";
  repo: string;
  provider: RepoProvider;
  path: string;
  manager: "pnpm" | "npm" | "yarn" | "uv" | "pip";
  lockfile: string;
  /** The offline second step that runs lifecycle scripts, for managers that
   *  have one. A non-zero exit is reported, not fatal: a package whose
   *  postinstall needs the network fails here by design. */
  rebuild: { ran: boolean; exit_code: number | null };
  byte_size: number;
  warnings: string[];
  installed_at?: string;
  poll_after_seconds?: number;
};

export const INSTALL_POLL_SECONDS = 20;
/** An install still marked running after this long is presumed dead —
 *  the host restarted mid-install — and a new one may start. */
const INSTALL_STALE_MS = 2 * INSTALL_TIMEOUT_SECONDS * 1_000 + 60_000;

export type PushRequest = {
  repo: string;
  provider: RepoProvider;
  branch: string;
  commit_sha: string;
  expected_remote_sha?: string;
  token: string;
  mutation_context?: unknown;
};

export type PushReceipt = {
  status: "pushed" | "already_pushed";
  repo: string;
  provider: RepoProvider;
  branch: string;
  commit_sha: string;
  verified_sha: string;
  previous_remote_sha: string | null;
  default_branch: string;
  branch_url: string;
  pull_request_url: string;
  /** What was run against the tree this commit froze — the pull request's
   *  "Verification" section. Evidence a person reads, not a gate. */
  verification: RunRecord[];
};

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly userAction?: string,
  ) {
    super(message);
  }
}

// ── Validation ──────────────────────────────────────────────────────────

/** Absent means GitHub. A Gateway from before GitLab support sends no
 *  provider, and every checkout it ever made was a GitHub one, so the default
 *  is what keeps those machines correct during a rollout. */
export function parseProvider(value: unknown): RepoProvider {
  if (value === undefined || value === null) {
    return "github";
  }
  if (typeof value === "string" && Object.hasOwn(REPO_PROVIDERS, value)) {
    return value as RepoProvider;
  }
  throw new CheckoutError("provider is not a supported git host");
}

export type ParsedRepo = { provider: RepoProvider; segments: string[]; full: string };

/** A repository path — `owner/name` on GitHub, `group/…/project` on GitLab —
 *  with every segment safe as a single path component.
 *
 *  The leading character class is what rejects `.` and `..`: a bare
 *  `[^/\s]+/[^/\s]+` pattern accepts `../x`, which would resolve outside the
 *  repo root. `resolveRepoDir` re-checks containment anyway. */
export function parseRepo(value: unknown, provider: RepoProvider = "github"): ParsedRepo {
  const spec = REPO_PROVIDERS[provider];
  const shape = provider === "github" ? "owner/name" : "group/subgroup/project";
  if (typeof value !== "string" || !value.includes("/")) {
    throw new CheckoutError(`repo must be in ${shape} form`);
  }
  const segments = value.split("/");
  if (segments.length < 2 || segments.length > spec.maxSegments) {
    throw new CheckoutError(`repo must be in ${shape} form`);
  }
  if (segments.some((segment) => !SEGMENT_RE.test(segment))) {
    throw new CheckoutError(`repo segments must be plain ${spec.label} identifiers`);
  }
  if (provider === "github" && !GITHUB_OWNER_RE.test(segments[0] ?? "")) {
    throw new CheckoutError("repo owner must be a plain GitHub account name");
  }
  return { provider, segments, full: segments.join("/") };
}

/** A branch, a tag, or a full commit SHA.
 *
 *  A ref beginning with `-` is argv injection into `git`, which is why the
 *  first character is constrained separately. Callers additionally pass `--`
 *  before every user-supplied value. */
export function parseRef(value: unknown): { ref: string; isSha: boolean } | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new CheckoutError("ref must be a string");
  }
  if (SHA_RE.test(value)) {
    return { ref: value, isSha: true };
  }
  if (!REF_RE.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/")) {
    throw new CheckoutError("ref is not an accepted branch, tag, or commit form");
  }
  return { ref: value, isSha: false };
}

/** A branch this action is allowed to write.
 *
 *  Stricter than `parseRef`: the value is interpolated into `refs/heads/<x>`,
 *  so a leading `refs/` would silently produce `refs/heads/refs/heads/x`, and
 *  a `.lock` suffix collides with git's own ref locking. */
export function parseBranch(value: unknown): string {
  const parsed = parseRef(value);
  if (!parsed || parsed.isSha) {
    throw new CheckoutError("branch must be a branch name");
  }
  const branch = parsed.ref;
  if (branch.startsWith("refs/") || branch.endsWith(".lock") || branch.includes("/.")) {
    throw new CheckoutError("branch is not an accepted branch name");
  }
  return branch;
}

export function parseSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new CheckoutError(`${label} must be a full 40-character commit SHA`);
  }
  return value;
}

/** Where a checkout lives.
 *
 *  GitHub keeps the original two-level layout every existing checkout already
 *  uses, so nothing is orphaned or re-cloned by this change. Any other host
 *  gets a directory named after it, so `acme/site` on two hosts can never share
 *  a path — and that directory cannot collide with a GitHub owner, because
 *  `parseRepo` forbids the dot a hostname needs. */
export function resolveRepoDir(parsed: ParsedRepo): string {
  const parts =
    parsed.provider === "github"
      ? parsed.segments
      : [REPO_PROVIDERS[parsed.provider].host, ...parsed.segments];
  const resolved = path.resolve(repoRoot(), ...parts);
  const prefix = `${repoRoot()}${path.sep}`;
  if (
    !resolved.startsWith(prefix) ||
    resolved.slice(prefix.length).split(path.sep).length !== parts.length
  ) {
    throw new CheckoutError("resolved checkout path escapes the repository root", 400);
  }
  return resolved;
}

// ── Git execution ───────────────────────────────────────────────────────

type GitResult = { code: number; stdout: string; stderr: string };

/** Replace any accidental appearance of the credential before it reaches a
 *  response body or a log line. Nothing should place it there — argv and the
 *  remote URL are both clean — so this is insurance, not the mechanism. */
export function scrubToken(text: string, token: string): string {
  if (!token) {
    return text;
  }
  return text.split(token).join("***");
}

async function runGit(
  args: string[],
  options: {
    cwd?: string;
    token?: string;
    /** Which host the token belongs to — it decides the askpass username. */
    provider?: RepoProvider;
    timeoutMs: number;
    onTick?: () => Promise<boolean>;
  },
): Promise<GitResult> {
  const { cwd, token, provider = "github", timeoutMs, onTick } = options;
  // An empty HOME plus GIT_CONFIG_NOSYSTEM means git reads no user or system
  // config, so no inherited credential.helper can cache or exfiltrate the
  // token, and no `~/.gitconfig` can rewrite the remote URL.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: path.join(repoRoot(), STAGING_DIR_NAME, ".githome"),
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  if (token) {
    env.GIT_ASKPASS = await ensureAskpassHelper(REPO_PROVIDERS[provider].askpassUsername);
    env.MAGISTER_GIT_TOKEN = token;
  }
  const child = spawn(
    "git",
    ["-c", "credential.helper=", "-c", "advice.detachedHead=false", ...args],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 64 * 1024) {
      stderr += chunk.toString("utf8");
    }
  });

  let abortReason: string | null = null;
  const kill = (reason: string) => {
    if (abortReason) {
      return;
    }
    abortReason = reason;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => kill("timeout"), timeoutMs);
  const poll = onTick
    ? setInterval(() => {
        void onTick().then((withinBudget) => {
          if (!withinBudget) {
            kill("quota");
          }
        });
      }, SIZE_POLL_INTERVAL_MS)
    : null;

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (value) => resolve(value ?? -1));
    });
    if (abortReason === "timeout") {
      throw new CheckoutError(
        `The clone exceeded the ${Math.round(timeoutMs / 1000)}s limit.`,
        504,
        "Retry with a smaller repository, or narrow the ref.",
      );
    }
    if (abortReason === "quota") {
      throw new CheckoutError(
        "The repository exceeded the checkout size limit while cloning.",
        413,
        "This repository is too large for a brokered checkout. Read the files you need one at a time through the integration API instead.",
      );
    }
    return { code, stdout, stderr: token ? scrubToken(stderr, token) : stderr };
  } finally {
    clearTimeout(timer);
    if (poll) {
      clearInterval(poll);
    }
  }
}

/**
 * Create the repository root at 0755, explicitly.
 *
 * The entrypoint already does this at boot, so this is the belt to that
 * braces — but it is load-bearing belt. Every other `mkdir` here is
 * `recursive: true` with mode 0700 for the staging directory, and a recursive
 * mkdir applies its mode to *every* directory it creates. On a machine where
 * the root is missing, creating `.staging` first would leave `/data/repos`
 * itself at 0700, and the tool user cannot traverse it — every checkout would
 * mount correctly and be unreadable, with nothing pointing at the cause.
 */
export async function ensureRepoRoot(): Promise<string> {
  const root = repoRoot();
  await fs.promises.mkdir(root, { recursive: true, mode: 0o755 });
  await fs.promises.chmod(root, 0o755);
  return root;
}

const askpassByRootAndUser = new Map<string, string>();

/** The helper itself holds no secret — it echoes the child's own environment,
 *  which only the host user can read. Written once per repository root and
 *  username; the username is the one thing about HTTPS auth that differs
 *  between hosts, so each gets its own tiny script rather than one that
 *  reads a second variable. */
async function ensureAskpassHelper(username: string): Promise<string> {
  const root = await ensureRepoRoot();
  const key = `${root}\0${username}`;
  const cached = askpassByRootAndUser.get(key);
  if (cached) {
    return cached;
  }
  const dir = path.join(root, STAGING_DIR_NAME);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(path.join(dir, ".githome"), { recursive: true, mode: 0o700 });
  const target = path.join(dir, `askpass-${username}.sh`);
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    `  Username*) printf '%s\\n' '${username}' ;;`,
    "  *) printf '%s\\n' \"$MAGISTER_GIT_TOKEN\" ;;",
    "esac",
    "",
  ].join("\n");
  await fs.promises.writeFile(target, script, { mode: 0o700 });
  await fs.promises.chmod(target, 0o700);
  askpassByRootAndUser.set(key, target);
  return target;
}

// ── Measurement, sweeping ───────────────────────────────────────────────

export type TreeStats = { files: number; bytes: number; exceeded: boolean };

/** Walk without following symlinks, stopping the moment a limit is passed.
 *
 *  Early exit is what makes the in-flight size poll cheap: an oversized clone
 *  is detected after a bounded number of `lstat` calls, not a full traversal. */
export async function measureTree(
  root: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<TreeStats> {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        files += 1;
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      files += 1;
      try {
        bytes += (await fs.promises.lstat(full)).size;
      } catch {
        continue;
      }
      if (files > limits.maxFiles || bytes > limits.maxBytes) {
        return { files, bytes, exceeded: true };
      }
    }
  }
  return { files, bytes, exceeded: false };
}

/**
 * Mirror owner read/execute onto group and other, and drop every non-owner
 * write bit.
 *
 * The host process runs under a 0027 umask, so a fresh clone lands 0640 files
 * and 0750 directories — which the sandbox cannot read. Bubblewrap's user
 * namespace does not preserve the host supplementary-group mapping, so
 * traversal cannot rely on the shared group; `sandbox_supervisor.
 * prepare_workspace_read_surface` solves the identical problem for the
 * workspace with exactly this rule, and the checkout needs it for the same
 * reason. The bind itself is read-only, so widening the read bits grants
 * nothing beyond reading files the project already owns.
 */
export async function makeReadableByTools(root: string): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        // Deliberately falls through to the chmod below: a directory the
        // sandbox cannot traverse hides every file under it.
        stack.push(full);
      } else if (!entry.isFile()) {
        continue;
      }
      await mirrorReadBits(full);
    }
  }
  await mirrorReadBits(root);
}

export type PreparedCommit = {
  sha: string;
  base_sha: string;
  prepared_at: string;
  message: string;
  verification?: RunRecord[];
};

export type PushedBranch = { branch: string; sha: string; pushed_at: string };

export type InstalledDependencies = {
  manager: InstallReceipt["manager"];
  lockfile: string;
  sha256: string;
  state: "running" | "installed" | "failed";
  started_at: string;
  finished_at?: string;
  rebuild?: InstallReceipt["rebuild"];
  warnings?: string[];
  /** For `failed`: the bounded tail of the install's output. */
  error?: string;
};

type CheckoutMarker = {
  last_used_at: string;
  repo: string;
  /** The lockfile the work layer's dependencies were installed from, so a
   *  repeat install with the same lockfile is a no-op rather than a refetch. */
  deps?: InstalledDependencies;
  /** The upstream commit this checkout started from. Every manifest is diffed
   *  against it, so a stack of prepared commits still describes one change set
   *  rather than the delta since the previous freeze. */
  base_sha?: string;
  prepared?: PreparedCommit[];
  /** Branches this checkout has pushed. This — not a remote lookup — is what
   *  "Magister-owned" means: reading a branch tip's committer would cost an
   *  extra authenticated fetch, and a record we wrote ourselves cannot be
   *  spoofed by whoever last pushed to the remote. */
  pushed?: PushedBranch[];
};

/** Kept inside `.git/` on purpose: anything written into the working tree
 *  would show up as untracked in `git status --porcelain`, and the dirty-work
 *  refusal would then reject every refresh of a clean checkout. */
function markerPath(repoDir: string): string {
  return path.join(repoDir, ".git", "magister-checkout.json");
}

async function readMarker(repoDir: string): Promise<CheckoutMarker | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(markerPath(repoDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as CheckoutMarker;
  } catch {
    return null;
  }
}

function trimHistory<T>(entries: T[]): T[] {
  return entries.slice(-MAX_MARKER_HISTORY);
}

async function stampMarker(
  repoDir: string,
  repo: string,
  patch?: Partial<Omit<CheckoutMarker, "last_used_at" | "repo">>,
): Promise<void> {
  const previous = (await readMarker(repoDir)) ?? {};
  const marker: CheckoutMarker = {
    ...previous,
    ...patch,
    last_used_at: new Date().toISOString(),
    repo,
  };
  await fs.promises.writeFile(markerPath(repoDir), JSON.stringify(marker), { mode: 0o600 });
}

/** Prepared commits that have not reached any remote branch.
 *
 *  These leave the working tree *clean*, so the dirty-work refusal does not see
 *  them — without this the second `checkout_repo` of a session would detach
 *  HEAD back to the upstream tip and silently orphan frozen work. */
function unpushedCommits(marker: CheckoutMarker | null): PreparedCommit[] {
  const pushed = new Set((marker?.pushed ?? []).map((entry) => entry.sha));
  return (marker?.prepared ?? []).filter((commit) => !pushed.has(commit.sha));
}

async function markerAge(repoDir: string, now: number): Promise<number> {
  const parsed = await readMarker(repoDir);
  if (parsed) {
    // Unvalidated JSON from disk: a non-string parses to NaN and falls through
    // to the directory mtime below, which is the point of the guard.
    const stamped = Date.parse(parsed.last_used_at);
    if (Number.isFinite(stamped)) {
      return now - stamped;
    }
  }
  try {
    return now - (await fs.promises.stat(repoDir)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A checkout is any directory under the root that has a `.git`; the walk
 *  stops there and never descends into a repository's own tree. Bounded by the
 *  deepest layout a provider allows plus its host directory, so a stray deep
 *  tree cannot turn the hourly sweep into a full-volume crawl. */
const MAX_CHECKOUT_DEPTH =
  1 + Math.max(...Object.values(REPO_PROVIDERS).map((spec) => spec.maxSegments));

async function listCheckouts(): Promise<string[]> {
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: repoRoot(), depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const isCheckout = await fs.promises
        .stat(path.join(full, ".git"))
        .then(() => true)
        .catch(() => false);
      if (isCheckout) {
        found.push(full);
      } else if (depth + 1 < MAX_CHECKOUT_DEPTH) {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return found;
}

/** The `inFlight` key for a checkout directory — the same `provider:path`
 *  the repository lock uses, so the sweeper and the lock agree on identity.
 *  A directory under a host name belongs to that host; anything else is the
 *  GitHub layout. */
function repoKeyForDir(repoDir: string): string {
  const relative = path.relative(repoRoot(), repoDir).split(path.sep);
  for (const [provider, spec] of Object.entries(REPO_PROVIDERS)) {
    if (provider !== "github" && relative[0] === spec.host) {
      return lockKey(provider as RepoProvider, relative.slice(1).join("/"));
    }
  }
  return lockKey("github", relative.join("/"));
}

function lockKey(provider: RepoProvider, repo: string): string {
  return `${provider}:${repo.toLowerCase()}`;
}

/**
 * Delete checkouts past their TTL, plus staging trees orphaned by a crash.
 *
 * Repo content is fully reproducible from the remote, so its value on the
 * volume decays to nothing while its bulk does not. This is a hard requirement
 * of the design, not housekeeping: it is the term on which repo bytes are
 * allowed onto a backed-up volume at all.
 */
export async function sweepExpiredCheckouts(now = Date.now()): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const repoDir of await listCheckouts()) {
    // A checkout with an operation in flight is in use whatever its marker
    // says. The marker is only stamped when an operation *finishes*, and the
    // sweeper also runs on its own hourly timer, so without this a prepare or
    // push against a day-old checkout can have its tree deleted underneath it.
    if (inFlight.has(repoKeyForDir(repoDir))) {
      continue;
    }
    if ((await markerAge(repoDir, now)) > CHECKOUT_TTL_MS) {
      try {
        // Taken with no wait: a command running in a day-old checkout keeps
        // it alive for one more sweep rather than losing its tree.
        await withCheckoutLock(repoDir, "host:sweep", async () => {
          // The layer goes first, while the marker still exists to name it.
          await workLayerControl(repoDir, "remove-work-layer");
          await fs.promises.rm(repoDir, { recursive: true, force: true });
        });
      } catch (error) {
        if (error instanceof CheckoutError && error.statusCode === 409) {
          continue;
        }
        throw error;
      }
      await pruneEmptyAncestors(path.dirname(repoDir));
      removed.push(repoDir);
    }
  }
  removed.push(...(await sweepOrphanedWorkLayers()));
  const staging = path.join(repoRoot(), STAGING_DIR_NAME);
  let pending: fs.Dirent[] = [];
  try {
    pending = await fs.promises.readdir(staging, { withFileTypes: true });
  } catch {
    return { removed };
  }
  for (const entry of pending) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(staging, entry.name);
    try {
      if (now - (await fs.promises.stat(full)).mtimeMs > STAGING_TTL_MS) {
        await fs.promises.rm(full, { recursive: true, force: true });
        removed.push(full);
      }
    } catch {
      continue;
    }
  }
  return { removed };
}

/** A work layer whose checkout is gone — a crash between the two halves of
 *  a sweep — is reclaimed on the next one. The supervisor accepts the removal
 *  by path even without the marker, for exactly this case. */
async function sweepOrphanedWorkLayers(): Promise<string[]> {
  const removed: string[] = [];
  const workRoot = path.join(repoRoot(), WORK_DIR_NAME);
  const stack: Array<{ dir: string; depth: number }> = [{ dir: workRoot, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const isLayer = entries.some((entry) => entry.name === "upper" || entry.name === RUNS_LOG_NAME);
    if (isLayer && dir !== workRoot) {
      const checkout = path.join(repoRoot(), path.relative(workRoot, dir));
      const present = await fs.promises
        .stat(path.join(checkout, ".git"))
        .then(() => true)
        .catch(() => false);
      if (!present) {
        try {
          await workLayerControl(checkout, "remove-work-layer");
          removed.push(dir);
        } catch {
          // Try again next sweep.
        }
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && depth + 1 < MAX_CHECKOUT_DEPTH) {
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return removed;
}

/** Remove now-empty owner, group, and host directories up to — never
 *  including — the repository root, so a nested GitLab path leaves no husk
 *  behind once its checkout is gone. */
async function pruneEmptyAncestors(dir: string, stopAt = repoRoot()): Promise<void> {
  const root = stopAt;
  let current = dir;
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      if ((await fs.promises.readdir(current)).length > 0) {
        return;
      }
      await fs.promises.rmdir(current);
    } catch {
      return; // A non-empty or already-removed directory is fine either way.
    }
    current = path.dirname(current);
  }
}

async function totalBytes(): Promise<number> {
  let total = 0;
  for (const repoDir of await listCheckouts()) {
    total += (
      await measureTree(repoDir, {
        maxFiles: Number.POSITIVE_INFINITY,
        maxBytes: Number.POSITIVE_INFINITY,
      })
    ).bytes;
    total += (
      await measureTree(workLayer(repoDir).upper, {
        maxFiles: Number.POSITIVE_INFINITY,
        maxBytes: Number.POSITIVE_INFINITY,
      })
    ).bytes;
  }
  return total;
}

// ── Work layer ──────────────────────────────────────────────────────────

export type WorkLayer = {
  root: string;
  upper: string;
  work: string;
  runsLog: string;
  lock: string;
};

/** The sandbox-owned layer beside a checkout, mirrored by path. */
export function workLayer(repoDir: string): WorkLayer {
  const root = path.join(repoRoot(), WORK_DIR_NAME, path.relative(repoRoot(), repoDir));
  return {
    root,
    upper: path.join(root, "upper"),
    work: path.join(root, "work"),
    runsLog: path.join(root, RUNS_LOG_NAME),
    lock: path.join(root, CHECKOUT_LOCK_NAME),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves the process exists; only ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(lockDir: string): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as {
      pid?: unknown;
    };
    const pid = Number(owner.pid);
    return !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid);
  } catch {
    try {
      return Date.now() - fs.lstatSync(lockDir).mtimeMs > CHECKOUT_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
}

/** Hold the checkout against the sandbox while a host operation runs.
 *
 *  The supervisor takes the same directory lock for every command it runs in
 *  the checkout, because a `git reset` or a layer reset under a mounted
 *  overlay is undefined, and two commands cannot share one upper layer. A
 *  directory is the lock because both sides can take it with nothing but
 *  `mkdir`; the holder's pid is what makes a crashed holder's lock stale.
 *  The in-process `withRepoLock` still serialises host operations among
 *  themselves; this one is host-versus-sandbox. */
async function withCheckoutLock<T>(
  repoDir: string,
  owner: string,
  task: () => Promise<T>,
): Promise<T> {
  const layer = workLayer(repoDir);
  await fs.promises.mkdir(layer.root, { recursive: true });
  const deadline = Date.now() + checkoutLockWaitMs();
  for (;;) {
    try {
      await fs.promises.mkdir(layer.lock, { mode: 0o770 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (lockIsStale(layer.lock)) {
        await fs.promises.rm(layer.lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CheckoutError(
          "A command is still running in this checkout.",
          409,
          "Wait for it to finish — or stop it — then retry.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    await fs.promises.writeFile(
      path.join(layer.lock, "owner.json"),
      JSON.stringify({ owner, pid: process.pid, at: Math.floor(Date.now() / 1000) }),
      { mode: 0o660 },
    );
    return await task();
  } finally {
    await fs.promises.rm(layer.lock, { recursive: true, force: true });
  }
}

type SandboxRun = { code: number; output: string };

/** Run one command through the tool-sandbox launcher and collect a bounded
 *  tail of its output. The launcher's own diagnostics arrive on stderr
 *  prefixed `tool-sandbox:`; a contract refusal is exit 64. */
async function runInSandbox(
  profile: "fetcher" | "tool" | "maintenance",
  repoDir: string,
  argv: string[],
  timeoutSeconds: number,
): Promise<SandboxRun> {
  const launcher = toolSandboxLauncher();
  if (!launcher) {
    throw new CheckoutError(
      "The tool sandbox is unavailable on this machine.",
      503,
      "Retry later; if it persists the machine needs attention.",
    );
  }
  const attempt = `repo-${profile}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const child = spawn(
    launcher,
    [
      "--workspace",
      repoDir,
      "--attempt",
      attempt,
      "--profile",
      profile,
      "--timeout",
      String(timeoutSeconds),
      "--",
      ...argv,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-SANDBOX_OUTPUT_TAIL_CHARS);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (value) => resolve(value ?? -1));
  });
  return { code, output };
}

/** Reset or remove a checkout's work layer.
 *
 *  Entries the sandbox created inside `upper` belong to the sandbox user, and
 *  a directory it made is not one the host may delete from, so the supervisor
 *  does this as root on the host's behalf. Without a supervisor — tests, a
 *  machine with the sandbox off — the host removes what it can itself. */
async function workLayerControl(
  repoDir: string,
  operation: "reset-work-layer" | "remove-work-layer",
): Promise<void> {
  const layer = workLayer(repoDir);
  if (!toolSandboxLauncher()) {
    if (operation === "remove-work-layer") {
      await fs.promises.rm(layer.root, { recursive: true, force: true });
      // Up to, never including, `.work` — the same rule the supervisor keeps.
      await pruneEmptyAncestors(path.dirname(layer.root), path.join(repoRoot(), WORK_DIR_NAME));
    } else {
      await fs.promises.rm(layer.upper, { recursive: true, force: true });
      await fs.promises.rm(layer.work, { recursive: true, force: true });
    }
    return;
  }
  const run = await runInSandbox("maintenance", repoDir, [operation], 60);
  if (run.code !== 0) {
    throw new CheckoutError(
      `Could not ${operation === "reset-work-layer" ? "reset" : "remove"} the checkout's work layer.`,
      run.output.includes("still running") ? 409 : 502,
      truncate(run.output),
    );
  }
}

/** The supervisor's run log, newest last. Unreadable or absent is empty:
 *  the evidence is a courtesy, never a precondition. */
async function readRunRecords(repoDir: string): Promise<RunRecord[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(workLayer(repoDir).runsLog, "utf8");
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.at === "string" && typeof parsed.command === "string") {
        records.push({
          at: parsed.at,
          cwd: typeof parsed.cwd === "string" ? parsed.cwd : ".",
          command: parsed.command,
          exit_code: typeof parsed.exit_code === "number" ? parsed.exit_code : -1,
          duration_ms: typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0,
        });
      }
    } catch {
      continue;
    }
  }
  return records;
}

/** Tracked files the sandbox wrote or deleted, read from the upper layer.
 *
 *  A regular file in `upper` at a tracked path is a modification the freeze
 *  will not see; overlayfs records a deletion as a character device, so that
 *  is a tracked file the sandbox removed. Package and cache directories are
 *  skipped by name, and the walk is bounded — this is a warning, not an audit. */
async function shadowedTrackedFiles(
  repoDir: string,
  tracked: Set<string>,
): Promise<ManifestEntry[]> {
  const upper = workLayer(repoDir).upper;
  const skip = new Set([
    ".git",
    ".magister-cache",
    "node_modules",
    ".venv",
    ".yarn",
    "__pycache__",
  ]);
  const found: ManifestEntry[] = [];
  const stack = [upper];
  let visited = 0;
  while (stack.length > 0 && found.length < MAX_SHADOWED_ENTRIES && visited < 20_000) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (current === upper && skip.has(entry.name)) {
        continue;
      }
      const full = path.join(current, entry.name);
      const relative = path.relative(upper, full).split(path.sep).join("/");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(full);
      } else if (entry.isCharacterDevice() && tracked.has(relative)) {
        found.push({ path: relative, change: "deleted" });
      } else if ((entry.isFile() || entry.isSymbolicLink()) && tracked.has(relative)) {
        found.push({ path: relative, change: "modified" });
      }
      if (found.length >= MAX_SHADOWED_ENTRIES) {
        break;
      }
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

// ── Checkout ────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<unknown>>();

async function headSha(repoDir: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], {
    cwd: repoDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  return result.code === 0 ? result.stdout.trim() : "";
}

async function isDirty(repoDir: string): Promise<boolean> {
  const result = await runGit(["status", "--porcelain"], {
    cwd: repoDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  return result.code === 0 && result.stdout.trim().length > 0;
}

function remoteUrl(provider: RepoProvider, repo: string): string {
  // No credential and no username here: the whole point of GIT_ASKPASS is that
  // the URL stays clean enough to appear in an error message.
  return `https://${REPO_PROVIDERS[provider].host}/${repo}.git`;
}

async function fetchRef(
  repoDir: string,
  request: CheckoutRequest,
  ref: { ref: string; isSha: boolean } | null,
  budget: () => Promise<boolean>,
): Promise<void> {
  const target = ref ? ref.ref : "HEAD";
  const fetched = await runGit(["fetch", "--depth", "1", "--no-tags", "origin", "--", target], {
    cwd: repoDir,
    token: request.token,
    provider: request.provider,
    timeoutMs: CLONE_TIMEOUT_MS,
    onTick: budget,
  });
  if (fetched.code !== 0) {
    throw new CheckoutError(
      `Could not fetch ${describeRef(ref)} from ${request.repo}.`,
      422,
      truncate(fetched.stderr),
    );
  }
  const checkedOut = await runGit(["checkout", "--detach", "--force", "FETCH_HEAD"], {
    cwd: repoDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (checkedOut.code !== 0) {
    throw new CheckoutError(
      `Could not check out ${describeRef(ref)}.`,
      422,
      truncate(checkedOut.stderr),
    );
  }
}

function describeRef(ref: { ref: string; isSha: boolean } | null): string {
  return ref ? ref.ref : "the default branch";
}

function truncate(value: string, limit = 400): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

async function performCheckout(request: CheckoutRequest): Promise<CheckoutReceipt> {
  const parsed = parseRepo(request.repo, request.provider);
  const { full } = parsed;
  const ref = parseRef(request.ref);
  const repoDir = resolveRepoDir(parsed);

  await ensureRepoRoot();
  await sweepExpiredCheckouts();

  const existing = await fs.promises
    .stat(path.join(repoDir, ".git"))
    .then(() => true)
    .catch(() => false);

  let status: CheckoutReceipt["status"];
  if (existing) {
    status = await withCheckoutLock(repoDir, "host:checkout", async () => {
      const marker = await readMarker(repoDir);
      const unpushed = unpushedCommits(marker);
      if (unpushed.length > 0 && !request.discard_local_changes) {
        throw new CheckoutError(
          `The existing checkout of ${full} has ${unpushed.length} prepared commit(s) that were never pushed.`,
          409,
          "Push that work to a branch first, or ask the user whether to discard it and retry with discard_local_changes=true.",
        );
      }
      if (await isDirty(repoDir)) {
        if (!request.discard_local_changes) {
          throw new CheckoutError(
            `The existing checkout of ${full} has uncommitted changes.`,
            409,
            "Ask the user whether to keep or discard that work; retry with discard_local_changes=true only if they choose to discard it.",
          );
        }
        await runGit(["reset", "--hard"], { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS });
        await runGit(["clean", "-fdx"], { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS });
      }
      if (request.discard_local_changes) {
        // Discarding means the whole state, not only what git tracks: the
        // work layer's build output and shadowed edits go with it. Installed
        // dependencies go too, so the marker forgets them.
        const deps = marker?.deps;
        if (deps?.state === "running" && !installIsStale(deps)) {
          throw new CheckoutError(
            `Dependencies are still installing in ${full}.`,
            409,
            "Wait for the install to finish, then retry.",
          );
        }
        await workLayerControl(repoDir, "reset-work-layer");
        await stampMarker(repoDir, full, { deps: undefined });
      }
      const before = await headSha(repoDir);
      await fetchRef(repoDir, request, ref, () => withinCheckoutBudget(repoDir));
      return (await headSha(repoDir)) === before ? "already_current" : "refreshed";
    });
  } else {
    await ensureRoomForNewCheckout();
    await cloneFresh(repoDir, request, ref);
    status = "checked_out";
  }

  const stats = await measureTree(repoDir, {
    maxFiles: MAX_CHECKOUT_FILES,
    maxBytes: MAX_CHECKOUT_BYTES,
  });
  if (stats.exceeded) {
    await fs.promises.rm(repoDir, { recursive: true, force: true });
    await pruneEmptyAncestors(path.dirname(repoDir));
    throw new CheckoutError(
      `${full} exceeds the checkout limit of ${MAX_CHECKOUT_FILES} files or ${Math.round(MAX_CHECKOUT_BYTES / (1024 * 1024))} MiB.`,
      413,
      `This repository is too large for a brokered checkout. Use the ${REPO_PROVIDERS[request.provider].label} integration to read individual files.`,
    );
  }

  await makeReadableByTools(repoDir);
  const head = await headSha(repoDir);
  // HEAD moved, so any prepared commit now sits on a base that is no longer
  // this checkout's. `pushed` survives: those branches still exist on the
  // remote and are still ours to fast-forward.
  await stampMarker(
    repoDir,
    full,
    status === "already_current" ? undefined : { base_sha: head, prepared: [] },
  );
  return {
    status,
    repo: full,
    provider: request.provider,
    path: repoDir,
    ref: ref ? ref.ref : "HEAD",
    commit_sha: head,
    file_count: stats.files,
    byte_size: stats.bytes,
    expires_at: new Date(Date.now() + CHECKOUT_TTL_MS).toISOString(),
  };
}

async function withinCheckoutBudget(dir: string): Promise<boolean> {
  const stats = await measureTree(dir, {
    maxFiles: MAX_CHECKOUT_FILES,
    maxBytes: MAX_CHECKOUT_BYTES,
  });
  return !stats.exceeded;
}

async function ensureRoomForNewCheckout(): Promise<void> {
  if ((await totalBytes()) < MAX_TOTAL_BYTES) {
    return;
  }
  await sweepExpiredCheckouts();
  if ((await totalBytes()) >= MAX_TOTAL_BYTES) {
    throw new CheckoutError(
      `Checked-out repositories already use the full ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MiB budget.`,
      507,
      "Finish or abandon the current repository work; unused checkouts are removed automatically after 24 hours.",
    );
  }
}

async function cloneFresh(
  repoDir: string,
  request: CheckoutRequest,
  ref: { ref: string; isSha: boolean } | null,
): Promise<void> {
  const staging = path.join(repoRoot(), STAGING_DIR_NAME, `clone-${process.pid}-${Date.now()}`);
  await fs.promises.mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
  try {
    const args = ["clone", "--depth", "1", "--single-branch", "--no-tags"];
    if (ref && !ref.isSha) {
      args.push("--branch", ref.ref);
    }
    args.push("--", remoteUrl(request.provider, request.repo), staging);
    const cloned = await runGit(args, {
      token: request.token,
      provider: request.provider,
      timeoutMs: CLONE_TIMEOUT_MS,
      onTick: () => withinCheckoutBudget(staging),
    });
    if (cloned.code !== 0) {
      throw new CheckoutError(
        `Could not clone ${request.repo} at ${describeRef(ref)}.`,
        422,
        truncate(cloned.stderr),
      );
    }
    if (ref?.isSha) {
      await fetchRef(staging, request, ref, () => withinCheckoutBudget(staging));
    }
    // 0755: the sandbox must traverse owner directories to reach the checkout,
    // and cannot rely on the shared group (see makeReadableByTools).
    await fs.promises.mkdir(path.dirname(repoDir), { recursive: true, mode: 0o755 });
    await fs.promises.chmod(path.dirname(repoDir), 0o755);
    await fs.promises.rename(staging, repoDir);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

/** One operation per repository at a time — checkout, prepare, and push all
 *  mutate the same working tree, so they share one lock rather than three.
 *
 *  Unlike the Gateway's `min instances = 2`, the OpenClaw host is a single
 *  process on a single machine, so an in-process map really is the authority
 *  here — there is no second writer to race with. */
async function withRepoLock<T>(
  provider: RepoProvider,
  repo: string,
  busy: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = lockKey(provider, repo);
  if (inFlight.has(key)) {
    throw new CheckoutError(
      busy,
      409,
      "Wait for the in-flight repository operation to finish, then retry.",
    );
  }
  const running = task();
  inFlight.set(key, running);
  try {
    return await running;
  } finally {
    inFlight.delete(key);
  }
}

export async function checkoutRepository(request: CheckoutRequest): Promise<CheckoutReceipt> {
  return withRepoLock(
    request.provider,
    request.repo,
    `A checkout of ${request.repo} is already running.`,
    () => performCheckout(request),
  );
}

// ── Prepare ─────────────────────────────────────────────────────────────

async function requireCheckout(
  repo: string,
  provider: RepoProvider,
): Promise<{ repoDir: string; full: string }> {
  const parsed = parseRepo(repo, provider);
  const { full } = parsed;
  const repoDir = resolveRepoDir(parsed);
  const present = await fs.promises
    .stat(path.join(repoDir, ".git"))
    .then(() => true)
    .catch(() => false);
  if (!present) {
    throw new CheckoutError(
      `${full} is not checked out on this machine.`,
      409,
      "Check the repository out first, then retry.",
    );
  }
  return { repoDir, full };
}

/** `git diff --name-status -z`, parsed into the manifest shape the receipt uses.
 *
 *  `-z` is load-bearing, not a style choice. In its default line format git
 *  C-quotes any path holding a byte above 0x7f, so `docs/café.md` arrives as
 *  `"docs/caf\303\251.md"` — and every consumer below joins that value onto
 *  `repoDir`. A quoted path silently misses `lstat`, so the file escapes the
 *  byte budget and never has its permissions mirrored; the model is shown a
 *  name that does not exist. `-z` emits the raw bytes with no quoting at all,
 *  and `--no-renames` keeps the stream a flat status/path alternation. */
function parseNameStatus(stdout: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const fields = stdout.split("\0");
  // The stream is NUL-*terminated*, so the split leaves one empty tail field;
  // requiring a full pair to remain drops it.
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const code = fields[index] ?? "";
    const file = fields[index + 1] ?? "";
    if (!code || !file) {
      continue;
    }
    const change: ManifestEntry["change"] = code.startsWith("A")
      ? "added"
      : code.startsWith("D")
        ? "deleted"
        : "modified";
    entries.push({ path: file, change });
  }
  return entries;
}

async function changedBytes(repoDir: string, entries: ManifestEntry[]): Promise<number> {
  let total = 0;
  for (const entry of entries) {
    if (entry.change === "deleted") {
      continue;
    }
    try {
      total += (await fs.promises.lstat(path.join(repoDir, entry.path))).size;
    } catch {
      continue;
    }
  }
  return total;
}

/** Mirror read bits onto the files this commit touched, and onto every
 *  directory leading to them.
 *
 *  A file the agent creates lands under the host's 0027 umask, which leaves the
 *  checkout internally inconsistent with the tree `makeReadableByTools`
 *  produced. The ancestors matter as much as the file: a brand-new folder is
 *  created at 0750, and the sandbox cannot traverse it — so widening only the
 *  leaf would produce a correctly-permissioned file nobody can reach. Walking
 *  the manifest rather than the repository keeps the cost proportional to the
 *  change. */
async function mirrorChangedFiles(repoDir: string, entries: ManifestEntry[]): Promise<void> {
  const targets = new Set<string>();
  for (const entry of entries) {
    if (entry.change === "deleted") {
      continue;
    }
    const segments = entry.path.split("/");
    // git emits repo-relative paths and never a traversal segment; one that has
    // one is not a path this checkout owns, so it is skipped rather than joined.
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      continue;
    }
    let current = repoDir;
    for (const segment of segments) {
      current = path.join(current, segment);
      targets.add(current);
    }
  }
  for (const target of targets) {
    await mirrorReadBits(target);
  }
}

async function trackedFiles(repoDir: string): Promise<Set<string>> {
  const listed = await runGit(["ls-files", "-z"], {
    cwd: repoDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  return new Set(listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : []);
}

/** The commands run in the checkout since the previous freeze, oldest first
 *  and bounded. What they were run against is the tree this freeze reads. */
async function verificationSince(
  repoDir: string,
  previous: PreparedCommit | undefined,
): Promise<RunRecord[]> {
  const records = await readRunRecords(repoDir);
  const since = previous?.prepared_at;
  return records.filter((record) => !since || record.at > since).slice(-MAX_VERIFICATION_RECORDS);
}

async function performPrepare(request: PrepareRequest): Promise<PrepareReceipt> {
  const { repoDir, full } = await requireCheckout(request.repo, request.provider);
  return withCheckoutLock(repoDir, "host:prepare", () => freezeCheckout(repoDir, full, request));
}

async function freezeCheckout(
  repoDir: string,
  full: string,
  request: PrepareRequest,
): Promise<PrepareReceipt> {
  const marker = await readMarker(repoDir);
  const prepared = marker?.prepared ?? [];
  // A marker written before this field existed, or a checkout nothing has
  // frozen yet: HEAD *is* the base in both cases.
  const base = marker?.base_sha ?? (prepared.at(-1)?.base_sha || (await headSha(repoDir)));
  // `headSha` answers with an empty string when git fails, and an empty base
  // would make every `base..sha` diff below silently report zero changed files
  // — a receipt that says nothing changed about a commit that changed plenty.
  if (!SHA_RE.test(base)) {
    throw new CheckoutError(
      `Could not determine the base commit of ${full}.`,
      409,
      "Check the repository out again, then retry.",
    );
  }

  const staged = await runGit(["add", "-A"], { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS });
  if (staged.code !== 0) {
    throw new CheckoutError(`Could not stage changes in ${full}.`, 422, truncate(staged.stderr));
  }

  const pending = await runGit(["diff", "--cached", "--name-status", "--no-renames", "-z"], {
    cwd: repoDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  const pendingEntries = parseNameStatus(pending.stdout);

  if (pendingEntries.length === 0) {
    const last = prepared.at(-1);
    // Re-running the same prepare after a lost response must succeed, not fail
    // with "nothing to commit": the freeze it asked for already happened.
    if (last && last.message === request.message) {
      return await prepareReceipt(repoDir, full, "already_prepared", last);
    }
    // "Nothing staged" is precisely the shape a sandbox-only edit takes, and
    // the reason `shadowed_tracked_files` exists — but that field lives on a
    // receipt, and this path returns none. A formatter, a codegen step, or an
    // in-place compiler that touched only tracked files leaves the real tree
    // byte-identical, so the generic answer below is actively wrong: the agent
    // did edit files, into a layer this commit cannot see, and telling it to
    // "edit files first" invites it to do the same thing again.
    const shadowed = await shadowedTrackedFiles(repoDir, await trackedFiles(repoDir));
    if (shadowed.length > 0) {
      const names = shadowed.slice(0, SHADOWED_NAMES_IN_MESSAGE).map((entry) => entry.path);
      const rest = shadowed.length - names.length;
      throw new CheckoutError(
        `There is nothing to commit in ${full}: ${shadowed.length} tracked file(s) were changed by a command in the sandbox rather than by the file tools.`,
        409,
        `Those changes live in the checkout's work layer and are never committed: ${names.join(", ")}${
          rest > 0 ? `, and ${rest} more` : ""
        }. Re-apply them with the file tools, or discard them with checkout_repo discard_local_changes=true.`,
      );
    }
    throw new CheckoutError(
      `There is nothing to commit in ${full}.`,
      409,
      "Edit files in the checkout first. Files ignored by the repository's .gitignore are never committed.",
    );
  }
  if (pendingEntries.length > MAX_PREPARED_FILES) {
    throw new CheckoutError(
      `This change touches ${pendingEntries.length} files, above the ${MAX_PREPARED_FILES}-file limit for one commit.`,
      413,
      "Split the work into smaller commits, or revert the files that were not meant to change.",
    );
  }
  const bytes = await changedBytes(repoDir, pendingEntries);
  if (bytes > MAX_PREPARED_BYTES) {
    throw new CheckoutError(
      `This change adds ${Math.round(bytes / (1024 * 1024))} MiB, above the ${Math.round(MAX_PREPARED_BYTES / (1024 * 1024))} MiB limit for one commit.`,
      413,
      "Remove large generated or binary files from the change; they usually belong in .gitignore.",
    );
  }

  const committed = await runGit(
    [
      "-c",
      `user.name=${COMMIT_AUTHOR_NAME}`,
      "-c",
      `user.email=${COMMIT_AUTHOR_EMAIL}`,
      "commit",
      "--quiet",
      "--no-verify",
      "--message",
      request.message,
    ],
    { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS },
  );
  if (committed.code !== 0) {
    throw new CheckoutError(
      `Could not create a commit in ${full}.`,
      422,
      truncate(committed.stderr),
    );
  }

  const commit: PreparedCommit = {
    sha: await headSha(repoDir),
    base_sha: base,
    prepared_at: new Date().toISOString(),
    message: request.message,
    verification: await verificationSince(repoDir, prepared.at(-1)),
  };
  await mirrorChangedFiles(repoDir, pendingEntries);
  await stampMarker(repoDir, full, {
    base_sha: base,
    prepared: trimHistory([...prepared, commit]),
  });
  return await prepareReceipt(repoDir, full, "prepared", commit);
}

/** One manifest entry as the *receipt* shows it, shortened here and nowhere
 *  else: `entries` keeps the real path, because that is what `changedBytes` and
 *  `mirrorChangedFiles` address files on disk by. A deeply nested path is
 *  unhelpful in full and unusable cut from the front, so it keeps the end —
 *  the file name is the part that identifies it. */
function forDisplay(entry: ManifestEntry): ManifestEntry {
  return {
    path:
      entry.path.length > MAX_MANIFEST_PATH_CHARS
        ? `…${entry.path.slice(-(MAX_MANIFEST_PATH_CHARS - 1))}`
        : entry.path,
    change: entry.change,
  };
}

/** The manifest is always the whole change against the checkout's base, not the
 *  delta since the previous freeze — that is what a reviewer sees on the pull
 *  request, and therefore what the agent must be describing. */
async function prepareReceipt(
  repoDir: string,
  full: string,
  status: PrepareReceipt["status"],
  commit: PreparedCommit,
): Promise<PrepareReceipt> {
  const diff = await runGit(
    ["diff", "--name-status", "--no-renames", "-z", `${commit.base_sha}..${commit.sha}`],
    { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS },
  );
  const entries = parseNameStatus(diff.stdout);
  const shadowed = await shadowedTrackedFiles(repoDir, await trackedFiles(repoDir));
  const verification = commit.verification ?? [];
  const warnings: string[] = [];
  if (shadowed.length > 0) {
    warnings.push(
      `${shadowed.length} tracked file(s) were changed by a command in the sandbox and are not in this commit. Re-apply those changes with the file tools, or discard the work layer with checkout_repo discard_local_changes=true.`,
    );
  }
  if (verification.length === 0) {
    warnings.push(
      "No command was run in this checkout since the last freeze; nothing was verified.",
    );
  }
  return {
    status,
    repo: full,
    path: repoDir,
    commit_sha: commit.sha,
    base_sha: commit.base_sha,
    message: commit.message,
    changed_file_count: entries.length,
    changed_files: entries.slice(0, MAX_MANIFEST_ENTRIES).map(forDisplay),
    byte_size: await changedBytes(repoDir, entries),
    shadowed_tracked_files: shadowed.map(forDisplay),
    verification,
    warnings,
  };
}

export async function prepareRepoCommit(request: PrepareRequest): Promise<PrepareReceipt> {
  return withRepoLock(
    request.provider,
    request.repo,
    `An operation on ${request.repo} is already running.`,
    () => performPrepare(request),
  );
}

// ── Push ────────────────────────────────────────────────────────────────

type RemoteView = { defaultBranch: string; tip: string | null };

/** One authenticated round trip that answers both questions push needs: which
 *  branch is the default (never writable), and where the target branch is now. */
async function readRemote(
  repoDir: string,
  repo: string,
  provider: RepoProvider,
  branch: string,
  token: string,
): Promise<RemoteView> {
  const listed = await runGit(["ls-remote", "--symref", "origin", "HEAD", `refs/heads/${branch}`], {
    cwd: repoDir,
    token,
    provider,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (listed.code !== 0) {
    throw new CheckoutError(
      `Could not read the current state of ${repo} on ${REPO_PROVIDERS[provider].label}.`,
      502,
      truncate(listed.stderr),
    );
  }
  let defaultBranch = "";
  let tip: string | null = null;
  for (const line of listed.stdout.split("\n")) {
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (symref?.[1]) {
      defaultBranch = symref[1];
      continue;
    }
    const [sha = "", ref = ""] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && SHA_RE.test(sha)) {
      tip = sha;
    }
  }
  if (!defaultBranch) {
    throw new CheckoutError(
      `Could not determine the default branch of ${repo}.`,
      502,
      "Retry; if it keeps failing the repository may be empty or the connection may have lost access to it.",
    );
  }
  return { defaultBranch, tip };
}

/** The two links a reviewer follows from the receipt, in each host's own URL
 *  grammar. GitLab's compare page is the merge-request form itself, so the
 *  link lands on "new merge request" with both branches filled in. */
export function reviewUrls(
  provider: RepoProvider,
  repo: string,
  defaultBranch: string,
  branch: string,
): { branch_url: string; pull_request_url: string } {
  const base = `https://${REPO_PROVIDERS[provider].host}/${repo}`;
  if (provider === "gitlab") {
    const source = encodeURIComponent(branch);
    const target = encodeURIComponent(defaultBranch);
    return {
      branch_url: `${base}/-/tree/${branch}`,
      pull_request_url: `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${source}&merge_request%5Btarget_branch%5D=${target}`,
    };
  }
  return {
    branch_url: `${base}/tree/${branch}`,
    pull_request_url: `${base}/compare/${defaultBranch}...${branch}?expand=1`,
  };
}

async function performPush(request: PushRequest): Promise<PushReceipt> {
  const { repoDir, full } = await requireCheckout(request.repo, request.provider);
  return withCheckoutLock(repoDir, "host:push", () => pushFrozenCommit(repoDir, full, request));
}

async function pushFrozenCommit(
  repoDir: string,
  full: string,
  request: PushRequest,
): Promise<PushReceipt> {
  const label = REPO_PROVIDERS[request.provider].label;
  const marker = await readMarker(repoDir);
  const prepared = marker?.prepared ?? [];
  const frozen = prepared.find((commit) => commit.sha === request.commit_sha);
  if (!frozen) {
    throw new CheckoutError(
      `${request.commit_sha.slice(0, 12)} was not prepared from this checkout.`,
      400,
      "Prepare a commit first and push the commit_sha it returns.",
    );
  }

  const remote = await readRemote(repoDir, full, request.provider, request.branch, request.token);
  const receipt = (status: PushReceipt["status"], verified: string): PushReceipt => ({
    status,
    repo: full,
    provider: request.provider,
    branch: request.branch,
    commit_sha: request.commit_sha,
    verified_sha: verified,
    previous_remote_sha: remote.tip,
    default_branch: remote.defaultBranch,
    ...reviewUrls(request.provider, full, remote.defaultBranch, request.branch),
    verification: frozen.verification ?? [],
  });

  const recordPush = async () => {
    await stampMarker(repoDir, full, {
      pushed: trimHistory([
        ...(marker?.pushed ?? []).filter((entry) => entry.branch !== request.branch),
        { branch: request.branch, sha: request.commit_sha, pushed_at: new Date().toISOString() },
      ]),
    });
  };

  // Idempotency is checked before every refusal below. A retry after a lost
  // response finds its own commit on the branch, and must report success rather
  // than trip the "that branch already exists" rule it created.
  if (remote.tip === request.commit_sha) {
    await recordPush();
    return receipt("already_pushed", remote.tip);
  }
  if (request.branch === remote.defaultBranch) {
    throw new CheckoutError(
      `${request.branch} is the default branch of ${full}.`,
      409,
      "Push to a new branch and open a pull request; merging is the only way the default branch changes.",
    );
  }
  if (remote.tip === null) {
    if (request.expected_remote_sha) {
      throw new CheckoutError(
        `Branch ${request.branch} does not exist in ${full}, so it cannot be at ${request.expected_remote_sha.slice(0, 12)}.`,
        409,
        "Omit expected_remote_sha to create the branch, or push to the branch that does exist.",
      );
    }
  } else {
    const owned = (marker?.pushed ?? []).some((entry) => entry.branch === request.branch);
    if (!owned) {
      throw new CheckoutError(
        `Branch ${request.branch} already exists in ${full} and was not created by this checkout.`,
        409,
        "Push to a new branch name. An existing branch may hold work this project did not write.",
      );
    }
    if (request.expected_remote_sha !== remote.tip) {
      throw new CheckoutError(
        `Branch ${request.branch} has moved since it was read.`,
        409,
        `It is now at ${remote.tip.slice(0, 12)}. Re-read the branch and retry with that value as expected_remote_sha.`,
      );
    }
  }

  // Never `--force` and never `--force-with-lease`: a plain push is itself a
  // compare-and-swap, because git refuses any update that is not a
  // fast-forward. The shallow clone can push because the frozen commit's parent
  // is the remote's own tip, so there is no missing history to send.
  const pushed = await runGit(
    ["push", "origin", `${request.commit_sha}:refs/heads/${request.branch}`],
    {
      cwd: repoDir,
      token: request.token,
      provider: request.provider,
      timeoutMs: PUSH_TIMEOUT_MS,
    },
  );
  if (pushed.code !== 0) {
    throw new CheckoutError(
      `${label} rejected the push to ${request.branch}.`,
      409,
      truncate(pushed.stderr),
    );
  }

  const after = await readRemote(repoDir, full, request.provider, request.branch, request.token);
  if (after.tip !== request.commit_sha) {
    throw new CheckoutError(
      `The push to ${request.branch} reported success but the branch is not at ${request.commit_sha.slice(0, 12)}.`,
      502,
      `Re-read the branch on ${label} before making any further change to it.`,
    );
  }
  await recordPush();
  return receipt("pushed", after.tip);
}

export async function pushRepoBranch(request: PushRequest): Promise<PushReceipt> {
  return withRepoLock(
    request.provider,
    request.repo,
    `An operation on ${request.repo} is already running.`,
    () => performPush(request),
  );
}

// ── Install dependencies ────────────────────────────────────────────────

export type PackageManager = {
  name: InstallReceipt["manager"];
  lockfile: string;
  /** Runs in the fetcher profile: network on, lifecycle scripts off. */
  install: string[];
  /** Runs in the tool profile afterwards: lifecycle scripts on, network off.
   *  Null for managers that have no offline second step. */
  rebuild: string[] | null;
  warnings: string[];
};

/** Which manager a checkout is installed with, decided by its lockfile.
 *
 *  Only a lockfile is ever installed from: resolving unpinned dependencies
 *  would put whatever is newest on the registry into the tree the agent then
 *  tests and pushes, and that is not the project the user has. */
export async function detectPackageManager(repoDir: string): Promise<PackageManager | null> {
  const has = (name: string) =>
    fs.promises
      .stat(path.join(repoDir, name))
      .then(() => true)
      .catch(() => false);
  if (await has("pnpm-lock.yaml")) {
    return {
      name: "pnpm",
      lockfile: "pnpm-lock.yaml",
      install: ["corepack", "pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
      rebuild: ["corepack", "pnpm", "rebuild"],
      warnings: [],
    };
  }
  if (await has("package-lock.json")) {
    return {
      name: "npm",
      lockfile: "package-lock.json",
      // Scripts are off through the fetcher's environment, which wins over .npmrc.
      install: ["npm", "ci", "--no-audit", "--no-fund"],
      rebuild: ["npm", "rebuild"],
      warnings: [],
    };
  }
  if (await has("yarn.lock")) {
    if (await has(".yarnrc.yml")) {
      return {
        name: "yarn",
        lockfile: "yarn.lock",
        install: ["corepack", "yarn", "install", "--immutable"],
        rebuild: ["corepack", "yarn", "rebuild"],
        warnings: [],
      };
    }
    return {
      name: "yarn",
      lockfile: "yarn.lock",
      install: [
        "corepack",
        "yarn@1",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--non-interactive",
      ],
      rebuild: null,
      warnings: [
        "Yarn 1 lifecycle scripts were not run; a package that builds itself on install may not work.",
      ],
    };
  }
  if (await has("uv.lock")) {
    return {
      name: "uv",
      lockfile: "uv.lock",
      // --no-build: a source distribution is code, and the fetcher runs none.
      install: ["uv", "sync", "--frozen", "--no-build", "--no-install-project"],
      rebuild: null,
      warnings: [
        "Dependencies only: the project itself was not installed. Run tests with `uv run --offline --no-sync pytest`, or point PYTHONPATH at the source directory.",
      ],
    };
  }
  if (await has("requirements.txt")) {
    return {
      name: "pip",
      lockfile: "requirements.txt",
      install: [
        "sh",
        "-c",
        "uv venv .venv && uv pip install --python .venv/bin/python --only-binary :all: -r requirements.txt",
      ],
      rebuild: null,
      warnings: [
        "Installed into .venv from binary wheels only; a requirement that ships no wheel fails the install rather than building from source.",
      ],
    };
  }
  return null;
}

/** The two sandbox steps, run to completion and recorded in the marker.
 *
 *  Runs detached from the request that started it: an install can take
 *  minutes, and no hop between the model and this host waits that long. The
 *  marker is the only channel back — every exit of this function, including
 *  a thrown one, leaves a terminal state there for the next call to read. */
async function runInstall(
  repoDir: string,
  full: string,
  manager: PackageManager,
  sha256: string,
): Promise<void> {
  const record = (patch: Partial<InstalledDependencies>) =>
    stampMarker(repoDir, full, {
      deps: {
        manager: manager.name,
        lockfile: manager.lockfile,
        sha256,
        state: "running",
        started_at: new Date().toISOString(),
        ...patch,
      },
    });
  try {
    // Fetch without executing: the fetcher has the network and runs no
    // repository or package code.
    const fetched = await runInSandbox(
      "fetcher",
      repoDir,
      manager.install,
      INSTALL_TIMEOUT_SECONDS,
    );
    if (fetched.code !== 0) {
      await record({
        state: "failed",
        finished_at: new Date().toISOString(),
        error:
          fetched.code === 124
            ? `The install exceeded ${INSTALL_TIMEOUT_SECONDS}s. ${truncate(fetched.output, 1_000)}`
            : truncate(fetched.output, 1_200),
      });
      return;
    }
    // Execute without the network: lifecycle scripts run in the same sandbox
    // the test suite does, with exactly its blast radius.
    let rebuild: InstallReceipt["rebuild"] = { ran: false, exit_code: null };
    const warnings = [...manager.warnings];
    if (manager.rebuild) {
      const rebuilt = await runInSandbox("tool", repoDir, manager.rebuild, INSTALL_TIMEOUT_SECONDS);
      rebuild = { ran: true, exit_code: rebuilt.code };
      if (rebuilt.code !== 0) {
        warnings.push(
          `Lifecycle scripts exited ${rebuilt.code}. A package that downloads during install cannot here, because the sandbox has no network: ${truncate(rebuilt.output, 300)}`,
        );
      }
    }
    await record({ state: "installed", finished_at: new Date().toISOString(), rebuild, warnings });
  } catch (error) {
    await record({
      state: "failed",
      finished_at: new Date().toISOString(),
      error: truncate(error instanceof Error ? error.message : String(error), 600),
    });
  }
}

function installIsStale(deps: InstalledDependencies): boolean {
  const started = Date.parse(deps.started_at);
  return !Number.isFinite(started) || Date.now() - started > INSTALL_STALE_MS;
}

async function performInstall(request: InstallRequest): Promise<InstallReceipt> {
  const { repoDir, full } = await requireCheckout(request.repo, request.provider);
  const manager = await detectPackageManager(repoDir);
  if (!manager) {
    throw new CheckoutError(
      `${full} has no lockfile this machine can install from.`,
      409,
      "Supported: pnpm-lock.yaml, package-lock.json, yarn.lock, uv.lock, requirements.txt. Unpinned dependencies are never resolved here.",
    );
  }
  const sha256 = createHash("sha256")
    .update(await fs.promises.readFile(path.join(repoDir, manager.lockfile)))
    .digest("hex");
  const layer = workLayer(repoDir);
  const receipt = async (
    status: InstallReceipt["status"],
    rebuild: InstallReceipt["rebuild"],
    warnings: string[],
  ): Promise<InstallReceipt> => ({
    status,
    repo: full,
    provider: request.provider,
    path: repoDir,
    manager: manager.name,
    lockfile: manager.lockfile,
    rebuild,
    byte_size: (
      await measureTree(layer.upper, {
        maxFiles: Number.POSITIVE_INFINITY,
        maxBytes: Number.POSITIVE_INFINITY,
      })
    ).bytes,
    warnings,
    ...(status === "installing" ? { poll_after_seconds: INSTALL_POLL_SECONDS } : {}),
  });

  const deps = (await readMarker(repoDir))?.deps;
  const sameLockfile = deps?.sha256 === sha256 && deps.manager === manager.name;
  if (deps?.state === "running" && !installIsStale(deps)) {
    return receipt("installing", { ran: false, exit_code: null }, [
      `Dependencies are still installing; call again in about ${INSTALL_POLL_SECONDS} seconds.`,
    ]);
  }
  if (deps?.state === "failed" && sameLockfile) {
    // Reported once. The marker forgets the failure so the next call retries
    // rather than repeating the same refusal forever.
    await stampMarker(repoDir, full, { deps: undefined });
    throw new CheckoutError(
      `Installing dependencies with ${manager.name} failed.`,
      422,
      deps.error ?? "The install produced no output.",
    );
  }
  const installedRoot = manager.name === "uv" || manager.name === "pip" ? ".venv" : "node_modules";
  const present = await fs.promises
    .stat(path.join(layer.upper, installedRoot))
    .then(() => true)
    .catch(() => false);
  if (deps?.state === "installed" && sameLockfile && present) {
    return {
      ...(await receipt("installed", deps.rebuild ?? { ran: false, exit_code: null }, [
        ...(deps.warnings ?? []),
      ])),
      installed_at: deps.finished_at,
    };
  }

  await stampMarker(repoDir, full, {
    deps: {
      manager: manager.name,
      lockfile: manager.lockfile,
      sha256,
      state: "running",
      started_at: new Date().toISOString(),
    },
  });
  // Detached on purpose — see runInstall. The in-process repository lock is
  // held for the install's whole duration so a freeze or push cannot start
  // underneath it; the checkout lock itself belongs to the supervisor for
  // each sandbox step it runs on the host's behalf.
  void withRepoLock(
    request.provider,
    request.repo,
    `An operation on ${request.repo} is already running.`,
    () => runInstall(repoDir, full, manager, sha256),
  ).catch(() => undefined);
  return receipt("installing", { ran: false, exit_code: null }, [
    `Installing with ${manager.name} from ${manager.lockfile}; call again in about ${INSTALL_POLL_SECONDS} seconds.`,
    ...manager.warnings,
  ]);
}

/** Wait for whatever is in flight on a repository — a detached install, most
 *  likely — to finish. For tests and orderly shutdown; never a user path. */
export async function awaitRepositoryIdle(provider: RepoProvider, repo: string): Promise<void> {
  const running = inFlight.get(lockKey(provider, repo));
  if (running) {
    await running.catch(() => undefined);
  }
}

export async function installRepoDependencies(request: InstallRequest): Promise<InstallReceipt> {
  const key = lockKey(request.provider, request.repo);
  // A poll while the install runs must answer, not collide with the lock the
  // install holds; anything else in flight is a genuine conflict.
  const deps = (await readMarker(resolveRepoDir(parseRepo(request.repo, request.provider))))?.deps;
  if (inFlight.has(key) && !(deps?.state === "running" && !installIsStale(deps))) {
    throw new CheckoutError(
      `An operation on ${request.repo} is already running.`,
      409,
      "Wait for the in-flight repository operation to finish, then retry.",
    );
  }
  return performInstall(request);
}

// ── HTTP surface ────────────────────────────────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new CheckoutError("checkout request is too large", 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CheckoutError("checkout request must be valid JSON");
  }
}

export function parseRequest(value: unknown): CheckoutRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckoutError("checkout request must be an object");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    "repo",
    "provider",
    "ref",
    "discard_local_changes",
    "token",
    "mutation_context",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new CheckoutError("checkout request has unknown fields");
  }
  if (typeof row.token !== "string" || !row.token) {
    throw new CheckoutError("checkout request is missing the repository credential", 401);
  }
  if (row.discard_local_changes !== undefined && typeof row.discard_local_changes !== "boolean") {
    throw new CheckoutError("discard_local_changes must be a boolean");
  }
  const provider = parseProvider(row.provider);
  const { full } = parseRepo(row.repo, provider);
  const ref = parseRef(row.ref);
  return {
    repo: full,
    provider,
    ref: ref?.ref,
    discard_local_changes: row.discard_local_changes === true,
    token: row.token,
    mutation_context: row.mutation_context,
  };
}

function requireFields(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckoutError(`${label} request must be an object`);
  }
  const row = value as Record<string, unknown>;
  const permitted = new Set([...allowed, "provider", "mutation_context"]);
  if (Object.keys(row).some((key) => !permitted.has(key))) {
    throw new CheckoutError(`${label} request has unknown fields`);
  }
  return row;
}

export function parsePrepareRequest(value: unknown): PrepareRequest {
  const row = requireFields(value, ["repo", "message"], "prepare");
  const provider = parseProvider(row.provider);
  const { full } = parseRepo(row.repo, provider);
  if (typeof row.message !== "string" || !row.message.trim()) {
    throw new CheckoutError("prepare request needs a commit message");
  }
  if (row.message.length > 2_000) {
    throw new CheckoutError("commit message is too long");
  }
  return {
    repo: full,
    provider,
    message: row.message.trim(),
    mutation_context: row.mutation_context,
  };
}

export function parseInstallRequest(value: unknown): InstallRequest {
  const row = requireFields(value, ["repo"], "install");
  const provider = parseProvider(row.provider);
  const { full } = parseRepo(row.repo, provider);
  return { repo: full, provider, mutation_context: row.mutation_context };
}

export function parsePushRequest(value: unknown): PushRequest {
  const row = requireFields(
    value,
    ["repo", "branch", "commit_sha", "expected_remote_sha", "token"],
    "push",
  );
  if (typeof row.token !== "string" || !row.token) {
    throw new CheckoutError("push request is missing the repository credential", 401);
  }
  const provider = parseProvider(row.provider);
  const { full } = parseRepo(row.repo, provider);
  return {
    repo: full,
    provider,
    branch: parseBranch(row.branch),
    commit_sha: parseSha(row.commit_sha, "commit_sha"),
    expected_remote_sha:
      row.expected_remote_sha === undefined || row.expected_remote_sha === null
        ? undefined
        : parseSha(row.expected_remote_sha, "expected_remote_sha"),
    token: row.token,
    mutation_context: row.mutation_context,
  };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

/** Parse, then run, then answer — with the credential scrubbed from every exit.
 *
 *  The request is parsed before the work starts so that the token is known for
 *  scrubbing even when the work itself is what fails. */
async function handleBrokeredPost<Request extends { token?: string }, Receipt>(
  req: IncomingMessage,
  res: ServerResponse,
  operation: {
    parse: (body: unknown) => Request;
    execute: (request: Request) => Promise<Receipt>;
    errorCode: string;
    failure: string;
  },
): Promise<boolean> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  let token = "";
  try {
    const request = operation.parse(await readJsonBody(req));
    token = request.token ?? "";
    sendJson(res, 200, await operation.execute(request));
  } catch (error) {
    const status = error instanceof CheckoutError ? error.statusCode : 500;
    const raw = error instanceof CheckoutError ? error.message : operation.failure;
    const userAction = error instanceof CheckoutError ? error.userAction : undefined;
    sendJson(res, status, {
      error: operation.errorCode,
      message: scrubToken(raw, token),
      user_action: userAction ? scrubToken(userAction, token) : undefined,
    });
  }
  return true;
}

export function handleRepoCheckout(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleBrokeredPost(req, res, {
    parse: parseRequest,
    execute: checkoutRepository,
    errorCode: "checkout_rejected",
    failure: "checkout failed",
  });
}

export function handleRepoPrepare(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleBrokeredPost(req, res, {
    parse: parsePrepareRequest,
    execute: prepareRepoCommit,
    errorCode: "prepare_rejected",
    failure: "preparing the commit failed",
  });
}

export function handleRepoPush(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleBrokeredPost(req, res, {
    parse: parsePushRequest,
    execute: pushRepoBranch,
    errorCode: "push_rejected",
    failure: "pushing the branch failed",
  });
}

export function handleRepoInstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleBrokeredPost(req, res, {
    parse: parseInstallRequest,
    execute: installRepoDependencies,
    errorCode: "install_rejected",
    failure: "installing dependencies failed",
  });
}

/** Periodic TTL enforcement, independent of whether a checkout is requested.
 *
 *  Unreferenced so it can never hold the host process open. */
export function startCheckoutSweeper(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepExpiredCheckouts().catch(() => undefined);
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
