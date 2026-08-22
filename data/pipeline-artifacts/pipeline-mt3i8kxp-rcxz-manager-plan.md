## Diagnosis

The failure occurred at the **Architect handoff**, not in trading or the service.

- Live Architect seat: Groq `openai/gpt-oss-120b`.
- Provider limit: **8,000 tokens per minute**.
- Failed request: **8,837 tokens**, exceeding the limit by **837**.
- Repeated recovery attempts retained too much pipeline history, causing request size to fluctuate above the limit.
- Logs show no restart, trading action, strategy change, or exchange activity.
- Separate configuration issue: the persisted Builder seat uses unsupported provider `nebius`, which may break a later handoff.

## Proposed Patch (not applied)

1. **`server/council.ts`**
   - Build Architect prompts from only the current job order, relevant file excerpts, and required role instructions.
   - Exclude prior retry history, duplicate summaries, and unrelated conversation context.
   - Enforce a hard prompt budget around **6,500 tokens**, safely below Groq’s 8,000-token limit.
   - Treat HTTP 413 as a non-retryable size error.
   - Mark the stage blocked once, rather than repeatedly resending the same oversized request.

2. **`server/agent-providers.ts`**
   - Validate persisted providers against the supported provider list while loading overrides.
   - Ignore unsupported entries such as `nebius` and use the role’s configured default.
   - Ensure displayed seat configuration and actual routing use the same validation.

3. **Configuration cleanup**
   - Remove the stale Builder override through the approved configuration path.
   - Do not change trading logic, exchange behavior, credentials, leverage, capital, ticker, or strategy parameters.

## Verification After Approval

- Confirm Architect request size remains below the configured budget.
- Confirm one HTTP 413 does not trigger repeated identical retries.
- Confirm invalid provider overrides safely fall back.
- Run TypeScript check and production build.
- Confirm no trading, account, strategy, exchange, or service-state changes occurred.

## Approval Required

Approval is required before applying this pipeline-only patch.