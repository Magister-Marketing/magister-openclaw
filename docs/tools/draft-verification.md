---
summary: "Opt-in request-grounded draft checks and bounded text correction"
read_when:
  - Configuring draft verification or inspecting its execution receipts
title: "Draft verification"
---

# Draft verification

Draft verification checks a narrow set of explicit requirements from the current
request against the actual answer. It does not prove factual correctness.

```json5
{
  tools: { draftVerification: { mode: "shadow" } },
}
```

`tools.draftVerification.mode` defaults to `off`. The same setting under
`agents.list[].tools` overrides it for one agent.

- `off`: existing streaming and model calls are unchanged; no receipt is emitted.
- `shadow`: Pi streams the original answer and records checks without a model call.
- `repair`: eligible Pi provider streams are buffered before the final assistant
  message is persisted. A failure permits one direct tool-free correction using
  the same provider/model and the remaining turn deadline (at most 30 seconds,
  shorter than the idle watchdog, and 2,048 output tokens). This increases time to
  first answer text and may add model cost, including rejected corrections.

The first checks cover an explicit JSON-only response, exactly N top-level bullet
items, and a single fixed-budget allocation table with an explicit channel or
category count. Request parsing is bounded at 16,000 characters; draft inspection
at 32,000. Quoted, fenced, or clearly delimited source material is not treated as
an instruction. Multiple budgets, flexible amounts, permitted reserves, conflicting
constraints, and unsupported table formats remain unknown. This conservative
parser is not a general natural-language requirements interpreter.

Correction is excluded after any tool activity, already released text, or external delivery, for media,
artifacts, pending client tools, yield, errors, cancellation, silent/memory turns,
raw model probes, stateful/cached transports, and alternate harnesses. Only
supported stateless HTTP provider contracts can be corrected. Tools are removed
from the correction request, including client tools. A correction must pass every applicable check
and terminate normally; otherwise the original answer is retained. Existing
transcript entries and files are never rewritten: the selected stream result is
the only candidate Pi persists. Correction does not enter another agent session,
tool-execution loop, or SDK compaction/retry loop. Returned usage from both calls
is accounted for, including a rejected correction; unavailable usage is not
estimated. Separate turns do not share a
repair budget. Current-attempt observations reset between retries. The existing
retry-limit summary is not verified and cannot inherit earlier draft checks.
Cancellation emits an aborted failure terminal in every mode, not successful
completion, and does not create a provider-error warning.

Pi results expose `meta.draftVerification`. The OpenAI-compatible HTTP stream
and OpenResponses HTTP streams emit an additive `draft_verification` event before
their existing terminal event. Receipts
contain bounded status/category fields only, not request or reply text. An unknown
provider stop reason, skill-read evidence, or ceiling-retry evidence is `null`;
delivery success does not imply any of these. A check marked `pass` concerns only
that category, not the correctness of the whole answer.

Start with an explicitly chosen internal shadow cohort and inspect false positives,
coverage, latency, and cost before enabling repair. No production configuration
is changed by adding this capability.
