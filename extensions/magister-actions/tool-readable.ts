import fs from "node:fs";

/**
 * The one rule for a host-owned path the agent's tools must be able to read:
 * owner read/execute mirrored onto group and other, every non-owner write bit
 * cleared. `0600` becomes `0644`, `0700` becomes `0755`.
 *
 * The exec sandbox runs as a different uid, and Bubblewrap's user namespace
 * does not preserve the host supplementary-group mapping, so neither an
 * owner-only mode nor the shared group gets a tool to the file.
 * `sandbox_supervisor.prepare_workspace_read_surface` applies exactly this rule
 * to the whole workspace at boot — which is why a path written *after* boot
 * with an owner-only mode stays invisible to `exec` until the next restart.
 * Every workspace-visible writer therefore applies it to what it creates. The
 * workspace bind is read-only, so widening read bits grants nothing beyond
 * reading files the project already owns.
 *
 * A path that vanished needs no permissions, so failure is silent by design.
 */
export async function mirrorReadBits(target: string): Promise<void> {
  try {
    const mode = (await fs.promises.lstat(target)).mode & 0o7777;
    const ownerReadExecute = mode & 0o500;
    await fs.promises.chmod(
      target,
      (mode & ~0o077) | (ownerReadExecute >> 3) | (ownerReadExecute >> 6),
    );
  } catch {
    // Nothing to widen.
  }
}
