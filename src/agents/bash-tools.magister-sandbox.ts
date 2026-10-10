/**
 * The Magister tool sandbox (openclaw-image/sandbox_supervisor.py): every exec
 * runs with the workspace bind-mounted read-only and a /tmp that belongs to
 * that one call. AGENTS.md states this once in a dense paragraph, and the
 * model still writes a helper script next to its data (EROFS) or into /tmp
 * and reaches for it on the next call (ENOENT), losing a full context
 * re-read each time: 16 read-only and 5 lost-/tmp failures across 12
 * data-analysis attempts on 2026-10-07. So the rule is stated where the
 * decision is made (the exec tool's description) and again on the failure
 * it explains (the exit hint), the way the timeout failure already carries
 * its own instruction.
 */

export const MAGISTER_TOOL_SANDBOX_LAUNCHER = "/usr/local/bin/magister-tool-sandbox";

export function magisterToolSandboxLauncher(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.MAGISTER_TOOL_SANDBOX_LAUNCHER === MAGISTER_TOOL_SANDBOX_LAUNCHER
    ? MAGISTER_TOOL_SANDBOX_LAUNCHER
    : undefined;
}

export const MAGISTER_SANDBOX_EXEC_RULE =
  "The workspace is read-only inside exec and /tmp is emptied after every call: " +
  "read inputs in place, write and run a script in the same call (for example " +
  "`python3 - <<'PY' ... PY`), and put a file that must outlive the call under " +
  "$MAGISTER_PROMOTION_DIR.";

const READ_ONLY_WORKSPACE = /Read-only file system/;
const TMP_GONE_LINE = /^(?=.*\/tmp\/).*No such file or directory|can't cd to \/tmp/m;

/** The rule, when a non-zero exit was caused by the sandbox rather than the command. */
export function magisterSandboxExitHint(params: {
  aggregated: string;
  exitCode: number;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (params.exitCode === 0 || !magisterToolSandboxLauncher(params.env)) {
    return undefined;
  }
  if (READ_ONLY_WORKSPACE.test(params.aggregated) || TMP_GONE_LINE.test(params.aggregated)) {
    return MAGISTER_SANDBOX_EXEC_RULE;
  }
  return undefined;
}
