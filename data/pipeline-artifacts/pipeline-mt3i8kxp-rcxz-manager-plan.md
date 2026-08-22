## Diagnosis

The failure occurred at the **Architect handoff**, before a build plan was produced.

- Groq’s `openai/gpt-oss-120b` seat allows 8,000 tokens/minute.
- The request contained 10,324 tokens—2,324 over the limit—so HTTP 413 rejected it.
- Repeated recovery attempts retained pipeline history, making requests larger.
- Live configuration also contains an invalid persisted Builder provider: `nebius`, which is not supported by the registered provider type.
- Logs show no trading activity, strategy changes, exchange actions, or service restart.

## Proposed Patch (not applied)

1. **`server/council.ts`**
   - Send the Architect only the current job order, role instructions, and necessary file context.
   - Exclude prior retry history, duplicate error analyses, and unrelated conversation history.
   - Add a hard Architect prompt-size budget below 8,000 tokens.
   - Treat HTTP 413 as a terminal blocked-stage error, not a repeated retry condition.
   - Allow the pipeline to proceed only after a valid Architect plan exists.

2. **`server/agent-providers.ts`**
   - Validate persisted seat providers against the supported `AgentProvider` list.
   - Ignore invalid entries such as `nebius` and fall back to the role default.
   - Ensure displayed and actual provider routing use the same validation.

3. **`data/council-runtime.json`**
   - Remove or replace the stale Builder override through the approved configuration path.
   - Do not expose or copy its stored credential.

No trading logic, exchange behavior, strategy parameters, leverage, or capital would change.

## Verification After Approval

- Confirm Architect requests stay safely below the provider limit.
- Confirm one HTTP 413 creates one blocked result without repeated resend attempts.
- Confirm invalid seat configuration falls back safely.
- Run TypeScript checking and the production build.
- Confirm no trading, strategy, exchange, credential, or service-state changes occurred.

## Approval Required

Approval is required before applying this pipeline-only patch.