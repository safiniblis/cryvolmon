## GOAL
Run a safe end-to-end pipeline smoke test using a harmless documentation-only job.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
No trading logic, strategy settings, exchange credentials, orders, or service behavior may change.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
Pipeline completes Architect → Builder → Auditor without retries or blockage; a dated smoke-test note is recorded; checks and production build pass; service remains running.

## FILES-TO-TOUCH (your best guess of the files involved)
data/changelog.md