---
summary: "Security backports and audit exceptions for the pinned Pi coding-agent dependency"
title: "Pi coding-agent security backports"
read_when:
  - Auditing production dependencies in the Magister OpenClaw fork
  - Updating or removing the pinned Pi coding-agent dependency
---

# Pi coding agent security backports

OpenClaw remains pinned to `@mariozechner/pi-coding-agent@0.73.0` because the maintained replacement package uses incompatible APIs. The three audit exceptions in `package.json` are not unmitigated risks: their upstream fixes are backported in `patches/@mariozechner__pi-coding-agent@0.73.0.patch`.

| Advisory              | Backported protection                                                                                                                                                                              | Upstream reference                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GHSA-jfgx-wxx8-mp94` | Put temporary extension installs in an agent-private `0700` directory and enforce install-root containment for decoded Git hosts and paths. Raw backslashes are rejected before URL normalization. | [`a98e087`](https://github.com/badlogic/pi-mono/commit/a98e087), [`ea3465`](https://github.com/badlogic/pi-mono/commit/ea3465) |
| `GHSA-r95r-rj6r-c39x` | Create and rewrite `auth.json` with mode `0600`, including the first write before locking.                                                                                                         | [`135fb54`](https://github.com/badlogic/pi-mono/commit/135fb545)                                                               |
| `GHSA-7v5m-pr3q-6453` | Strip C0 controls and allow only safe URL schemes when rendering Markdown links and images in HTML exports.                                                                                        | [`6cb23f9`](https://github.com/badlogic/pi-mono/commit/6cb23f9)                                                                |

`src/security/pi-coding-agent-backports.test.ts` exercises the installed patched package. Keep each audit exception only while that test and the corresponding patch remain present. Any future package migration should remove the patch, test, and exceptions together after a clean production dependency audit.
