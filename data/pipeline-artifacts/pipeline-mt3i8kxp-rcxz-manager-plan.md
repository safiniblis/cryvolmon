## Diagnosis

The failure was a **pipeline request-size problem**, not a trading or service problem.

- Groq’s Architect seat allows **8,000 tokens per minute**.
- The failed request asked for **8,586 tokens**, exceeding the limit by **586**.
- The request included too much retained pipeline history, role instructions, job context, and source context.
- The failure happened before the Architect produced a plan.
- Logs show repeated oversized retries; the service and trading state remained unchanged.
- Live seats show Architect on Groq GPT-OSS-120B. Builder also has a stale unsupported `nebius` override in `data/council-runtime.json`, while `server/agent-providers.ts` does not support that provider.

## Proposed Patch (not applied)

1. **`server/council.ts`**
   - Create a compact Architect handoff containing only the current job order and essential file excerpts.
   - Exclude previous pipeline history, conversation archive, and duplicate instructions.
   - Enforce a request budget safely below 8,000 tokens, preferably about 6,500.
   - Treat HTTP 413 as permanently blocked for that attempt; do not retry the same oversized request.
   - Record the blocked reason once in pipeline state.

2. **`server/agent-providers.ts`**
   - Validate persisted provider overrides against the supported provider list.
   - Reject or ignore unknown providers such as `nebius`.
   - Keep the displayed seat and actual routing provider consistent.
   - Avoid exposing or retaining credential values in seat-state summaries.

3. **`data/council-runtime.json`**
   - Remove the unsupported Builder `nebius` override through the approved configuration path.
   - Do not alter trading, exchange, leverage, capital, ticker, or strategy settings.

## Verification After Approval

- TypeScript check passes.
- Production build passes.
- A test handoff remains below the configured token budget.
- HTTP 413 creates one blocked result without retrying the failed agent.
- Seat resolution rejects unsupported providers consistently.
- Confirm no orders, positions, strategies, risk settings, or service state changed.

## Approval Required

Approval is required before applying this pipeline-only patch.