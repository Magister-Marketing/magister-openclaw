import fs, { type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOsHomeDir } from "../../infra/home-dir.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CONFIG_DIR, resolveHomeDir, resolveUserPath } from "../../utils.js";
import { readActiveRuntimeBundle } from "../runtime-bundle-presence.js";
import { resolveSandboxPath } from "../sandbox-paths.js";
import {
  resolveEffectiveAgentSkillFilter,
  resolveEffectiveAgentSkillsLimits,
} from "./agent-filter.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { shouldIncludeSkill } from "./config.js";
import { normalizeSkillFilter } from "./filter.js";
import { resolveOpenClawMetadata, resolveSkillInvocationPolicy } from "./frontmatter.js";
import {
  loadSkillsFromDirSafe,
  readSkillFileSafe,
  readSkillFrontmatterSafe,
} from "./local-loader.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import { serializeByKey } from "./serialize.js";
import { formatSkillsForPrompt, type Skill } from "./skill-contract.js";
import type {
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
} from "./types.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");

/**
 * Replace the user's home directory prefix with `~` in skill file paths
 * to reduce system prompt token usage. Models understand `~` expansion,
 * and the read tool resolves `~` to the home directory.
 *
 * Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
 *       → `~/.bun/.../skills/github/SKILL.md`
 *
 * Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
 */
function resolveUserHomeDir(): string | undefined {
  return resolveOsHomeDir(process.env, os.homedir);
}

function resolveNativeUserHomeDir(): string | undefined {
  try {
    return path.resolve(os.homedir());
  } catch {
    return undefined;
  }
}

function resolveCompactHomePrefixes(): string[] {
  const homes = [resolveHomeDir(), resolveUserHomeDir(), resolveNativeUserHomeDir()].filter(
    (home): home is string => !!home,
  );
  const resolvedHomes = homes.map((home) => path.resolve(home));
  const realHomes = resolvedHomes
    .map((home) => tryRealpath(home))
    .filter((home): home is string => !!home);
  return [...resolvedHomes, ...realHomes]
    .filter((home, index, all) => all.indexOf(home) === index)
    .sort((a, b) => b.length - a.length);
}

function compactSkillPaths(skills: Skill[]): Skill[] {
  const homes = resolveCompactHomePrefixes();
  if (homes.length === 0) return skills;
  return skills.map((s) => ({
    ...s,
    filePath: compactHomePath(s.filePath, homes),
  }));
}

function compactHomePath(filePath: string, homes: readonly string[]): string {
  for (const home of homes) {
    const prefix = home.endsWith(path.sep) ? home : home + path.sep;
    if (filePath.startsWith(prefix)) {
      return "~/" + filePath.slice(prefix.length);
    }
  }
  return filePath;
}

function compactPathForConsoleMessage(filePath: string): string {
  return compactHomePath(filePath, resolveCompactHomePrefixes());
}

function isSkillVisibleInAvailableSkillsPrompt(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return entry.exposure.includeInAvailableSkillsPrompt !== false;
  }
  if (entry.invocation) {
    return entry.invocation.disableModelInvocation !== true;
  }
  return entry.skill.disableModelInvocation !== true;
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  eligibility?: SkillEligibilityContext,
): SkillEntry[] {
  let filtered = entries.filter((entry) => shouldIncludeSkill({ entry, config, eligibility }));
  // If skillFilter is provided, only include skills in the filter list.
  if (skillFilter !== undefined) {
    const normalized = normalizeSkillFilter(skillFilter) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    filtered =
      normalized.length > 0
        ? filtered.filter((entry) => normalized.includes(entry.skill.name))
        : [];
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
}

const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;
const DEFAULT_MIN_RAW_ENTRIES_PER_DIRECTORY_SCAN = 1_000;
const PRELOADED_SKILL_MAX_CHARS = 12_000;
const PRELOADED_SKILLS_PROMPT_MAX_CHARS = 24_000;
const DEFAULT_MAX_RAW_ENTRIES_PER_DIRECTORY_SCAN = 10_000;
export const SKILL_INDEX_RELATIVE_PATH = ".openclaw/SKILL_INDEX.md";

type ResolvedSkillsLimits = {
  maxCandidatesPerRoot: number;
  maxSkillsLoadedPerSource: number;
  maxSkillsInPrompt: number;
  maxSkillsPromptChars: number;
  maxSkillFileBytes: number;
};

type LoadedSkillRecord = {
  skill: Skill;
  frontmatter?: ParsedSkillFrontmatter;
};

type CandidateSkillDir = {
  skillDir: string;
  name: string;
  skillMdRealPath: string;
};

type ChildDirectoryScan = {
  dirs: string[];
  scannedEntryCount: number;
  truncated: boolean;
};

function resolveSkillsLimits(config?: OpenClawConfig, agentId?: string): ResolvedSkillsLimits {
  const limits = config?.skills?.limits;
  const agentSkillsLimits = resolveEffectiveAgentSkillsLimits(config, agentId);
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
    maxSkillsLoadedPerSource:
      limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
    maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
    maxSkillsPromptChars:
      agentSkillsLimits?.maxSkillsPromptChars ??
      limits?.maxSkillsPromptChars ??
      DEFAULT_MAX_SKILLS_PROMPT_CHARS,
    maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
  };
}

function listChildDirectories(
  dir: string,
  opts?: {
    maxCandidateDirs?: number;
    maxRawEntriesToScan?: number;
  },
): ChildDirectoryScan {
  const maxRawEntriesToScan =
    opts?.maxRawEntriesToScan === undefined
      ? resolveRawEntryScanLimit(opts?.maxCandidateDirs)
      : Math.max(0, opts.maxRawEntriesToScan);
  try {
    const dirs: string[] = [];
    let scannedEntryCount = 0;
    let truncated = false;
    const handle = fs.opendirSync(dir);
    try {
      let entry: Dirent | null;
      while ((entry = handle.readSync()) !== null) {
        if (scannedEntryCount >= maxRawEntriesToScan) {
          truncated = true;
          break;
        }
        scannedEntryCount += 1;

        if (entry.name.startsWith(".")) continue;
        if (entry.name === "node_modules") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          dirs.push(entry.name);
          continue;
        }
        if (entry.isSymbolicLink()) {
          try {
            if (fs.statSync(fullPath).isDirectory()) {
              dirs.push(entry.name);
            }
          } catch {
            // ignore broken symlinks
          }
        }
      }
    } finally {
      handle.closeSync();
    }
    return { dirs, scannedEntryCount, truncated };
  } catch {
    return { dirs: [], scannedEntryCount: 0, truncated: false };
  }
}

function resolveRawEntryScanLimit(maxCandidateDirs: number | undefined): number {
  if (maxCandidateDirs === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const normalized = Math.max(0, maxCandidateDirs);
  if (normalized === 0) {
    return 0;
  }
  return Math.min(
    DEFAULT_MAX_RAW_ENTRIES_PER_DIRECTORY_SCAN,
    Math.max(DEFAULT_MIN_RAW_ENTRIES_PER_DIRECTORY_SCAN, normalized * 10),
  );
}

function tryRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isSymlinkPath(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function buildEscapedSkillPathReason(params: { source: string; candidatePath: string }): {
  reason: string;
  consoleHint: string;
} {
  const candidateIsSymlink = isSymlinkPath(params.candidatePath);
  if (params.source === "openclaw-bundled" && candidateIsSymlink) {
    return {
      reason: "bundled-symlink-escape",
      consoleHint:
        "reason=bundled-symlink-escape hint=likely-stray-local-symlink-or-checkout-mutation",
    };
  }
  if (candidateIsSymlink) {
    return {
      reason: "symlink-escape",
      consoleHint: "reason=symlink-escape",
    };
  }
  if (params.source === "openclaw-bundled") {
    return {
      reason: "bundled-root-escape",
      consoleHint:
        "reason=bundled-root-escape hint=likely-stray-local-symlink-or-checkout-mutation",
    };
  }
  return {
    reason: "path-escape",
    consoleHint: "reason=path-escape",
  };
}

function warnEscapedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
  candidateRealPath: string;
}) {
  const compactRootDir = compactPathForConsoleMessage(params.rootDir);
  const compactRootRealPath = compactPathForConsoleMessage(params.rootRealPath);
  const compactCandidatePath = compactPathForConsoleMessage(params.candidatePath);
  const compactCandidateRealPath = compactPathForConsoleMessage(params.candidateRealPath);
  const rootResolved =
    path.resolve(params.rootDir) === params.rootRealPath
      ? ""
      : ` rootResolved=${compactRootRealPath}`;
  const escapeReason = buildEscapedSkillPathReason({
    source: params.source,
    candidatePath: params.candidatePath,
  });
  skillsLogger.warn("Skipping escaped skill path outside its configured root.", {
    source: params.source,
    rootDir: params.rootDir,
    rootRealPath: params.rootRealPath,
    path: params.candidatePath,
    realPath: params.candidateRealPath,
    reason: escapeReason.reason,
    consoleMessage:
      `Skipping escaped skill path outside its configured root: ` +
      `source=${params.source} root=${compactRootDir}${rootResolved} ` +
      `${escapeReason.consoleHint} requested=${compactCandidatePath} ` +
      `resolved=${compactCandidateRealPath}`,
  });
}

function resolveContainedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
}): string | null {
  const candidateRealPath = tryRealpath(params.candidatePath);
  if (!candidateRealPath) {
    return null;
  }
  if (isPathInside(params.rootRealPath, candidateRealPath)) {
    return candidateRealPath;
  }
  warnEscapedSkillPath({
    source: params.source,
    rootDir: params.rootDir,
    rootRealPath: params.rootRealPath,
    candidatePath: path.resolve(params.candidatePath),
    candidateRealPath,
  });
  return null;
}

function resolveNestedSkillsRoot(
  dir: string,
  opts?: {
    maxEntriesToScan?: number;
  },
): { baseDir: string; note?: string } {
  const nested = path.join(dir, "skills");
  try {
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
      return { baseDir: dir };
    }
  } catch {
    return { baseDir: dir };
  }

  // Heuristic: if `dir/skills/*/SKILL.md` exists for any entry, treat `dir/skills` as the real root.
  // Note: don't stop at 25, but keep a cap to avoid pathological scans.
  const scanLimit = Math.max(0, opts?.maxEntriesToScan ?? 100);
  const nestedDirs = listChildDirectories(nested, { maxCandidateDirs: scanLimit }).dirs;

  for (const name of nestedDirs) {
    const skillMd = path.join(nested, name, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      return { baseDir: nested, note: `Detected nested skills root at ${nested}` };
    }
  }
  return { baseDir: dir };
}

function unwrapLoadedSkillRecords(loaded: unknown): LoadedSkillRecord[] {
  if (Array.isArray(loaded)) {
    return (loaded as Skill[]).map((skill) => ({ skill }));
  }
  if (loaded && typeof loaded === "object" && "skills" in loaded) {
    const skills = (loaded as { skills?: unknown }).skills;
    if (Array.isArray(skills)) {
      const loadedResult = loaded as { frontmatterByFilePath?: unknown };
      const frontmatterByFilePath =
        loadedResult.frontmatterByFilePath instanceof Map
          ? (loadedResult.frontmatterByFilePath as ReadonlyMap<string, ParsedSkillFrontmatter>)
          : undefined;
      return (skills as Skill[]).map((skill) => ({
        skill,
        frontmatter: frontmatterByFilePath?.get(skill.filePath),
      }));
    }
  }
  return [];
}

function loadContainedSkillRecords(params: {
  skillDir: string;
  source: string;
  maxSkillFileBytes: number;
}): LoadedSkillRecord[] {
  const expectedBaseDir = path.resolve(params.skillDir);
  const loaded = loadSkillsFromDirSafe({
    dir: params.skillDir,
    source: params.source,
    maxBytes: params.maxSkillFileBytes,
  });
  return unwrapLoadedSkillRecords(loaded).filter(
    (record) => path.resolve(record.skill.baseDir) === expectedBaseDir,
  );
}

function isPathInsideAnyRoot(rootRealPaths: readonly string[], candidateRealPath: string): boolean {
  return rootRealPaths.some((rootRealPath) => isPathInside(rootRealPath, candidateRealPath));
}

function resolvePluginSkillRootRealPaths(pluginSkillDirs: readonly string[]): string[] {
  return pluginSkillDirs
    .map((dir) => tryRealpath(dir))
    .filter((dir): dir is string => Boolean(dir))
    .filter((dir, index, all) => all.indexOf(dir) === index);
}

function loadGeneratedPluginSkillRecords(params: {
  pluginSkillsDir: string;
  pluginSkillDirs: readonly string[];
  source: string;
  limits: ResolvedSkillsLimits;
}): LoadedSkillRecord[] {
  const allowedRootRealPaths = resolvePluginSkillRootRealPaths(params.pluginSkillDirs);
  if (allowedRootRealPaths.length === 0) {
    return [];
  }

  const rootDir = path.resolve(params.pluginSkillsDir);
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const rootRealPath = tryRealpath(rootDir) ?? rootDir;
  const maxCandidatesPerRoot = Math.max(0, params.limits.maxCandidatesPerRoot);
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const childDirScan = listChildDirectories(rootDir, {
    maxCandidateDirs: maxCandidatesPerRoot,
  });
  const childDirs =
    maxSkillsLoadedPerSource === 0
      ? []
      : childDirScan.dirs.toSorted().slice(0, maxCandidatesPerRoot);
  const loadedSkills: LoadedSkillRecord[] = [];

  for (const name of childDirs) {
    const skillDir = path.join(rootDir, name);
    if (!isSymlinkPath(skillDir)) {
      continue;
    }
    const skillDirRealPath = tryRealpath(skillDir);
    if (!skillDirRealPath || !isPathInsideAnyRoot(allowedRootRealPaths, skillDirRealPath)) {
      if (skillDirRealPath) {
        warnEscapedSkillPath({
          source: params.source,
          rootDir,
          rootRealPath,
          candidatePath: path.resolve(skillDir),
          candidateRealPath: skillDirRealPath,
        });
      }
      continue;
    }

    const skillMd = path.join(skillDir, "SKILL.md");
    let skillMdStat: fs.Stats;
    try {
      skillMdStat = fs.lstatSync(skillMd);
    } catch {
      continue;
    }
    if (!skillMdStat.isFile() || skillMdStat.isSymbolicLink()) {
      continue;
    }
    const skillMdRealPath = tryRealpath(skillMd);
    if (!skillMdRealPath || !isPathInside(skillDirRealPath, skillMdRealPath)) {
      continue;
    }
    if (skillMdStat.size > params.limits.maxSkillFileBytes) {
      skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
        skill: name,
        filePath: skillMd,
        size: skillMdStat.size,
        maxSkillFileBytes: params.limits.maxSkillFileBytes,
      });
      continue;
    }

    loadedSkills.push(
      ...loadContainedSkillRecords({
        skillDir,
        source: params.source,
        maxSkillFileBytes: params.limits.maxSkillFileBytes,
      }),
    );
    if (loadedSkills.length >= maxSkillsLoadedPerSource) {
      break;
    }
  }

  if (loadedSkills.length > maxSkillsLoadedPerSource) {
    return loadedSkills
      .slice()
      .sort((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
      .slice(0, maxSkillsLoadedPerSource);
  }
  return loadedSkills;
}

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    agentId?: string;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    pluginSkillsDir?: string;
  },
): SkillEntry[] {
  const limits = resolveSkillsLimits(opts?.config, opts?.agentId);

  const loadSkills = (params: { dir: string; source: string }): LoadedSkillRecord[] => {
    const rootDir = path.resolve(params.dir);
    if (!fs.existsSync(rootDir)) {
      return [];
    }
    const rootRealPath = tryRealpath(rootDir) ?? rootDir;
    const resolved = resolveNestedSkillsRoot(params.dir, {
      maxEntriesToScan: limits.maxCandidatesPerRoot,
    });
    const baseDir = resolved.baseDir;
    const baseDirRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir,
      rootRealPath,
      candidatePath: baseDir,
    });
    if (!baseDirRealPath) {
      return [];
    }

    // If the root itself is a skill directory, just load it directly (but enforce size cap).
    const rootSkillMd = path.join(baseDir, "SKILL.md");
    if (fs.existsSync(rootSkillMd)) {
      const rootSkillRealPath = resolveContainedSkillPath({
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
        candidatePath: rootSkillMd,
      });
      if (!rootSkillRealPath) {
        return [];
      }
      try {
        const size = fs.statSync(rootSkillRealPath).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
            dir: baseDir,
            filePath: rootSkillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          return [];
        }
      } catch {
        return [];
      }

      return loadContainedSkillRecords({
        skillDir: baseDir,
        source: params.source,
        maxSkillFileBytes: limits.maxSkillFileBytes,
      });
    }

    const maxCandidatesPerRoot = Math.max(0, limits.maxCandidatesPerRoot);
    const maxSkillsLoadedPerSource = Math.max(0, limits.maxSkillsLoadedPerSource);
    const childDirScan = listChildDirectories(baseDir, {
      maxCandidateDirs: maxCandidatesPerRoot,
    });
    const childDirs = childDirScan.dirs;
    const suspicious = childDirScan.truncated;
    const limitedChildren =
      maxSkillsLoadedPerSource === 0 ? [] : childDirs.toSorted().slice(0, maxCandidatesPerRoot);

    if (suspicious) {
      skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        scannedEntryCount: childDirScan.scannedEntryCount,
        maxEntriesToScan: resolveRawEntryScanLimit(maxCandidatesPerRoot),
        maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    } else if (childDirs.length > maxCandidatesPerRoot) {
      skillsLogger.warn("Skills root has many entries, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    }

    const loadedSkills: LoadedSkillRecord[] = [];
    const loadCandidateSkill = ({ skillDir, name, skillMdRealPath }: CandidateSkillDir) => {
      try {
        const size = fs.statSync(skillMdRealPath).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
            skill: name,
            filePath: path.join(skillDir, "SKILL.md"),
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          return;
        }
      } catch {
        return;
      }

      loadedSkills.push(
        ...loadContainedSkillRecords({
          skillDir,
          source: params.source,
          maxSkillFileBytes: limits.maxSkillFileBytes,
        }),
      );
    };

    // Consider immediate subfolders that look like skills (have SKILL.md) and are under size cap.
    // When an immediate subfolder does NOT have a SKILL.md, check one level deeper for grouped
    // skill directories (e.g. ~/.openclaw/skills/coze/koze-retrieval/SKILL.md).
    for (const name of limitedChildren) {
      const skillDir = path.join(baseDir, name);
      const skillDirRealPath = resolveContainedSkillPath({
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
        candidatePath: skillDir,
      });
      if (!skillDirRealPath) {
        continue;
      }
      const skillMd = path.join(skillDir, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        const skillMdRealPath = resolveContainedSkillPath({
          source: params.source,
          rootDir,
          rootRealPath: baseDirRealPath,
          candidatePath: skillMd,
        });
        if (skillMdRealPath) {
          loadCandidateSkill({ skillDir, name, skillMdRealPath });
        }
      } else {
        // No SKILL.md here — check one level deeper for grouped skill directories.
        // Apply the same per-root cap as the outer scan to avoid scanning huge nested trees.
        const nestedChildScan = listChildDirectories(skillDir, {
          maxCandidateDirs: maxCandidatesPerRoot,
        });
        const nestedChildren = nestedChildScan.dirs;
        const nestedSuspicious = nestedChildScan.truncated;
        if (nestedSuspicious) {
          skillsLogger.warn(
            "Nested skills directory looks suspiciously large, truncating discovery.",
            {
              dir: params.dir,
              baseDir,
              nestedDir: skillDir,
              nestedChildDirCount: nestedChildren.length,
              scannedEntryCount: nestedChildScan.scannedEntryCount,
              maxEntriesToScan: resolveRawEntryScanLimit(maxCandidatesPerRoot),
              maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
              maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
            },
          );
        } else if (nestedChildren.length > maxCandidatesPerRoot) {
          skillsLogger.warn("Nested skills directory has many entries, truncating discovery.", {
            dir: params.dir,
            baseDir,
            nestedDir: skillDir,
            nestedChildDirCount: nestedChildren.length,
            maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
            maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
          });
        }
        const limitedNested = nestedChildren.toSorted().slice(0, maxCandidatesPerRoot);
        for (const nestedName of limitedNested) {
          const nestedDir = path.join(skillDir, nestedName);
          const nestedSkillMd = path.join(nestedDir, "SKILL.md");
          if (fs.existsSync(nestedSkillMd)) {
            const nestedDirRealPath = resolveContainedSkillPath({
              source: params.source,
              rootDir,
              rootRealPath: baseDirRealPath,
              candidatePath: nestedDir,
            });
            const nestedSkillMdRealPath = resolveContainedSkillPath({
              source: params.source,
              rootDir,
              rootRealPath: baseDirRealPath,
              candidatePath: nestedSkillMd,
            });
            if (nestedDirRealPath && nestedSkillMdRealPath) {
              loadCandidateSkill({
                skillDir: nestedDir,
                name: `${name}/${nestedName}`,
                skillMdRealPath: nestedSkillMdRealPath,
              });
            }
          }
          if (loadedSkills.length >= maxSkillsLoadedPerSource) {
            break;
          }
        }
      }
      if (loadedSkills.length >= maxSkillsLoadedPerSource) {
        break;
      }
    }

    if (loadedSkills.length > maxSkillsLoadedPerSource) {
      return loadedSkills
        .slice()
        .sort((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
        .slice(0, maxSkillsLoadedPerSource);
    }

    return loadedSkills;
  };

  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const workspaceSkillsDir = path.resolve(workspaceDir, "skills");
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  const pluginSkillsDir = opts?.pluginSkillsDir ?? path.join(CONFIG_DIR, "plugin-skills");
  const extraDirsRaw = opts?.config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw.map((d) => normalizeOptionalString(d) ?? "").filter(Boolean);
  const pluginSkillDirs = resolvePluginSkillDirs({
    workspaceDir,
    config: opts?.config,
    pluginSkillsDir,
  });
  const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];

  const bundledSkills = bundledSkillsDir
    ? loadSkills({
        dir: bundledSkillsDir,
        source: "openclaw-bundled",
      })
    : [];
  const extraSkills = [
    ...mergedExtraDirs.flatMap((dir) => {
      const resolved = resolveUserPath(dir);
      return loadSkills({
        dir: resolved,
        source: "openclaw-extra",
      });
    }),
    ...loadGeneratedPluginSkillRecords({
      pluginSkillsDir,
      pluginSkillDirs,
      source: "openclaw-extra",
      limits,
    }),
  ];
  const managedSkills = loadSkills({
    dir: managedSkillsDir,
    source: "openclaw-managed",
  });
  const osHomeDir = resolveUserHomeDir();
  const personalAgentsSkillsDir = osHomeDir
    ? path.resolve(osHomeDir, ".agents", "skills")
    : path.resolve(".agents", "skills");
  const personalAgentsSkills = loadSkills({
    dir: personalAgentsSkillsDir,
    source: "agents-skills-personal",
  });
  const projectAgentsSkillsDir = path.resolve(workspaceDir, ".agents", "skills");
  const projectAgentsSkills = loadSkills({
    dir: projectAgentsSkillsDir,
    source: "agents-skills-project",
  });
  const workspaceSkills = loadSkills({
    dir: workspaceSkillsDir,
    source: "openclaw-workspace",
  });

  const merged = new Map<string, LoadedSkillRecord>();
  // Precedence: extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace
  for (const record of extraSkills) {
    merged.set(record.skill.name, record);
  }
  for (const record of bundledSkills) {
    merged.set(record.skill.name, record);
  }
  for (const record of managedSkills) {
    merged.set(record.skill.name, record);
  }
  for (const record of personalAgentsSkills) {
    merged.set(record.skill.name, record);
  }
  for (const record of projectAgentsSkills) {
    merged.set(record.skill.name, record);
  }
  for (const record of workspaceSkills) {
    merged.set(record.skill.name, record);
  }

  const skillEntries: SkillEntry[] = Array.from(merged.values())
    .sort((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
    .map((record) => {
      const skill = record.skill;
      const frontmatter =
        record.frontmatter ??
        readSkillFrontmatterSafe({
          rootDir: skill.baseDir,
          filePath: skill.filePath,
          maxBytes: limits.maxSkillFileBytes,
        }) ??
        ({} as ParsedSkillFrontmatter);
      const invocation = resolveSkillInvocationPolicy(frontmatter);
      return {
        skill,
        frontmatter,
        metadata: resolveOpenClawMetadata(frontmatter),
        invocation,
        exposure: {
          includeInRuntimeRegistry: true,
          // Freshly loaded entries preserve the documented disable-model-invocation
          // contract, while legacy entries without exposure metadata still use the
          // fallback in isSkillVisibleInAvailableSkillsPrompt().
          includeInAvailableSkillsPrompt: invocation.disableModelInvocation !== true,
          userInvocable: invocation.userInvocable !== false,
        },
      };
    });
  return skillEntries;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Compact skill catalog: name + location only (no description).
 * Used as a fallback when the full format exceeds the char budget,
 * preserving awareness of all skills before resorting to dropping.
 */
export function formatSkillsCompact(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Before starting work a listed skill covers, use the read tool to load its file and follow the guidance inside.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function renderSkillNameIndex(skills: Skill[]): string {
  const lines = [
    "<!-- System-managed. Generated from the current eligible runtime skills. -->",
    "# Complete skill index",
    "",
    "This is the on-demand skill index (name — description — location). Read the selected `SKILL.md` before use.",
    "",
  ];
  for (const skill of skills.toSorted((a, b) => a.name.localeCompare(b.name, "en"))) {
    const name = skill.name.replaceAll("`", "\\`").replaceAll("\n", " ");
    const location = skill.filePath.replaceAll("`", "\\`").replaceAll("\n", " ");
    const description = (skill.description ?? "")
      .replaceAll("`", "\\`")
      .replace(/\s+/g, " ")
      .trim();
    lines.push(
      description
        ? `- \`${name}\` — ${description} — \`${location}\``
        : `- \`${name}\` — \`${location}\``,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function ensureSkillNameIndex(workspaceDir: string, skills: Skill[]): string | undefined {
  const destination = path.resolve(workspaceDir, SKILL_INDEX_RELATIVE_PATH);
  const rendered = renderSkillNameIndex(skills);
  try {
    const directory = path.dirname(destination);
    const existingDirectory = fs.existsSync(directory) ? fs.lstatSync(directory) : undefined;
    if (existingDirectory?.isSymbolicLink()) {
      throw new Error(`refusing symlinked skill index directory: ${directory}`);
    }
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
      throw new Error(`refusing symlinked skill index: ${destination}`);
    }
    const current = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : undefined;
    if (current !== rendered) {
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, rendered, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, destination);
    }
    return destination;
  } catch (error) {
    skillsLogger.warn(`unable to refresh on-demand skill index: ${String(error)}`);
    return undefined;
  }
}

function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return normalized.trim();
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return normalized.trim();
  }
  return normalized.slice(endIndex + 4).trim();
}

function renderPreloadedSkillsPrompt(params: {
  skills: Skill[];
  runtimeChannel?: string;
  config?: OpenClawConfig;
  agentId?: string;
}): string {
  const runtimeChannel = params.runtimeChannel?.trim().toLowerCase();
  if (!runtimeChannel) {
    return "";
  }
  const limits = resolveSkillsLimits(params.config, params.agentId);
  const candidates = params.skills
    .filter((skill) => skill.preloadChannels?.includes(runtimeChannel))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const rendered: string[] = [];
  let renderedChars = 0;

  for (const skill of candidates) {
    const raw = readSkillFileSafe({
      rootDir: skill.baseDir ?? path.dirname(skill.filePath),
      filePath: skill.filePath,
      maxBytes: Math.min(limits.maxSkillFileBytes, PRELOADED_SKILL_MAX_CHARS * 4),
    });
    const body = raw ? stripSkillFrontmatter(raw) : "";
    if (!body || body.length > PRELOADED_SKILL_MAX_CHARS) {
      skillsLogger.warn(
        `unable to preload skill body for ${skill.name} on ${runtimeChannel}: missing or over ${PRELOADED_SKILL_MAX_CHARS} characters`,
      );
      continue;
    }
    const block = [
      `  <preloaded_skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">`,
      body,
      "  </preloaded_skill>",
    ].join("\n");
    if (renderedChars + block.length > PRELOADED_SKILLS_PROMPT_MAX_CHARS) {
      skillsLogger.warn(
        `preloaded skills prompt reached ${PRELOADED_SKILLS_PROMPT_MAX_CHARS} characters; omitting ${skill.name}`,
      );
      continue;
    }
    rendered.push(block);
    renderedChars += block.length;
  }

  if (rendered.length === 0) {
    return "";
  }
  return [
    "The following skill instructions are preloaded for the current channel. Follow them directly; do not use the read tool to reload their SKILL.md files.",
    "<preloaded_skills>",
    ...rendered,
    "</preloaded_skills>",
  ].join("\n");
}

// Budget reserved for the compact-mode warning line prepended by the caller.
const COMPACT_WARNING_OVERHEAD = 150;

function applySkillsPromptLimits(params: {
  skills: Skill[];
  config?: OpenClawConfig;
  agentId?: string;
  limits?: Pick<ResolvedSkillsLimits, "maxSkillsInPrompt" | "maxSkillsPromptChars">;
}): {
  skillsForPrompt: Skill[];
  truncated: boolean;
  compact: boolean;
} {
  const limits = params.limits ?? resolveSkillsLimits(params.config, params.agentId);
  const total = params.skills.length;
  const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));

  let skillsForPrompt = byCount;
  let truncated = total > byCount.length;
  let compact = false;

  const fitsFull = (skills: Skill[]): boolean =>
    formatSkillsForPrompt(skills).length <= limits.maxSkillsPromptChars;

  // Reserve space for the warning line the caller prepends in compact mode.
  const compactBudget = limits.maxSkillsPromptChars - COMPACT_WARNING_OVERHEAD;
  const fitsCompact = (skills: Skill[]): boolean =>
    formatSkillsCompact(skills).length <= compactBudget;

  if (!fitsFull(skillsForPrompt)) {
    // Full format exceeds budget. Try compact (name + location, no description)
    // to preserve awareness of all skills before dropping any.
    if (fitsCompact(skillsForPrompt)) {
      compact = true;
      // No skills dropped — only format downgraded. Preserve existing truncated state.
    } else {
      // Compact still too large — binary search the largest prefix that fits.
      compact = true;
      let lo = 0;
      let hi = skillsForPrompt.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(skillsForPrompt.slice(0, mid))) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      skillsForPrompt = skillsForPrompt.slice(0, lo);
      truncated = true;
    }
  }

  return { skillsForPrompt, truncated, compact };
}

// Progressive per-skill description caps tried, in order, before the catalog
// falls back to the compact (description-less) tiers.
const CATALOG_DESC_TRIM_STEPS = [512, 384, 256, 192, 128] as const;
const CATALOG_TRIM_NOTE =
  "Note: some skill descriptions are trimmed to fit the prompt budget; read the skill's SKILL.md or the skill index file for full text.";
// The one-line description is an index entry, not the guidance. Stated where
// the fork assembles skill blocks (not inside formatSkillsForPrompt, which
// must stay byte-aligned with the upstream formatter — see compact-format
// parity test): agents that act from the description alone skip the operating
// rules that only exist in the body.
const SKILL_READ_NORM =
  "Before starting work a listed skill covers, read its SKILL.md and follow the guidance inside — the one-line description is an index entry, not the full guidance.";

function trimSkillDescription(description: string, cap: number): string {
  if (description.length <= cap) {
    return description;
  }
  return `${description.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
}

/**
 * Render the COMPLETE skills catalog (every skill, name + description +
 * location) for the cache-stable system-prompt prefix. Unlike the legacy
 * tiering in applySkillsPromptLimits — which drops descriptions wholesale the
 * moment the full format exceeds budget — this degrades gracefully: full
 * descriptions → progressively trimmed descriptions → compact → truncated
 * compact, so descriptions survive as long as the budget allows.
 */
export function renderSkillsCatalogPrompt(params: { skills: Skill[]; maxChars: number }): string {
  const skills = compactSkillPaths(params.skills)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (skills.length === 0) {
    return "";
  }
  const full = formatSkillsForPrompt(skills);
  if (full.length + SKILL_READ_NORM.length + 1 <= params.maxChars) {
    return [SKILL_READ_NORM, full].join("\n");
  }
  for (const cap of CATALOG_DESC_TRIM_STEPS) {
    const trimmed = skills.map((skill) => ({
      ...skill,
      description: trimSkillDescription(skill.description ?? "", cap),
    }));
    const rendered = formatSkillsForPrompt(trimmed);
    if (
      rendered.length + SKILL_READ_NORM.length + CATALOG_TRIM_NOTE.length + 2 <=
      params.maxChars
    ) {
      return [SKILL_READ_NORM, CATALOG_TRIM_NOTE, rendered].join("\n");
    }
  }
  // Even trimmed descriptions cannot fit — fall back to the compact tiers.
  const { skillsForPrompt, truncated } = applySkillsPromptLimits({
    skills,
    limits: { maxSkillsInPrompt: skills.length, maxSkillsPromptChars: params.maxChars },
  });
  const note = truncated
    ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${skills.length} (compact format, descriptions omitted). Read the skill index file for the complete list.`
    : `⚠️ Skills catalog using compact format (descriptions omitted). Read the skill index file for full descriptions.`;
  return [note, formatSkillsCompact(skillsForPrompt)].join("\n");
}

/**
 * Resolve the complete skills catalog for a run, mirroring
 * resolveSkillsPromptForRun's skill-source order (snapshot → entries). The
 * result is stable for a session as long as the installed skills are — it is
 * injected ABOVE the system-prompt cache boundary by the embedded runner.
 */
export function resolveSkillsCatalogForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId?: string;
}): string {
  const limits = resolveSkillsLimits(params.config, params.agentId);
  let skills = params.skillsSnapshot?.resolvedSkills;
  if (!skills && params.entries && params.entries.length > 0) {
    skills = resolveWorkspaceSkillPromptState(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
      agentId: params.agentId,
    }).resolvedSkills;
  }
  if (!skills || skills.length === 0) {
    return "";
  }
  // The on-demand index (full descriptions, on disk) backs the trimmed and
  // compact catalog tiers, which point the agent at it for the full text.
  ensureSkillNameIndex(params.workspaceDir, compactSkillPaths(skills));
  return renderSkillsCatalogPrompt({ skills, maxChars: limits.maxSkillsPromptChars });
}

export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): SkillSnapshot {
  const { eligible, prompt, resolvedSkills } = resolveWorkspaceSkillPromptState(workspaceDir, opts);
  const skillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  const runtimeBundle = readActiveRuntimeBundle(workspaceDir);
  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),
    })),
    ...(skillFilter === undefined ? {} : { skillFilter }),
    ...(runtimeBundle ? { releaseId: runtimeBundle.releaseId } : {}),
    resolvedSkills,
    version: opts?.snapshotVersion,
  };
}

export function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): string {
  return resolveWorkspaceSkillPromptState(workspaceDir, opts).prompt;
}

type WorkspaceSkillBuildOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  entries?: SkillEntry[];
  agentId?: string;
  /** If provided, only include skills with these names */
  skillFilter?: string[];
  eligibility?: SkillEligibilityContext;
};

function resolveEffectiveWorkspaceSkillFilter(
  opts?: WorkspaceSkillBuildOptions,
): string[] | undefined {
  if (opts?.skillFilter !== undefined) {
    return normalizeSkillFilter(opts.skillFilter);
  }
  if (!opts?.config || !opts.agentId) {
    return undefined;
  }
  return resolveEffectiveAgentSkillFilter(opts.config, opts.agentId);
}

function resolveWorkspaceSkillPromptState(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): {
  eligible: SkillEntry[];
  prompt: string;
  resolvedSkills: Skill[];
} {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    effectiveSkillFilter,
    opts?.eligibility,
  );
  const promptEntries = eligible.filter((entry) => isSkillVisibleInAvailableSkillsPrompt(entry));
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const resolvedSkills = promptEntries.map((entry) => {
    const preloadChannels = entry.metadata?.preloadChannels;
    return preloadChannels?.length
      ? { ...entry.skill, preloadChannels: preloadChannels.slice() }
      : entry.skill;
  });
  // Derive prompt-facing skills with compacted paths (e.g. ~/...) once.
  // Budget checks and final render both use this same representation so the
  // tier decision is based on the exact strings that end up in the prompt.
  // resolvedSkills keeps canonical paths for snapshot / runtime consumers.
  const promptSkills = compactSkillPaths(resolvedSkills)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const { skillsForPrompt, truncated, compact } = applySkillsPromptLimits({
    skills: promptSkills,
    config: opts?.config,
    agentId: opts?.agentId,
  });
  const truncationNote = truncated
    ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${resolvedSkills.length}${compact ? " (compact format, descriptions omitted)" : ""}. Run \`openclaw skills check\` to audit.`
    : compact
      ? `⚠️ Skills catalog using compact format (descriptions omitted). Run \`openclaw skills check\` to audit.`
      : "";
  const prompt = [
    remoteNote,
    truncationNote,
    compact ? formatSkillsCompact(skillsForPrompt) : formatSkillsForPrompt(skillsForPrompt),
  ]
    .filter(Boolean)
    .join("\n");
  return { eligible, prompt, resolvedSkills };
}

/**
 * Per-channel preloaded skill bodies for a run. They depend on the runtime
 * channel, so they render below the system-prompt cache boundary. The complete
 * catalog and the rules for reading skills live in resolveSkillsCatalogForRun,
 * in the cache-stable prefix.
 */
export function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId?: string;
  runtimeChannel?: string;
}): string {
  let resolvedSkills = params.skillsSnapshot?.resolvedSkills;
  if (!resolvedSkills && params.entries && params.entries.length > 0) {
    resolvedSkills = resolveWorkspaceSkillPromptState(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
      agentId: params.agentId,
    }).resolvedSkills;
  }
  if (!resolvedSkills || resolvedSkills.length === 0) {
    return "";
  }
  return renderPreloadedSkillsPrompt({
    skills: resolvedSkills,
    runtimeChannel: params.runtimeChannel,
    config: params.config,
    agentId: params.agentId,
  });
}

export function loadWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    pluginSkillsDir?: string;
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  const entries = loadSkillEntries(workspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  if (effectiveSkillFilter === undefined) {
    return entries;
  }
  return filterSkillEntries(entries, opts?.config, effectiveSkillFilter, opts?.eligibility);
}

export function loadVisibleWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  const entries = loadSkillEntries(workspaceDir, opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return filterSkillEntries(entries, opts?.config, effectiveSkillFilter, opts?.eligibility);
}

function resolveUniqueSyncedSkillDirName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  let fallbackIndex = 10_000;
  let fallback = `${base}-${fallbackIndex}`;
  while (used.has(fallback)) {
    fallbackIndex += 1;
    fallback = `${base}-${fallbackIndex}`;
  }
  used.add(fallback);
  return fallback;
}

function resolveSyncedSkillDestinationPath(params: {
  targetSkillsDir: string;
  entry: SkillEntry;
  usedDirNames: Set<string>;
}): string | null {
  const sourceDirName = path.basename(params.entry.skill.baseDir).trim();
  if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") {
    return null;
  }
  const uniqueDirName = resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames);
  return resolveSandboxPath({
    filePath: uniqueDirName,
    cwd: params.targetSkillsDir,
    root: params.targetSkillsDir,
  }).resolved;
}

export async function syncSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  skillFilter?: string[];
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
}) {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return;
  }

  await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");

    const entries = loadWorkspaceSkillEntries(sourceDir, {
      config: params.config,
      skillFilter: params.skillFilter,
      agentId: params.agentId,
      eligibility: params.eligibility,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
    });

    await fsp.rm(targetSkillsDir, { recursive: true, force: true });
    await fsp.mkdir(targetSkillsDir, { recursive: true });

    const usedDirNames = new Set<string>();
    for (const entry of entries) {
      let dest: string | null = null;
      try {
        dest = resolveSyncedSkillDestinationPath({
          targetSkillsDir,
          entry,
          usedDirNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
        continue;
      }
      if (!dest) {
        skillsLogger.warn(
          `Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`,
        );
        continue;
      }
      try {
        await fsp.cp(entry.skill.baseDir, dest, {
          recursive: true,
          force: true,
          filter: (src) => {
            const name = path.basename(src);
            return !(name === ".git" || name === "node_modules");
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
      }
    }
  });
}

export function filterWorkspaceSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
): SkillEntry[] {
  return filterSkillEntries(entries, config);
}

export function filterWorkspaceSkillEntriesWithOptions(
  entries: SkillEntry[],
  opts?: {
    config?: OpenClawConfig;
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  return filterSkillEntries(entries, opts?.config, opts?.skillFilter, opts?.eligibility);
}
