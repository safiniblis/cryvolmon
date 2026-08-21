## Diagnosis

This was a pipeline-sizing failure, not a trading failure.

- Groq Architect seat: `openai/gpt-oss-120b`
- Provider limit: **8,000 tokens per minute**
- Failed request: **10,297 tokens**
- Earlier attempt: **10,783 tokens**

The request included lengthy role instructions, job order, repository context, and pipeline history. The Architect never produced a build plan; no code, trading settings, orders, or restart changed.

Live seats show the Architect and Auditor sharing Groq 120B. The Builder is using a persisted Nebius override that is not represented in the declared provider type/seat registry. This configuration mismatch should also be corrected.

## Proposed Patch (not applied)

**`server/council.ts`**

1. Build a compact Architect request containing only the job order, relevant files, constraints, and necessary prior artifact.
2. Exclude full council history, unrelated repository files, and runtime data.
3. Enforce a request budget safely below 8,000 tokens, including output allowance.
4. Treat HTTP 413 as a terminal blocked error; do not retry the failed agent.
5. Prevent a failed request from consuming the review-loop budget.

**`server/agent-providers.ts`**

1. Validate persisted seat overrides against supported providers and models.
2. Ignore or safely clear invalid overrides such as the persisted Nebius Builder assignment.
3. Add provider/model budget metadata for Groq 120B.
4. Keep provider changes limited to pipeline configuration; do not alter trading or exchange behavior.

**Tests**

Add focused pipeline tests covering compact context, 413 handling, no retry, and invalid-seat override rejection.

## Verification After Approval

- Run TypeScript checking and the production build.
- Confirm the estimated Architect request is below 8,000 tokens.
- Confirm a 413 creates one blocked result without retrying.
- Confirm invalid provider overrides cannot become active.
- Confirm no trading files, risk settings, live orders, or service restart are involved.

## Approval Required

Approval is required before applying this pipeline-only patch.