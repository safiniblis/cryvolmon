## Diagnosis

The failure occurred at the Architect handoff. The live Architect seat is Groq `openai/gpt-oss-120b`, with an 8,000-token-per-minute limit. The request was 10,324 tokens—2,324 over the limit—so Groq rejected it with HTTP 413 before producing a plan.

The prompt expanded because resumed pipeline history repeatedly carried prior failures and artifacts. The existing packet-decomposition utility is not being used for the Architect request.

Live configuration also shows Builder assigned to a Nebius override, but that did not cause this failure. No trading strategy or risk setting changed. The service is currently running.

## Proposed Patch (not applied)

- **`server/council.ts`**
  - Send the Architect only the current job order, essential instructions, and narrowly relevant context.
  - Exclude repeated history, prior error analyses, and duplicate artifacts from Architect prompts.
  - Add a hard request-size budget below 8,000 tokens.
  - Detect HTTP 413 and stop without retrying the same oversized request.
  - Preserve a concise failure artifact for diagnosis.

- **`server/task-decomposer.ts`**
  - Reuse its context-slicing and bounded-packet logic for large Architect inputs where appropriate.
  - Ensure packet retries remain limited to the failed packet.

- **`server/agent-providers.ts`**
  - Add provider/model request-budget settings.
  - Log estimated prompt size and selected seat without logging credentials.
  - Keep all existing provider assignments and trading behavior unchanged.

No changes are proposed to exchanges, strategy parameters, leverage, capital, or live trading state.

## Verification After Approval

- Run TypeScript check and production build.
- Confirm Architect payloads stay below the configured safety budget.
- Confirm HTTP 413 stops safely without repeating the oversized request.
- Confirm resumed jobs do not accumulate duplicate history.
- Confirm provider assignments, exchange behavior, and trading settings remain unchanged.

## Approval Required

Approval is required before applying this patch. No files were changed and the failed agent was not retried.