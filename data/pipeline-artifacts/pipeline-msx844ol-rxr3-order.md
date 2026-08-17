## GOAL
Document the current neurosymbolic trading app and test its council pipeline. Implement role-specific recent memory files for manager, architect, builder, auditor, critic, strategist, and trader so each agent receives concise relevant context without loading the full history.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
- Do not change leverage, capital, ticker, side, or exchange routing.
- Gold remains E-XAUT-USDT on Bitrue; non-gold strategies remain on Bitunix.
- Do not start live trading or alter orders, positions, or strategy parameters.
- Preserve existing council roles, seat policy, authentication, and fallback behavior.
- Memory writes must be bounded, role-scoped, append-safe, and exclude secrets.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
- Current app purpose and pipeline flow are documented.
- Each role has its own recent-memory file with a defined size/retention limit.
- Pipeline reads only the relevant role memory and writes a concise result after each stage.
- Missing, corrupt, or unwritable memory safely falls back without blocking the pipeline.
- A full dry-run pipeline test completes through manager, architect, builder, auditor, and final manager review.
- TypeScript check and production build pass.
- Service restarts successfully and logs confirm the memory system and test pipeline are active.
- No live orders, risk settings, credentials, or exchange semantics change.

## FILES-TO-TOUCH
- `server/council.ts`
- `server/agent-providers.ts`
- `server/routes.ts`
- `data/council-memory.json`
- `data/council-conversation.json`
- `data/pipeline-state.json`
- `data/agent-memory/` (new role-specific files)
- `.gitignore`
- `data/changelog.md`
- `server/council-memory.test.ts` (new)
- `server/pipeline.test.ts` (new)