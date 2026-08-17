## Diagnosis

The Architect seat is healthy and correctly configured on Groq GPT‑OSS‑120B. Its probe succeeded.

The failure is message size: Groq allows 8,000 tokens per minute, but this request reserved/contained 9,142. The pipeline’s large standing instructions, retained pipeline history, and requested response allowance exceed the limit before the Architect can produce a plan.

Rapid automatic retries then caused rate-limit errors and consumed loop capacity. This is a pipeline handoff/retry-control defect, not a trading, exchange, or strategy issue.

## Proposed Patch (not applied)

**`server/council.ts`**
- Add a strict Architect request budget well below Groq’s 8,000 TPM limit, including system instructions, order, retained context, and response allowance.
- Send Architect only: the current job order, the latest actionable revision note, and a short repository-context summary. Do not attach full pipeline history, chat archive, or unrelated operational snapshot.
- Reserve a bounded Architect output size so input plus output cannot exceed the provider limit.
- Classify HTTP 413 and 429 as transport/provider blocking events, not plan revisions.
- For HTTP 429, honor the provider cooldown before any retry; for HTTP 413, stop immediately with a clear “request too large” status.
- Only increment the five-loop review budget when an actual Architect plan is returned and rejected by Manager.

**`server/agent-providers.ts`**
- Define per-provider/per-model request limits for Groq GPT‑OSS‑120B.
- Expose a safe maximum output allowance for that seat so callers cannot accidentally overbook the TPM budget.

**`server/council.ts` tests or a new focused pipeline test file**
- Test that oversized Architect context is compacted deterministically.
- Test that 413 does not retry or consume a plan-review loop.
- Test that 429 waits/blocks without consuming a plan-review loop.
- Test that normal small jobs still reach Architect with the configured output allowance.

## Verification After Approval

1. Run TypeScript check and production build.
2. Run the focused pipeline tests.
3. Confirm the Architect request estimate stays below the configured Groq budget.
4. Confirm a simulated 413 and 429 leave the review-loop count unchanged.
5. Start a new small documentation-only pipeline job only after the patch is verified; do not reuse the failed run’s accumulated history.

## Approval Required

Approve the above pipeline-only patch. It changes no trading risk, exchange behavior, strategy settings, or credentials.