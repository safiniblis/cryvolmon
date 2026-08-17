## GOAL
Run a documentation-only pipeline smoke test verifying Manager → Architect → Builder → Auditor handoffs and their exact configured models. Builder may add one concise verification note to the changelog.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
Do not change trading, exchanges, credentials, strategies, orders, positions, balances, leverage, capital, tickers, risk settings, or application behavior. No service restart. Documentation/changelog only.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
All four pipeline stages complete in order with recorded handoff artifacts naming their configured models. Auditor approves. One concise changelog note confirms the smoke test. TypeScript check and production build pass; existing service remains running unchanged.

## FILES-TO-TOUCH (your best guess of the files involved)
- `data/changelog.md`
- `data/pipeline-artifacts/` (pipeline-generated evidence only)