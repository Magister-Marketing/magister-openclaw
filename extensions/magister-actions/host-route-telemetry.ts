import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";

/** The Gateway-called host routes that answer their own failures. */
export type HostRoute =
  | "magister_artifact_promotion"
  | "magister_repo_checkout"
  | "magister_repo_prepare"
  | "magister_repo_push"
  | "magister_repo_install";

const LABEL_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/** A low-cardinality, credential-free label for a caught failure: the errno
 *  code when there is one, else the error class name. Never the message, which
 *  carries filesystem paths and, on the repository routes, git output that can
 *  echo a remote URL. Lowercased to fit the machine-telemetry name allowlist. */
export function failureReasonCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && LABEL_RE.test(code)) {
    return code.toLowerCase();
  }
  const name = error instanceof Error ? error.name : undefined;
  if (typeof name === "string" && LABEL_RE.test(name)) {
    return name.toLowerCase();
  }
  return "unknown";
}

/** A route that answered 500 for a failure it did not anticipate.
 *
 *  These handlers catch everything, so the plugin host's own
 *  `http.request.error` (emitted only when a handler throws) never fires for
 *  them. This is that same event, plus what the host cannot know: which route,
 *  and why. The Gateway sees only the bare 500. */
export function reportHostRouteFailure(route: HostRoute, error: unknown): void {
  try {
    emitTrustedDiagnosticEvent({
      type: "http.request.error",
      surface: "plugin_http",
      failureKind: "handler_exception",
      toolName: route,
      reasonCode: failureReasonCode(error),
    });
  } catch {
    // Telemetry must never change the answer the caller gets.
  }
}

/** Cleanup that failed after the operation committed. Warn-level, never an
 *  issue: the caller's result stands and the residue has another owner. */
export function reportCleanupFailure(route: HostRoute, error: unknown): void {
  try {
    emitTrustedDiagnosticEvent({
      type: "plugin.cleanup.failed",
      pluginId: "magister-actions",
      toolName: route,
      reasonCode: failureReasonCode(error),
    });
  } catch {
    // Telemetry must never change the answer the caller gets.
  }
}
