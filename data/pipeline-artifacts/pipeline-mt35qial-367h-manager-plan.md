## Diagnosis

The pipeline did not fail because of trading logic. It failed during the Architect call because the prompt was too large:

- Provider: Groq
- Model: `openai/gpt-oss-120b`
- Limit: 8,000 tokens per minute
- Requested: 10,983 tokens

The pipeline included too much duplicated job, strategy, repository, and policy context. The service remained running; no code or trading settings changed.

The live seat file also contains a stale Builder assignment to unsupported provider `nebius`. This did not cause the current 413, but it should be rejected or cleaned up before a future build.

## Proposed Patch (not applied)

1. **`server/council.ts`**
   - Add a strict prompt-size budget before Architect, Builder, and Auditor calls.
   - Remove duplicated policy text and repeated full artifacts from each hand-off.
   - Pass compact summaries plus only the relevant file excerpts.
   - Reserve output capacity so the total request stays below the provider TPM limit.
   - Record a clear “prompt compacted” note in the pipeline artifact.
   - Convert an HTTP 413 into a blocked, actionable pipeline state rather than a generic build-plan failure.

2. **`server/agent-providers.ts`**
   - Add provider/model request limits and conservative per-call token caps.
   - Validate persisted providers against the supported provider registry.
   - Ignore and report unsupported assignments such as `nebius` instead of treating them as usable seats.
   - Preserve the existing member-seat and manager trust rules.

3. **`data/council-runtime.json`**
   - After approval, remove or replace the stale unsupported Builder assignment through the normal configuration path.
   - Do not alter trading strategy settings.

## Verification After Approval

- Run the TypeScript check and production build.
- Start a pipeline using a small non-trading test request.
- Confirm Architect requests remain below the provider’s 8,000-token limit.
- Confirm unsupported seats are reported as unavailable.
- Confirm no exchange, strategy, leverage, capital, or order behavior changes.
- Do not reboot until the full Architect → Manager approval → Builder → Auditor → final Manager review chain passes.

## Approval Required

Approve this prompt-budget and provider-validation patch. No changes have been applied, and the failed agent has not been retried.