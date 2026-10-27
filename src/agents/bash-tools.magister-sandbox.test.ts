import { describe, expect, it } from "vitest";
import { describeExecTool } from "./bash-tools.descriptions.js";
import {
  MAGISTER_SANDBOX_EXEC_RULE,
  MAGISTER_TOOL_SANDBOX_LAUNCHER,
  magisterSandboxExitHint,
} from "./bash-tools.magister-sandbox.js";

const SANDBOX = { MAGISTER_TOOL_SANDBOX_LAUNCHER };
const NO_SANDBOX = {};

describe("magisterSandboxExitHint", () => {
  it("explains a write into the read-only workspace", () => {
    const aggregated =
      "/usr/bin/sh: 1: cannot create resources/evals/run/task/an.py: Read-only file system";
    expect(magisterSandboxExitHint({ aggregated, exitCode: 2, env: SANDBOX })).toBe(
      MAGISTER_SANDBOX_EXEC_RULE,
    );
  });

  it("explains a /tmp file from an earlier call that is gone", () => {
    for (const aggregated of [
      "grep: /tmp/b.py: No such file or directory",
      "head: cannot open '/tmp/b.py' for reading: No such file or directory",
      "/usr/bin/sh: 1: cd: can't cd to /tmp/an",
    ]) {
      expect(magisterSandboxExitHint({ aggregated, exitCode: 1, env: SANDBOX })).toBe(
        MAGISTER_SANDBOX_EXEC_RULE,
      );
    }
  });

  it("stays silent on the command's own errors", () => {
    const traceback =
      "Traceback (most recent call last):\n  File \"/tmp/an.py\", line 2, in <module>\nKeyError: 'campaign'";
    expect(
      magisterSandboxExitHint({ aggregated: traceback, exitCode: 1, env: SANDBOX }),
    ).toBeUndefined();
    expect(
      magisterSandboxExitHint({
        aggregated: "python3: can't open file 'missing.py': No such file or directory",
        exitCode: 2,
        env: SANDBOX,
      }),
    ).toBeUndefined();
  });

  it("stays silent on success and outside the sandbox", () => {
    const aggregated = "wrote /tmp/x: Read-only file system";
    expect(magisterSandboxExitHint({ aggregated, exitCode: 0, env: SANDBOX })).toBeUndefined();
    expect(magisterSandboxExitHint({ aggregated, exitCode: 1, env: NO_SANDBOX })).toBeUndefined();
    expect(
      magisterSandboxExitHint({
        aggregated,
        exitCode: 1,
        env: { MAGISTER_TOOL_SANDBOX_LAUNCHER: "/tmp/attacker" },
      }),
    ).toBeUndefined();
  });
});

describe("describeExecTool under the Magister sandbox", () => {
  it("states the rule where the decision is made, only in the sandbox", () => {
    expect(describeExecTool({ magisterSandbox: true })).toContain(MAGISTER_SANDBOX_EXEC_RULE);
    expect(describeExecTool({ magisterSandbox: false })).not.toContain("read-only");
  });
});
