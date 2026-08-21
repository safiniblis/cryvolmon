## GOAL
Implement the approved Tandem inventory-target balancing change for existing running strategy behavior. For each long and short child grid, preserve the original initial ADA quantity target (approximately 497 ADA per side for strategy #30) from the stored initial entry. Count live position plus pending opening orders. Below tolerance, boost opening quantities and protect/reduce ordinary closing quantities; above target, remove the boost and permit normal closes. Use backward-compatible managed-parameter defaults.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
- Keep current capital allocation, `initialSharePct=25%`, and `grid allocation=75%`.
- Do not change leverage, ticker, exchange, authentication, order semantics, or locked risk inputs.
- Do not start or stop strategies, place live orders, or restart the service during implementation.
- Preserve existing Tandem configurations and behavior unless the new balancing logic applies.
- Add only managed parameters for inventory tolerance, opening boost, and maximum close reserve.
- Do not invent or reset the original initial quantity target.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
- Architect plan is approved before code changes; Builder implements only the approved scope; Auditor approves the result.
- Each child side uses its stored original initial ADA target and evaluates live position plus pending opening orders.
- Below target tolerance: opening quantities increase within the configured boost and ordinary closing quantities are protected by the configured reserve.
- Above target: opening boost is removed/reduced and normal closing behavior is allowed.
- Missing legacy parameters use safe backward-compatible defaults without changing locked risk.
- TypeScript check and production build pass.
- No live orders, strategy state changes, or service restart occur before final Manager approval.
- After Auditor approval and Manager-approved restart, the running service demonstrates the balancing logic without changing locked inputs.

## FILES-TO-TOUCH (your best guess of the files involved)
- `server/tandem-engine.ts`
- `server/managed-params.ts`
- `server/strategy-engine.ts`
- `server/order-coordinator.ts` (only if required for pending-order accounting or close protection)
- `shared/schema.ts` (only if parameter/config typing requires it)
- `server/gold-long-engine.test.ts` or a new focused Tandem test file
- `data/changelog.md` (implementation summary only)