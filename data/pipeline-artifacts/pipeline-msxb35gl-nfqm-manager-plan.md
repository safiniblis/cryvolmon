## Diagnosis

The Architect seat itself is healthy: it is live on **Groq / `openai/gpt-oss-120b`** with the matching Groq endpoint and credential.

The failure is request size, not authorization or trading logic. Groq allows **8,000 tokens per minute**; this handoff requested **9,360**—**1,360 too many**—so Groq rejected it before the Architect could write a plan.

Logs show earlier retries alternated between oversized requests and rate limits. The current “compact context” safeguard is not sufficient because the total still includes large standing instructions, pipeline material, and the requested response reserve. The pipeline also resumes jobs automatically after service boot, which can repeat the same bad handoff.

## Proposed Patch (not applied)

**`server/council.ts`**
- Add a hard Architect handoff budget for Groq GPT-OSS-120B: input plus reserved output must remain safely below 8,000 tokens.
- Build the Architect prompt from only:
  - Architect instructions,
  - current manager order,
  - latest actionable feedback, if any,
  - a short repository brief.
- Exclude prior pipeline history, full council memory/archive, dashboard snapshot, and previous failed-provider messages from Architect requests.
- Cap Architect output explicitly and truncate the optional repository brief first when needed.
- Treat HTTP 413 as a blocked transport error: save the reason and stop; do not retry it.
- Treat HTTP 429 as a cooldown event: save the required wait and do not spend a plan-review loop.
- Count a loop only when Manager rejects an actual Architect plan.
- Prevent automatic startup resume from immediately resending a pipeline blocked by 413/429.

**`server/agent-providers.ts`**
- Add model-specific request-budget metadata for Groq `openai/gpt-oss-120b`, including a conservative total limit and maximum Architect output reserve.
- Make the pipeline call site consume that budget instead of relying on a character-only context cap.

**New focused test file, e.g. `server/council-pipeline.test.ts`**
- Verify a large order/history is compacted deterministically below the Architect budget.
- Verify HTTP 413 causes no retry and no loop increase.
- Verify HTTP 429 records a cooldown without consuming a loop.
- Verify a small documentation-only order still reaches the Architect.

## Verification After Approval

1. Run TypeScript check and production build.
2. Run the new focused pipeline tests.
3. Confirm the calculated Architect request stays below Groq’s 8,000-token limit.
4. Confirm simulated 413 and 429 responses leave the review-loop count unchanged.
5. Start a new small smoke-test job only after verification; do not resume or retry this failed job.

## Approval Required

Approve this pipeline-only patch to proceed. It does not alter trading risk, exchange behavior, strategy parameters, credentials, orders, or positions.