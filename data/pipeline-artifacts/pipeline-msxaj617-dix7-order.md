## GOAL
Test the agent pipeline end-to-end and add separate compact recent-memory files for each agent role, so each role receives its own relevant context without loading the full system history.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
Do not alter trading settings, orders, exchange integrations, or strategy behavior. Memory must be role-scoped, bounded in size, plain-English, safely persisted, and included only for the matching role. Preserve existing pipeline approval and failure handling.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
- Each pipeline role has a distinct recent-memory file created and maintained automatically.
- A role receives its own memory, not the complete conversation/archive.
- Memory records concise decisions, outcomes, and unresolved issues without secrets.
- Run a small harmless pipeline test job successfully through its normal stages.
- Confirm the application builds, starts, and the tested pipeline records its result without affecting trading.

## FILES-TO-TOUCH (your best guess of the files involved)
`server/council.ts`, `server/agent-providers.ts`, `server/routes.ts`, `script/council-watchdog.mjs`, `data/council-memory.json`, new role-memory files under `data/`, `data/changelog.md`