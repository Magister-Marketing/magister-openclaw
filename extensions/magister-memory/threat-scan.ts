/**
 * Threat-pattern scanner for memory writes.
 *
 * Memory content is rendered into the next session's system prompt — so anything
 * persisted here is effectively a prompt-injection / exfiltration vector if the
 * source content is adversarial (e.g., the agent ingested attacker-controlled
 * web content and tried to memorize it). This module is the gatekeeper.
 *
 * Patterns adapted from hermes-agent/tools/memory_tool.py (_MEMORY_THREAT_PATTERNS)
 * with Magister-specific additions for the provider keys this platform handles.
 */

type ThreatHit = { pattern: RegExp; id: string };

const PROMPT_INJECTION_PATTERNS: ThreatHit[] = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  {
    pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
    id: "disregard_rules",
  },
  {
    pattern:
      /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i,
    id: "bypass_restrictions",
  },
];

const EXFIL_PATTERNS: ThreatHit[] = [
  {
    pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    id: "exfil_curl",
  },
  {
    pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    id: "exfil_wget",
  },
  {
    pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
    id: "read_secrets",
  },
];

const PROVIDER_KEY_PATTERNS: ThreatHit[] = [
  { pattern: /sk-ant-(api|admin)[A-Za-z0-9_-]{20,}/i, id: "provider_key_anthropic" },
  { pattern: /sk-proj-[A-Za-z0-9_-]{20,}/i, id: "provider_key_openai_proj" },
  { pattern: /\bsk-[A-Za-z0-9]{40,}/i, id: "provider_key_openai" },
  { pattern: /AIza[A-Za-z0-9_-]{30,}/i, id: "provider_key_gemini" },
  { pattern: /xox[bp]-[A-Za-z0-9-]{20,}/i, id: "provider_key_slack" },
  { pattern: /ghp_[A-Za-z0-9]{30,}/i, id: "provider_key_github" },
  { pattern: /github_pat_[A-Za-z0-9_]{60,}/i, id: "provider_key_github_pat" },
  { pattern: /\bsk_(test|live)_[A-Za-z0-9]{20,}/i, id: "provider_key_stripe" },
];

const PERSISTENCE_PATTERNS: ThreatHit[] = [
  { pattern: /authorized_keys/, id: "ssh_backdoor" },
  { pattern: /\$HOME\/\.ssh|~\/\.ssh/, id: "ssh_access" },
];

const ALL_PATTERNS = [
  ...PROMPT_INJECTION_PATTERNS,
  ...EXFIL_PATTERNS,
  ...PROVIDER_KEY_PATTERNS,
  ...PERSISTENCE_PATTERNS,
];

// Zero-width / invisible / bidi-override characters that can hide prompt-injection
// payloads inside otherwise-benign-looking memory text.
const INVISIBLE_CHARS = [
  "​", // ZERO WIDTH SPACE
  "‌", // ZERO WIDTH NON-JOINER
  "‍", // ZERO WIDTH JOINER
  "⁠", // WORD JOINER
  "﻿", // ZERO WIDTH NO-BREAK SPACE
  "‪", // LEFT-TO-RIGHT EMBEDDING
  "‫", // RIGHT-TO-LEFT EMBEDDING
  "‬", // POP DIRECTIONAL FORMATTING
  "‭", // LEFT-TO-RIGHT OVERRIDE
  "‮", // RIGHT-TO-LEFT OVERRIDE
];

/**
 * Scan content. Returns null when content is clean, or a short reason string
 * (`"<id>: ..."`) when blocked. Reason strings start with the pattern id so
 * tests and local diagnostics can match a stable token.
 */
export function scanMemoryContent(content: string): string | null {
  for (const char of INVISIBLE_CHARS) {
    if (content.includes(char)) {
      const code = char.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase();
      return `invisible: content contains invisible unicode U+${code}`;
    }
  }

  for (const { pattern, id } of ALL_PATTERNS) {
    if (pattern.test(content)) {
      return `${id}: content matches threat pattern '${id}'`;
    }
  }

  return null;
}
