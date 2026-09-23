import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { MagisterIntegrationsContextEngine } from "./magister-integrations.js";
import { MagisterPlanContextEngine } from "./magister-plan.js";
import { renderMagisterContextBlock } from "./magister-provenance.js";
import { MagisterWorkflowsContextEngine } from "./magister-workflows.js";
import { registerContextEngine } from "./registry.js";
import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  ContextEngineRuntimeContext,
  IngestResult,
} from "./types.js";

const DEFAULT_MEMORY_PATH = "/data/.openclaw/workspace/MEMORY.md";
const DEFAULT_USER_PATH = "/data/.openclaw/workspace/USER.md";
const DEFAULT_PROJECT_PATH = "/data/.openclaw/workspace/PROJECT.md";
const DEFAULT_BRAND_PATH = "/data/.openclaw/workspace/BRAND.md";
const MAX_TRACKED_SESSIONS = 200;
// Two budget tiers. Brand-shaped work gets the whole profile; every other turn
// still gets a floor, because the agent cannot ask for context it was never
// told exists, and a one-turn keyword guess is wrong far more often than it is
// right — "write me a blog post", "make an X post", "draft an Instagram
// caption" and "write an article" all matched nothing under the old gate and
// therefore produced off-brand work with no signal that anything was missing.
const MAX_BRAND_CONTEXT_CHARS = 4_500;
const MAX_USER_BRAND_CHARS = 2_500;
const MAX_BRAND_CORE_CHARS = 1_200;
const MAX_USER_BRAND_CORE_CHARS = 500;
const BRAND_GENERATED_START = "<!-- MAGISTER:GENERATED BRAND START -->";
const BRAND_GENERATED_END = "<!-- MAGISTER:GENERATED BRAND END -->";
// Deliberately broad: the cost of a false positive is a few hundred cached-miss
// characters, the cost of a false negative is a deliverable in the wrong voice
// and the wrong colors. Verbs and artifact nouns are both listed because users
// name the artifact ("a blog post") far more often than the discipline
// ("content"). Kept as one alternation so the gate stays a single pass.
const BRAND_TASK_PATTERN = new RegExp(
  "\\b(" +
    [
      // disciplines and brand vocabulary
      "ad|ads|audience|brand|campaign|content|copy|creative|design|editorial",
      "identity|logo|message|messaging|palette|positioning|style|theme|tone",
      "typography|visual|voice",
      // artifacts the user actually names
      "advert|article|banner|blog|blurb|bio|byline|caption|card|carousel",
      "case ?study|cta|deck|email|essay|flyer|graphic|headline|hero|homepage",
      "illustration|image|infographic|landing|launch|mockup|newsletter|op-?ed",
      "outline|page|photo|picture|pitch|post|poster|presentation",
      "press ?release|promo|reel|script|short|slide|slogan|snippet|story",
      "subject ?line|tagline|teaser|thread|thumbnail|title|tweet|video",
      "voiceover|whitepaper|wordmark",
      // channels that imply a published artifact
      "facebook|instagram|linkedin|pinterest|reddit|snapchat|social|threads",
      "tiktok|twitter|x\\.com|youtube",
      // production verbs
      "announce|compose|craft|draft|generate|illustrate|publish",
      "rewrite|schedule|write",
    ].join("|") +
    ")\\b",
  "i",
);

type Options = {
  memoryPath?: string;
  userPath?: string;
  projectPath?: string;
  brandPath?: string;
  inner?: ContextEngine;
};

/**
 * Wraps another context engine (default: MagisterIntegrationsContextEngine) and
 * folds MEMORY.md + USER.md content into the system prompt as a FROZEN SNAPSHOT
 * per session.
 *
 * Why frozen: Anthropic prompt caching requires byte-identical prefixes across
 * turns. Re-reading the files every turn (as MagisterIntegrationsContextEngine
 * does for INTEGRATIONS.md, which is fine because integrations change rarely)
 * would invalidate the cache every time the agent's own memory tool wrote a
 * new entry mid-session. So we cache by sessionId on the first assemble() call
 * and never re-read for that session — mid-session writes are durable to disk
 * but only appear in the NEXT session's system prompt.
 */
export class MagisterMemoryContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "magister-memory",
    name: "Magister Memory Context Engine",
    version: "1.2.0",
    ownsWorkspaceBootstrapFiles: ["MEMORY.md", "USER.md", "PROJECT.md", "BRAND.md"],
  };

  private readonly inner: ContextEngine;
  private readonly memoryPath: string;
  private readonly userPath: string;
  private readonly projectPath: string;
  private readonly brandPath: string;
  private readonly snapshotBySession = new Map<string, string>();

  constructor(options: Options = {}) {
    this.inner = options.inner ?? new MagisterIntegrationsContextEngine();
    this.memoryPath = options.memoryPath ?? DEFAULT_MEMORY_PATH;
    this.userPath = options.userPath ?? DEFAULT_USER_PATH;
    this.projectPath = options.projectPath ?? DEFAULT_PROJECT_PATH;
    this.brandPath = options.brandPath ?? DEFAULT_BRAND_PATH;
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return this.inner.ingest(params);
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    citationsMode?: MemoryCitationsMode;
    model?: string;
    prompt?: string;
  }): Promise<AssembleResult> {
    const innerResult = await this.inner.assemble(params);

    let snapshot = this.snapshotBySession.get(params.sessionId);
    if (!snapshot) {
      // Re-render while empty: a session that starts before the provision-time
      // seed files exist must pick them up on a later turn instead of staying
      // blind for its whole life. Freezing begins once content appears — the
      // addition lands below the cache boundary, so the one-time
      // empty→content flip does not invalidate the stable prefix.
      snapshot = await this.renderSnapshot();
      if (snapshot) {
        this.rememberSnapshot(params.sessionId, snapshot);
      }
    }

    const brandContext = await this.renderBrandContext(params.prompt);
    if (!snapshot && !brandContext) {
      return innerResult;
    }

    const previous = innerResult.systemPromptAddition?.trim();
    const merged = [previous, snapshot, brandContext].filter(Boolean).join("\n\n");
    return { ...innerResult, systemPromptAddition: merged };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    if (this.inner.afterTurn) {
      await this.inner.afterTurn(params);
    }
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    return this.inner.compact(params);
  }

  async dispose(): Promise<void> {
    if (this.inner.dispose) {
      await this.inner.dispose();
    }
    this.snapshotBySession.clear();
  }

  private async renderSnapshot(): Promise<string> {
    const [memory, user, project] = await Promise.all([
      readTextOrEmpty(this.memoryPath),
      readTextOrEmpty(this.userPath),
      readTextOrEmpty(this.projectPath),
    ]);

    const blocks: string[] = [];
    if (memory) {
      blocks.push(
        renderMagisterContextBlock({
          provenance: "trusted_project_state",
          source: "older_inferred_memory",
          title: "Memory (about the project)",
          content: memory,
        }),
      );
    }
    if (user) {
      blocks.push(
        renderMagisterContextBlock({
          provenance: "trusted_project_state",
          source: "confirmed_user_profile",
          title: "User Profile",
          content: user,
        }),
      );
    }
    if (project) {
      blocks.push(
        renderMagisterContextBlock({
          provenance: "trusted_project_state",
          source: "project_assignment",
          title: "Project Assignment",
          content: project,
        }),
      );
    }
    return blocks.join("\n\n");
  }

  private async renderBrandContext(prompt: string | undefined): Promise<string> {
    const raw = await readTextOrEmpty(this.brandPath);
    if (!raw) {
      return "";
    }
    const start = raw.indexOf(BRAND_GENERATED_START);
    const end = raw.indexOf(BRAND_GENERATED_END, start + BRAND_GENERATED_START.length);
    const generated =
      start >= 0 && end > start ? raw.slice(start + BRAND_GENERATED_START.length, end).trim() : "";
    const userAuthored = (
      start >= 0 && end > start
        ? `${raw.slice(0, start)}\n${raw.slice(end + BRAND_GENERATED_END.length)}`
        : raw
    )
      .replace(/^# Brand context\s*/i, "")
      .replace(
        /^Content outside the generated markers is user-owned and takes precedence\.\s*/i,
        "",
      )
      .trim();

    const brandTask = Boolean(prompt) && BRAND_TASK_PATTERN.test(prompt as string);
    const userBudget = brandTask ? MAX_USER_BRAND_CHARS : MAX_USER_BRAND_CORE_CHARS;
    const totalBudget = brandTask ? MAX_BRAND_CONTEXT_CHARS : MAX_BRAND_CORE_CHARS;

    const boundedUser = boundUserBrand(userAuthored, userBudget);
    const remaining = Math.max(0, totalBudget - boundedUser.length);
    const boundedGenerated = boundGeneratedBrandSections(generated, remaining);
    return [
      boundedUser
        ? renderMagisterContextBlock({
            provenance: "user_authored_content",
            source: "brand_file_overrides",
            title: "Confirmed brand guide and overrides",
            content: boundedUser,
          })
        : "",
      boundedGenerated
        ? renderMagisterContextBlock({
            provenance: "trusted_project_state",
            source: "current_audit_inference",
            title: "Current bounded audit-derived brand claims",
            content: boundedGenerated,
          })
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private rememberSnapshot(sessionId: string, snapshot: string): void {
    // Map preserves insertion order; re-inserting on hit gives LRU eviction.
    this.snapshotBySession.delete(sessionId);
    this.snapshotBySession.set(sessionId, snapshot);
    pruneMapToMaxSize(this.snapshotBySession, MAX_TRACKED_SESSIONS);
  }
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf-8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/** Trim to a whole line rather than mid-sentence, and say so. */
function boundUserBrand(text: string, budget: number): string {
  if (text.length <= budget) {
    return text;
  }
  if (budget <= 0) {
    return "";
  }
  const cut = text.slice(0, budget);
  const lastBreak = cut.lastIndexOf("\n");
  const kept = (lastBreak > budget / 2 ? cut.slice(0, lastBreak) : cut).trimEnd();
  return `${kept}\n\n(Truncated. Read \`BRAND.md\` for the rest of the confirmed guide.)`;
}

/**
 * Drop whole trailing `## ` sections instead of slicing mid-section.
 *
 * A blind `slice()` used to cut the generated block at an arbitrary character,
 * which silently amputated whichever section happened to render last and left
 * the agent with no way to know something was missing — it read confident,
 * complete brand context and simply had no colors in it. Dropping whole
 * sections and naming them turns that into a legible gap the agent can close by
 * reading `BRAND.md`, which AGENTS.md already permits.
 */
function boundGeneratedBrandSections(generated: string, budget: number): string {
  if (!generated || budget <= 0) {
    return "";
  }
  if (generated.length <= budget) {
    return generated;
  }

  const headingAt = generated.indexOf("\n## ");
  const preamble = headingAt === -1 ? generated : generated.slice(0, headingAt);
  if (headingAt === -1) {
    return boundUserBrand(generated, budget);
  }

  const sections: { title: string; text: string }[] = [];
  const rest = generated.slice(headingAt + 1);
  for (const chunk of rest.split(/\n(?=## )/)) {
    const title = (chunk.match(/^## (.+)$/m)?.[1] ?? "").trim();
    sections.push({ title, text: chunk.replace(/\s+$/, "") });
  }

  const notice = (names: string[]) =>
    `\n\n(Omitted for length: ${names.join(", ")}. Read \`BRAND.md\` for these.)`;

  // Keep the longest leading run of whole sections that fits *including* the
  // notice naming what was dropped. Prefix order is meaningful: the gateway
  // renders Essence, Voice, then Visual identity before the long prose
  // sections precisely so identity survives the smallest budget.
  for (let keptCount = sections.length; keptCount > 0; keptCount -= 1) {
    const kept = sections.slice(0, keptCount);
    const dropped = sections.slice(keptCount);
    const body = `${preamble}\n\n${kept.map((section) => section.text).join("\n\n")}`.trimEnd();
    const suffix = dropped.length
      ? notice(dropped.map((section) => section.title || "an unnamed section"))
      : "";
    if (body.length + suffix.length <= budget) {
      return `${body}${suffix}`;
    }
  }
  return boundUserBrand(generated, budget);
}

/**
 * Production composition for the 'magister-memory' slot, shared by the
 * registry factory and tests. When a `workspaceDir` is provided (the resolver
 * passes the run's agent workspace), the memory/user/project/brand files are
 * read from that workspace; otherwise the historical marketing-root defaults
 * apply. This keeps a non-root agent (e.g. heartbeat) from being served the
 * marketing agent's files.
 */
export function createMagisterMemoryContextEngine(options?: {
  workspaceDir?: string;
}): MagisterMemoryContextEngine {
  const ws = options?.workspaceDir?.trim();
  return new MagisterMemoryContextEngine({
    inner: new MagisterPlanContextEngine({
      inner: new MagisterWorkflowsContextEngine({
        inner: new MagisterIntegrationsContextEngine(),
      }),
    }),
    ...(ws
      ? {
          memoryPath: join(ws, "MEMORY.md"),
          userPath: join(ws, "USER.md"),
          projectPath: join(ws, "PROJECT.md"),
          brandPath: join(ws, "BRAND.md"),
        }
      : {}),
  });
}

export function registerMagisterMemoryContextEngine(): void {
  // Compose ON TOP of magister-plan so the active 'magister-memory' slot folds
  // MEMORY.md + USER.md (frozen per-session snapshot), the live marketing plan,
  // WORKFLOWS.md, and INTEGRATIONS.md. The chain is:
  //   MagisterMemoryContextEngine (frozen)
  //     -> MagisterPlanContextEngine (per-turn gateway summary + PLAN.md fallback)
  //       -> MagisterWorkflowsContextEngine (per-turn)
  //         -> MagisterIntegrationsContextEngine (per-turn)
  //           -> LegacyContextEngine
  registerContextEngine("magister-memory", (ctx) =>
    createMagisterMemoryContextEngine({ workspaceDir: ctx?.workspaceDir }),
  );
}
