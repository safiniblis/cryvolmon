## Diagnosis

The failure was a **pipeline message-size problem**, not a trading or service problem.

- The Architect request asked for **8,445 tokens**, but the provider allows **8,000 tokens per minute**.
- It exceeded the limit by **445 tokens**, so the provider rejected it with HTTP 413 before producing a plan.
- The request became too large because the pipeline combined role instructions, the job order, retained pipeline history, and project context.
- The live Architect seat is configured for NVIDIA, while the error names Groq’s `openai/gpt-oss-120b`, indicating fallback/recovery routing was inconsistent.
- The service remained active; no trading parameters or exchange behavior were changed.

## Proposed Patch (not applied)

1. **`server/council.ts`**
   - Add a strict Architect prompt-size budget below 8,000 tokens.
   - Send only the current job order and essential file excerpts, not the full pipeline history.
   - Truncate oversized artifacts before handoff.
   - Treat HTTP 413 as a request-size failure and stop without retrying the same agent.
   - Record a clear blocked status instead of repeatedly recovering into another oversized request.

2. **`server/agent-providers.ts`**
   - Validate persisted seat providers against the supported provider list.
   - Ignore invalid runtime overrides and use the role’s approved default.
   - Ensure fallback selection and displayed seat configuration use the same provider/model.
   - Do not retain or expose runtime credentials in persisted seat state.

3. **`data/council-runtime.json`**
   - Remove the invalid Builder override and embedded credential.
   - Do not change trading, exchange, leverage, capital, ticker, or strategy settings.

## Verification After Approval

- Run TypeScript check and production build.
- Test that Architect requests remain below the provider limit.
- Confirm HTTP 413 produces one blocked decision with no same-agent retry.
- Confirm all seats resolve to supported, internally consistent providers.
- Confirm no live orders, positions, strategy parameters, or exchange behavior change.

## Approval Required

Approve this pipeline-only patch before any files are edited.