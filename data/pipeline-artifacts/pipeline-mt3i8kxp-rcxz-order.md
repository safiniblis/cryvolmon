## GOAL
Verify that commit `91349ca` contains the intended Tandem inventory-target recovery behavior. Produce a short Architect plan, have Builder run type-check and production build without editing when implementation is present, obtain Auditor approval or rejection, then complete Manager final review. Do not restart unless an approved code change is required.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
- No file edits unless a concrete regression is found.
- Do not change trading logic beyond correcting a verified regression.
- Do not change leverage, capital, ticker, exchange behavior, credentials, live orders, strategy state, or service state.
- Do not consult or modify live trading state.
- Builder must make no edits for an already-correct implementation.
- No restart for this no-op verification.
- If a regression is found, stop for pipeline approval before any change.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
- Architect supplies a concise verification plan.
- Existing Tandem inventory-target behavior is confirmed against commit `91349ca`.
- Builder completes type-check and production build successfully with no edits.
- Auditor explicitly approves the verification.
- Manager records the final review and confirms no code, risk, trading, or service-state changes.
- The existing service remains running; no restart is performed unless an approved fix was actually made.

## FILES-TO-TOUCH (your best guess of the files involved)
- `server/tandem-engine.ts` — inspect existing inventory-target behavior.
- `server/tandem-decision-log.ts` — inspect related decision recording if needed.
- `server/gold-long-engine.test.ts` — run or inspect relevant regression coverage if applicable.
- `data/changelog.md` — record the verification result.
- `data/pipeline-artifacts/` — store Architect, Builder, Auditor, and Manager pipeline records.