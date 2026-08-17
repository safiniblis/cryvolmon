## GOAL
Run one harmless end-to-end pipeline smoke test using the configured Manager, Architect, Builder, and Auditor models; record a documentation-only verification note.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
No changes to trading logic, exchange configuration, credentials, strategies, orders, positions, balances, or risk behavior. No strategy may be started or stopped. Documentation-only output.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
All four roles complete their handoffs using their configured models; Builder makes only the verification-note change; Auditor approves it; TypeScript check and production build pass; the service remains running after restart; the note records the successful smoke test.

## FILES-TO-TOUCH (your best guess of the files involved)
- `data/changelog.md`
- `data/pipeline-artifacts/` (pipeline records only)