## GOAL
Map the current app’s trading/pipeline purpose, then add per-role recent-memory files so each agent loads only its own concise context. Run a safe end-to-end pipeline test using a non-trading test job.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
Do not place orders, start/stop strategies, alter exchange credentials, or change any locked trading settings. Memory must be concise, role-scoped, plain text/JSON, safely created if absent, and must not store secrets or raw logs.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
- Each pipeline role has a separate recent-memory file.
- Pipeline reads that role’s memory and writes a short updated summary after its step.
- A safe test job completes through the pipeline without trading activity.
- Dashboard/pipeline status clearly shows the test result and any failure reason.
- Type check and production build pass; deployed service starts cleanly.

## FILES-TO-TOUCH (your best guess of the files involved)
- `data/council-memory.json`
- `data/council-runtime.json`
- `data/pipeline-state.json`
- `data/pipeline-artifacts/`
- `data/active-job.json`
- `script/council-watchdog.mjs`
- `script/daily-review.mjs`
- `client/src/pages/council.tsx`
- `client/src/hooks/use-council.ts`
- Relevant server pipeline/agent orchestration files discovered during the app map