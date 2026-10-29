import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnyAgentTool,
  WorkspaceFileAuthorityContext,
  WorkspacePatchPlan,
} from "openclaw/plugin-sdk/core";
import { LibraryHttpError } from "./library-bridge.js";
import { withLibraryLock } from "./library-lock.js";
import { promotionContentType } from "./library-mime.js";
import {
  atomicWrite,
  expandLibraryToolPath,
  digest,
  LibraryStore,
  libraryRelative,
  readJson,
  resolveLibraryToolTarget,
  safeLibraryPath,
} from "./library-store.js";
import type {
  LibraryBridge,
  LibraryCache,
  LibraryChange,
  LibraryCommit,
  LibraryFile,
  LibraryReceipt,
  LibraryState,
} from "./library-types.js";

type ObservationLedger = { files: Record<string, LibraryFile>; sequence?: number };
type PreparedOperation = { input_digest: string; request: LibraryCommit; receipt?: LibraryReceipt };
const toolNames = new Set(["read", "write", "edit", "apply_patch", "exec", "grep", "find", "ls"]);
const sourcePaths = new Set([
  "BRAND.md",
  "PLAN.md",
  "INTEGRATIONS.md",
  "WORKFLOWS.md",
  "MEMORY.md",
]);
const jsonResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: value,
});
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

export class LibraryRuntime {
  readonly store: LibraryStore;
  private acknowledged: string | undefined;
  active = false;
  constructor(
    readonly workspace: string,
    readonly bridge: LibraryBridge,
    readonly identity?: {
      machine_id: string;
      runtime_release: string;
      process_generation?: string;
    },
  ) {
    this.store = new LibraryStore(workspace, bridge);
  }
  private lock<T>(mode: "shared" | "exclusive", run: () => Promise<T>): Promise<T> {
    return withLibraryLock(path.join(this.store.directory, "lock"), mode, run);
  }
  private async state(): Promise<LibraryState | undefined> {
    const activated = await readJson<{ project_id: string; epoch: number }>(
      path.join(this.store.directory, "activation.json"),
    );
    let state: LibraryState;
    try {
      state = await this.bridge.request<LibraryState>(
        "GET",
        "/state",
        activated ? { project_id: activated.project_id } : undefined,
      );
    } catch (error) {
      if (!activated && error instanceof LibraryHttpError && error.status === 404) return undefined;
      throw error;
    }
    if (
      !state ||
      !["legacy", "shadow", "active", "recovery"].includes(state.mode) ||
      !state.project_id ||
      !Number.isSafeInteger(state.epoch) ||
      !Number.isSafeInteger(state.sequence)
    )
      throw new Error("Invalid Library state");
    if (
      activated &&
      (state.project_id !== activated.project_id ||
        state.epoch < activated.epoch ||
        state.mode === "legacy" ||
        state.mode === "shadow")
    )
      throw new Error("Library activation cannot fall back to legacy storage");
    if (
      (state.mode === "active" || state.mode === "recovery") &&
      (!activated || state.epoch !== activated.epoch)
    ) {
      // Persist activation before capability/publication/network work can fail.
      await atomicWrite(
        path.join(this.store.directory, "activation.json"),
        JSON.stringify({ project_id: state.project_id, epoch: state.epoch }),
      );
    }
    const processState = await readJson<{
      active?: { release_id?: string };
      machine_id?: string;
      process_generation?: string;
    }>(path.join(this.workspace, ".magister/runtime/process-state.json"));
    const identity = this.identity ?? {
      machine_id: process.env.FLY_MACHINE_ID ?? process.env.FLY_ALLOC_ID,
      runtime_release: processState?.active?.release_id,
      process_generation:
        processState?.process_generation ?? process.env.MAGISTER_PROCESS_GENERATION,
    };
    const acknowledgement = JSON.stringify([
      identity.machine_id,
      identity.runtime_release,
      identity.process_generation,
      state.epoch,
    ]);
    if (
      identity.machine_id &&
      identity.runtime_release &&
      identity.process_generation &&
      this.acknowledged !== acknowledgement
    ) {
      await this.bridge.request("POST", "/capabilities", {
        project_id: state.project_id,
        capabilities: ["library_files_v1"],
        ...identity,
        epoch: state.epoch,
      });
      this.acknowledged = acknowledgement;
    }
    if (
      (state.mode === "active" || state.mode === "recovery") &&
      (!identity.machine_id || !identity.runtime_release || !identity.process_generation)
    )
      throw new Error("temporarily_unavailable: Library runtime identity is not ready");
    if (state.mode === "recovery")
      throw new Error("temporarily_unavailable: Library recovery is in progress");
    return state;
  }
  private async admitted(
    refreshSources = false,
  ): Promise<{ state: LibraryState; cache: LibraryCache } | undefined> {
    await this.store.initialize();
    return this.lock("exclusive", async () => {
      let state = await this.state();
      if (!state || state.mode !== "active") {
        this.active = false;
        return undefined;
      }
      if (refreshSources) {
        await this.bridge.request("POST", "/context-ready", { project_id: state.project_id });
        state = await this.state();
        if (!state || state.mode !== "active")
          throw new Error("Library state changed during context admission");
      }
      // /context-ready publishes the required context (audit, brand, plan,
      // memory) or fails closed. Other views publish in the background and
      // their last committed revision stays readable, so a pending results
      // page or plan re-render must not fail every turn and tool call.
      if (!state.coverage.complete)
        throw new Error(
          "publication_pending: Library context is not ready; retry after publication completes",
        );
      const cache = await this.store.reconcile(state.project_id, state.epoch, state.sequence);
      this.active = true;
      return { state, cache };
    });
  }
  async admit(): Promise<boolean> {
    return !!(await this.admitted(true));
  }

  async readSnapshot<T>(read: () => Promise<T>): Promise<T> {
    if (!(await this.admitted())) return read();
    return this.lock("shared", async () => {
      if (await this.store.installing())
        throw new Error("Library context installation must recover");
      return read();
    });
  }

  async writeLegacyProjection(write: () => Promise<void>): Promise<void> {
    await this.store.initialize();
    await this.lock("exclusive", async () => {
      const state = await this.state();
      if (!state) return write();
      if (state.mode === "active") return;
      const lease = await this.bridge.request<{ mode: string; lease_id?: string }>(
        "POST",
        "/legacy-writes",
        {
          project_id: state.project_id,
          writer_id: "hosted.tools",
          operation_id: `projection:${randomUUID()}`,
        },
      );
      // The server serializes this decision with cutover. Never write from a
      // previously read legacy state if the lease now reports cloud authority.
      if (lease.mode === "active" || lease.mode === "recovery") return;
      if (!lease.lease_id) throw new Error("Invalid legacy projection lease");
      await write();
      await this.bridge.request("POST", `/legacy-writes/${lease.lease_id}/complete`, {
        project_id: state.project_id,
      });
    });
  }

  async beginLegacyWrite(
    writerId: "hosted.tools" | "sandbox.promotion",
    operationId: string,
  ): Promise<() => Promise<void>> {
    const state = await this.state();
    if (!state) return async () => {}; // Pre-schema Gateway cannot cut over.
    if (state.mode !== "legacy" && state.mode !== "shadow")
      throw new Error("conflict: Library cutover changed the file authority; retry");
    const lease = await this.bridge.request<{ lease_id: string }>("POST", "/legacy-writes", {
      project_id: state.project_id,
      writer_id: writerId,
      operation_id: operationId,
      expected_epoch: state.epoch,
    });
    if (!lease.lease_id) throw new Error("Invalid legacy file write lease");
    return async () => {
      await this.bridge.request("POST", `/legacy-writes/${lease.lease_id}/complete`, {
        project_id: state.project_id,
      });
    };
  }

  private async legacyTool(
    tool: AnyAgentTool,
    context: WorkspaceFileAuthorityContext,
    args: Parameters<AnyAgentTool["execute"]>,
  ) {
    if (!["write", "edit", "apply_patch"].includes(tool.name)) return tool.execute(...args);
    const session = context.sessionId || context.sessionKey;
    if (!session || !args[0])
      throw new Error("precondition_required: stable identity required for legacy file mutation");
    const complete = await this.beginLegacyWrite(
      "hosted.tools",
      `legacy:${digest(`${session}\0${args[0]}`)}`,
    );
    const result = await tool.execute(...args);
    // A failed/aborted or ambiguous local mutation retains its lease. Operators
    // must reconcile that outcome before cutover; a timeout never releases it.
    if (!record(result).isError) await complete();
    return result;
  }

  private ledgerPath(session: string): string {
    return path.join(this.store.directory, "observations", `${digest(session)}.json`);
  }
  private async ledger(session: string): Promise<ObservationLedger> {
    return (await readJson<ObservationLedger>(this.ledgerPath(session))) ?? { files: {} };
  }
  private async recordRead(session: string, cache: LibraryCache, relative?: string): Promise<void> {
    await withLibraryLock(
      path.join(this.store.directory, "observations", digest(session)),
      "exclusive",
      async () => {
        const ledger = await this.ledger(session);
        if (relative) {
          const file = Object.values(cache.files).find(
            (file) => file.path === relative && file.lifecycle === "active",
          );
          if (file) ledger.files[relative] = file;
        } else {
          // A shell search can touch any admitted file. Do not silently refresh an
          // older observation: only an explicit successful read advances its CAS.
          for (const file of Object.values(cache.files))
            if (file.lifecycle === "active" && !ledger.files[file.path])
              ledger.files[file.path] = file;
          ledger.sequence = Math.min(ledger.sequence ?? cache.sequence, cache.sequence);
        }
        await atomicWrite(this.ledgerPath(session), JSON.stringify(ledger));
      },
    );
  }
  private managedPath(relative: string | undefined, cache: LibraryCache): boolean {
    return (
      !!relative &&
      (sourcePaths.has(relative) ||
        relative === "resources" ||
        relative.startsWith("resources/") ||
        Object.values(cache.files).some(
          (file) =>
            file.path === relative ||
            (file.entry_type === "directory" && relative.startsWith(`${file.path}/`)),
        ))
    );
  }
  private async base(
    relative: string,
    session: string,
    cache: LibraryCache,
  ): Promise<LibraryFile | undefined> {
    const current = Object.values(cache.files).find(
      (file) => file.path === relative && file.lifecycle === "active",
    );
    if (current?.ownership === "managed" || sourcePaths.has(relative))
      throw new Error(
        `managed_file: ${relative}; edit its source with ${JSON.stringify(current?.managed_edit_target ?? "the owning feature")}`,
      );
    const observed = (await this.ledger(session)).files[relative];
    if (!current) {
      if (observed) throw new Error(`moved: ${relative}; reread the current Library path`);
      return undefined;
    }
    if (!observed)
      throw new Error(
        `precondition_required: read ${relative} before replacing, editing or deleting it`,
      );
    if (observed.file_id !== current.file_id || observed.revision_id !== current.revision_id)
      throw new Error(`conflict: ${relative} changed since your read; reread before editing`);
    return observed;
  }
  private operationPath(session: string, toolCallId: string): string {
    return path.join(
      this.store.directory,
      "operations",
      `${digest(`${session}\0${toolCallId}\0file-commit`)}.json`,
    );
  }
  private async commit(
    session: string,
    toolCallId: string,
    input: unknown,
    state: LibraryState,
    prepare: () => Promise<LibraryChange[]>,
  ): Promise<LibraryReceipt> {
    if (!toolCallId || !session)
      throw new Error("precondition_required: stable tool and session identity required");
    const operationPath = this.operationPath(session, toolCallId);
    const inputDigest = digest(canonical(input));
    let operation = await readJson<PreparedOperation>(operationPath);
    if (operation && operation.input_digest !== inputDigest)
      throw new Error("operation_key_reused: tool retry changed its arguments");
    if (!operation) {
      const changes = await prepare();
      if (!changes.length || changes.length > 20)
        throw new Error("limit_exceeded: atomic file change count");
      const sizes = changes.map((change) =>
        "text" in change && typeof change.text === "string" ? Buffer.byteLength(change.text) : 0,
      );
      if (
        sizes.some((size) => size > 1024 * 1024) ||
        sizes.reduce((a, b) => a + b, 0) > 2 * 1024 * 1024
      )
        throw new Error("limit_exceeded: atomic file content size");
      operation = {
        input_digest: inputDigest,
        request: {
          project_id: state.project_id,
          operation_id: `runtime:${digest(`${session}\0${toolCallId}\0file-commit`)}`,
          expected_epoch: state.epoch,
          changes,
        },
      };
      await atomicWrite(operationPath, JSON.stringify(operation));
    }
    if (!operation.receipt) {
      let receipt: LibraryReceipt;
      try {
        receipt = await this.bridge.request<LibraryReceipt>("POST", "/commit", operation.request);
      } catch (error) {
        if (error instanceof LibraryHttpError && record(error.body).status === "rejected")
          receipt = error.body as LibraryReceipt;
        else throw error; // Leave the exact prepared request durable for retry.
      }
      if (
        receipt.operation_id !== operation.request.operation_id ||
        receipt.project_id !== state.project_id ||
        !["committed", "rejected"].includes(receipt.status)
      )
        throw new Error("Invalid Library operation receipt");
      operation.receipt = receipt;
      await atomicWrite(operationPath, JSON.stringify(operation));
    }
    const receipt = operation.receipt;
    if (receipt.status === "committed") {
      // An old replay may follow a newer local install. Reconcile monotonically;
      // never write bytes taken directly from this potentially stale receipt.
      try {
        for (const file of receipt.files) {
          const change = operation.request.changes.find(
            (change) =>
              (change.kind === "replace" && change.file_id === file.file_id) ||
              (change.kind === "create" && change.path === file.path),
          );
          if (change && "text" in change && typeof change.text === "string")
            await this.store.seedObject(file, Buffer.from(change.text));
        }
        const latest = await this.state();
        if (!latest || latest.mode !== "active") throw new Error("Library is not active");
        await this.store.reconcile(
          latest.project_id,
          latest.epoch,
          Math.max(latest.sequence, receipt.sequence),
        );
        return { ...receipt, materialization: "not_required" };
      } catch {
        return { ...receipt, materialization: "pending" };
      }
    }
    return receipt;
  }
  private async changeForWrite(
    relative: string,
    text: string,
    session: string,
    cache: LibraryCache,
  ): Promise<LibraryChange> {
    const base = await this.base(relative, session, cache);
    if (!base) {
      const existing = await fs.lstat(path.join(this.workspace, relative)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (existing)
        throw new Error(
          `conflict: ${relative} has unregistered local bytes; reconcile the Library inventory first`,
        );
    }
    return base
      ? { kind: "replace", file_id: base.file_id, expected_revision: base.revision_id, text }
      : { kind: "create", path: relative, expected_absent: true, text };
  }
  private async patchChanges(
    plan: WorkspacePatchPlan,
    session: string,
    cache: LibraryCache,
  ): Promise<LibraryChange[]> {
    const relative = (input: string) => {
      const value = libraryRelative(this.workspace, input);
      if (!value || !this.managedPath(value, cache))
        throw new Error("invalid_path: mixed Library and local patch targets");
      return value;
    };
    const bases = new Map<string, LibraryFile | undefined>();
    for (const raw of plan.paths) {
      const name = relative(raw);
      await safeLibraryPath(this.workspace, name);
      // Validate all ownership/preconditions before computing any changes.
      bases.set(name, await this.base(name, session, cache));
    }
    const staged = await plan.stage(async (raw) => {
      const file = bases.get(relative(raw));
      if (!file) throw new Error(`not_found: ${raw}`);
      return this.store.text(file);
    });
    const changes: LibraryChange[] = [];
    const touched = new Set<string>();
    for (const change of staged) {
      const name = relative(change.path);
      if (touched.has(name)) throw new Error("invalid_path: duplicate patch target");
      touched.add(name);
      const file = bases.get(name);
      if (change.kind === "delete") {
        if (!file) throw new Error(`not_found: ${name}`);
        changes.push({ kind: "trash", file_id: file.file_id, expected_revision: file.revision_id });
      } else {
        if (change.kind === "add" && file) throw new Error(`conflict: ${name} already exists`);
        if (change.kind === "update" && !file) throw new Error(`not_found: ${name}`);
        changes.push(await this.changeForWrite(name, change.text, session, cache));
        if (change.movePath && file) {
          const destination = relative(change.movePath);
          if (bases.get(destination) || touched.has(destination))
            throw new Error(`conflict: ${destination} already exists`);
          touched.add(destination);
          changes.push({
            kind: "move",
            file_id: file.file_id,
            expected_revision: file.revision_id,
            path: destination,
          });
        }
      }
    }
    return changes;
  }
  /** Rename or trash a Library file. Hosted models reach providers through the
   * Gateway, so apply_patch's move is unavailable and exec cannot write the
   * workspace: without these an agent could not rename or remove a file. */
  fileTool(
    name: "move_file" | "trash_file",
    context: { sessionId?: string; sessionKey?: string },
  ): AnyAgentTool {
    const runtime = this;
    const move = name === "move_file";
    const properties: Record<string, unknown> = {
      path: { type: "string", description: "Current Library path, e.g. resources/brief.md" },
    };
    if (move) properties.destination = { type: "string", description: "New path under resources/" };
    return {
      name,
      label: move ? "Move Library file" : "Trash Library file",
      description: move
        ? "Rename or move one Library file you have read, keeping its history. Fails if the destination exists."
        : "Move one Library file you have read to the recoverable Library trash.",
      parameters: {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
      execute: async (toolCallId: string, args: unknown) => {
        const params = record(args);
        const admitted = await runtime.admitted();
        if (!admitted)
          throw new Error(
            "temporarily_unavailable: Library file authority is not active for this project",
          );
        const session = context.sessionId || context.sessionKey;
        if (!session) throw new Error("precondition_required: Library session identity is missing");
        const relative = libraryRelative(runtime.workspace, String(params.path ?? ""));
        const destination = move
          ? libraryRelative(runtime.workspace, String(params.destination ?? ""))
          : undefined;
        if (!relative || !runtime.managedPath(relative, admitted.cache))
          throw new Error("invalid_path: not a Library file");
        await safeLibraryPath(runtime.workspace, relative);
        if (destination !== undefined) {
          // A move may only land on a new, unowned path under resources/.
          if (!destination.startsWith("resources/") || destination === relative)
            throw new Error("invalid_path: move to a new path under resources/");
          await safeLibraryPath(runtime.workspace, destination);
        }
        return runtime.lock("exclusive", async () => {
          await runtime.store.recover();
          const cache = await runtime.store.cache();
          if (!cache) throw new Error("temporarily_unavailable: Library cache missing");
          const receipt = await runtime.commit(
            session,
            toolCallId,
            { tool: name, args },
            admitted.state,
            async () => {
              const base = await runtime.base(relative, session, cache);
              if (!base) throw new Error(`not_found: ${relative}`);
              if (destination) {
                const entries = Object.values(cache.files);
                // Any lifecycle: a trashed entry still owns its path for restore.
                if (entries.some((f) => f.path === destination))
                  throw new Error(`conflict: ${destination} already exists`);
                if (
                  entries.some(
                    (f) => f.ownership === "managed" && destination.startsWith(`${f.path}/`),
                  )
                )
                  throw new Error(`managed_file: ${destination} is inside a system-owned view`);
                const local = await fs
                  .lstat(path.join(runtime.workspace, destination))
                  .catch((error) => {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                    throw error;
                  });
                if (local)
                  throw new Error(
                    `conflict: ${destination} has unregistered local bytes; reconcile the Library inventory first`,
                  );
              }
              return [
                destination
                  ? {
                      kind: "move",
                      file_id: base.file_id,
                      expected_revision: base.revision_id,
                      path: destination,
                    }
                  : { kind: "trash", file_id: base.file_id, expected_revision: base.revision_id },
              ];
            },
          );
          return jsonResult(receipt);
        });
      },
    } as AnyAgentTool;
  }
  wrap(tool: AnyAgentTool, context: WorkspaceFileAuthorityContext): AnyAgentTool {
    if (!toolNames.has(tool.name)) return tool;
    const runtime = this;
    return {
      ...tool,
      execute: async (toolCallId, args, signal, onUpdate) => {
        const params = record(args);
        const rawPath = params.path ?? params.file_path;
        const patch =
          tool.name === "apply_patch" ? context.planPatch(String(params.input ?? "")) : undefined;
        for (const input of patch?.paths ?? (typeof rawPath === "string" ? [rawPath] : [])) {
          const absolute = path.resolve(runtime.workspace, expandLibraryToolPath(input));
          const resolved = await resolveLibraryToolTarget(absolute);
          for (const candidate of [absolute, resolved]) {
            const internal = path.relative(runtime.store.directory, candidate);
            if (
              !internal ||
              (!internal.startsWith(`..${path.sep}`) &&
                internal !== ".." &&
                !path.isAbsolute(internal))
            )
              throw new Error("invalid_path: Library control files are private runtime state");
          }
        }
        const admitted = await runtime.admitted();
        if (!admitted)
          return runtime.legacyTool(tool, context, [toolCallId, args, signal, onUpdate]);
        const session = context.sessionId || context.sessionKey;
        if (!session) throw new Error("precondition_required: Library session identity is missing");
        const realWorkspace = await fs.realpath(runtime.workspace);
        for (const input of patch?.paths ?? (typeof rawPath === "string" ? [rawPath] : [])) {
          const relative = libraryRelative(runtime.workspace, input);
          const resolved = libraryRelative(
            realWorkspace,
            await resolveLibraryToolTarget(
              path.resolve(runtime.workspace, expandLibraryToolPath(input)),
            ),
          );
          const normalized = libraryRelative(
            runtime.workspace,
            input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " "),
          );
          if (
            (resolved !== relative && runtime.managedPath(resolved, admitted.cache)) ||
            (!runtime.managedPath(relative, admitted.cache) &&
              runtime.managedPath(normalized, admitted.cache))
          )
            throw new Error("invalid_path: aliases cannot bypass Library file authority");
        }
        const relative =
          typeof rawPath === "string" ? libraryRelative(runtime.workspace, rawPath) : undefined;
        const patchPaths = patch?.paths.map((entry) => libraryRelative(runtime.workspace, entry));
        const managed = patchPaths
          ? patchPaths.some((entry) => runtime.managedPath(entry, admitted.cache))
          : runtime.managedPath(relative, admitted.cache);
        if (
          patchPaths &&
          managed &&
          !patchPaths.every((entry) => runtime.managedPath(entry, admitted.cache))
        )
          throw new Error("invalid_path: an atomic patch cannot mix Library and local paths");
        if (["write", "edit", "apply_patch"].includes(tool.name)) {
          if (!managed) return tool.execute(toolCallId, args, signal, onUpdate);
          return runtime.lock("exclusive", async () => {
            await runtime.store.recover();
            const cache = await runtime.store.cache();
            if (!cache) throw new Error("temporarily_unavailable: Library cache missing");
            const receipt = await runtime.commit(
              session,
              toolCallId,
              { tool: tool.name, args },
              admitted.state,
              async () => {
                if (patch) return runtime.patchChanges(patch, session, cache);
                if (!relative) throw new Error("invalid_path");
                await safeLibraryPath(runtime.workspace, relative);
                if (tool.name === "write") {
                  if (typeof params.content !== "string")
                    throw new Error("File content is required");
                  return [await runtime.changeForWrite(relative, params.content, session, cache)];
                }
                const base = await runtime.base(relative, session, cache);
                if (!base) throw new Error(`not_found: ${relative}`);
                // The edit tool's own schema is `edits: [{oldText, newText}]`;
                // the single-pair form is kept for older callers.
                const edits = Array.isArray(params.edits)
                  ? params.edits.map((entry) => record(entry))
                  : [
                      {
                        oldText: params.oldText ?? params.old_string,
                        newText: params.newText ?? params.new_string,
                      },
                    ];
                const text = await runtime.store.text(base);
                // Like the edit tool: every oldText matches exactly once in the
                // revision read, edits do not overlap, and all apply together.
                const spans = edits.map(({ oldText, newText }) => {
                  if (typeof oldText !== "string" || !oldText || typeof newText !== "string")
                    throw new Error("Exact oldText and newText are required");
                  const start = text.indexOf(oldText);
                  if (start < 0 || text.indexOf(oldText, start + 1) >= 0)
                    throw new Error(
                      "conflict: oldText must match exactly once in the revision read",
                    );
                  return { start, end: start + oldText.length, newText };
                });
                if (!spans.length) throw new Error("Exact oldText and newText are required");
                spans.sort((a, b) => a.start - b.start);
                let edited = "";
                let cursor = 0;
                for (const span of spans) {
                  if (span.start < cursor) throw new Error("conflict: edits overlap");
                  edited += text.slice(cursor, span.start) + span.newText;
                  cursor = span.end;
                }
                return [
                  {
                    kind: "replace",
                    file_id: base.file_id,
                    expected_revision: base.revision_id,
                    text: edited + text.slice(cursor),
                  },
                ];
              },
            );
            return jsonResult(receipt);
          });
        }
        return runtime.lock("shared", async () => {
          // A writer may have completed between admission and acquiring this read
          // lock. Record the revision actually installed, not admission's earlier one.
          const cache = await runtime.store.cache();
          if (!cache) throw new Error("temporarily_unavailable: Library cache missing");
          if (await runtime.store.installing())
            throw new Error(
              "temporarily_unavailable: Library installation must recover before reading",
            );
          if (managed && relative) await safeLibraryPath(runtime.workspace, relative);
          const file =
            tool.name === "read" && managed && relative
              ? Object.values(cache.files).find(
                  (file) => file.path === relative && file.lifecycle === "active",
                )
              : undefined;
          // The underlying read tool normalizes some Unicode spaces. For exact
          // UTF-8 Library names, read the verified immutable local object so it
          // cannot silently return a differently named file and record its CAS.
          const exactRead = file && /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(file.path);
          const readArgs = exactRead
            ? { ...params, path: runtime.store.object(file), file_path: runtime.store.object(file) }
            : args;
          const result = await tool.execute(toolCallId, readArgs, signal, onUpdate);
          if (exactRead && relative) {
            for (const content of result.content) {
              if (content.type === "text")
                content.text = content.text.replaceAll(runtime.store.object(file), relative);
            }
          }
          const details = record(result.details);
          if (
            (tool.name !== "read" || managed) &&
            !record(result).isError &&
            details.status !== "running" &&
            details.status !== "error"
          )
            await runtime.recordRead(session, cache, tool.name === "read" ? relative : undefined);
          return result;
        });
      },
    };
  }
  async promote(
    input: {
      attempt_id: string;
      destination_path: string;
      sha256: string;
      replace_sha256?: string;
    },
    bytes?: Buffer,
  ): Promise<LibraryReceipt | undefined> {
    const admitted = await this.admitted();
    if (!admitted) return undefined;
    if (!this.managedPath(input.destination_path, admitted.cache))
      throw new Error("invalid_path: promote generated files into resources/");
    if (bytes && digest(bytes) !== input.sha256)
      throw new Error("Artifact changed before Library promotion");
    return this.lock("exclusive", async () => {
      const cache = await this.store.cache();
      if (!cache) throw new Error("temporarily_unavailable: Library cache missing");
      const stableInput = {
        attempt_id: input.attempt_id,
        destination_path: input.destination_path,
        sha256: input.sha256,
        replace_sha256: input.replace_sha256,
      };
      return this.commit(
        `promotion:${input.attempt_id}`,
        input.destination_path,
        stableInput,
        admitted.state,
        async () => {
          if (!bytes)
            throw new Error("not_found: promotion has no staged bytes or persisted request");
          const current = Object.values(cache.files).find(
            (file) => file.path === input.destination_path && file.lifecycle === "active",
          );
          if (current?.ownership === "managed") throw new Error("managed_file");
          if (current && (!input.replace_sha256 || current.sha256 !== input.replace_sha256))
            throw new Error("precondition_required: promotion overwrite needs the exact hash read");
          const operationId = `upload:${digest(`${input.attempt_id}\0${input.destination_path}\0${input.sha256}`)}`;
          const contentType = promotionContentType(input.destination_path);
          const upload = await this.bridge.request<{
            upload_id: string;
            upload_url: string;
            verified?: boolean;
          }>("POST", "/uploads", {
            project_id: admitted.state.project_id,
            operation_id: operationId,
            path: input.destination_path,
            size: bytes.byteLength,
            sha256: input.sha256,
            content_type: contentType,
          });
          if (!upload.verified) {
            await this.bridge.upload(upload.upload_url, bytes, contentType);
            await this.bridge.request("POST", `/uploads/${upload.upload_id}/finalize`, {
              project_id: admitted.state.project_id,
            });
          }
          return [
            current
              ? {
                  kind: "replace",
                  file_id: current.file_id,
                  expected_revision: current.revision_id,
                  upload_id: upload.upload_id,
                }
              : {
                  kind: "create",
                  path: input.destination_path,
                  expected_absent: true,
                  upload_id: upload.upload_id,
                },
          ];
        },
      );
    });
  }

  async replayPromotion(input: {
    attempt_id: string;
    destination_path: string;
    sha256: string;
    replace_sha256?: string;
  }): Promise<LibraryReceipt | undefined> {
    if (
      !(await readJson(this.operationPath(`promotion:${input.attempt_id}`, input.destination_path)))
    )
      return undefined;
    return this.promote(input);
  }
}
