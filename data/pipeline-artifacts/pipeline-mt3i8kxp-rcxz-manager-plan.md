## Diagnosis

The manager stage failed because the **Architect request was too large for its provider**:

- Provider: Groq
- Model: `openai/gpt-oss-120b`
- Limit: 8,000 tokens/minute
- Request: 10,034 tokens
- Excess: 2,034 tokens
- HTTP 413 means the provider rejected the request before producing a plan.

The service logs show repeated oversized attempts, not a trading-engine failure. No service restart or trading-state change occurred.

Live seat configuration also has a separate problem: Builder is persisted as `nebius`, but `server/agent-providers.ts` does not support that provider. This did not cause this Architect 413, but it can break the next pipeline handoff.

## Proposed Patch (not applied)

1. **`server/council.ts`**
   - Reduce the Architect handoff to the current job order, relevant file excerpts, and required constraints only.
   - Exclude retained pipeline history, duplicate instructions, and unrelated conversation context.
   - Add a hard prompt-size budget below 8,000 tokens, preferably approximately 6,500.
   - Detect HTTP 413 as a non-retryable size failure.
   - Record one blocked pipeline result instead of repeatedly retrying the same oversized request.

2. **`server/agent-providers.ts`**
   - Validate persisted provider names against the supported provider registry during load.
   - Ignore invalid entries such as `nebius` and fall back to the configured default seat.
   - Ensure seat display and actual routing use the same validated provider.
   - Prevent unsupported provider values from reaching key resolution or model calls.

3. **Configuration handling**
   - Remove the stale Builder `nebius` override through the normal approved configuration path.
   - Do not alter credentials, trading behavior, exchange semantics, leverage, capital, ticker, or strategy parameters.

## Verification After Approval

- Confirm Architect requests stay below the configured token budget.
- Confirm one HTTP 413 marks the attempt blocked without retrying.
- Run TypeScript check and production build.
- Confirm invalid provider overrides are rejected safely.
- Confirm all trading, strategy, account, and service state remains unchanged.

## Approval Required

Approval is required before applying this pipeline-only patch.