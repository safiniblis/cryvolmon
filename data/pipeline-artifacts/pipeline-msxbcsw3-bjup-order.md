## GOAL
Run the full live smoke-test pipeline for a documentation-only job, with no product or trading changes.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
No source, trading, exchange, credential, service, strategy, order, position, balance, or risk-setting changes. Do not create pipeline artifact files. Builder may only append one concise note to `data/changelog.md`.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
Manager plan approved; Architect plan reviewed by Manager; Builder completes the permitted changelog note and passes existing type-check and production build; Auditor approves; Manager final gate confirms all constraints held. No service restart is needed.

## FILES-TO-TOUCH (your best guess of the files involved)
`data/changelog.md` only (optional single concise appended note).