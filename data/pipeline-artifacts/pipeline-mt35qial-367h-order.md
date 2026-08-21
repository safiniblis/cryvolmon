## GOAL
Implement and safely deploy opt-in inventory-target balancing for existing Tandem strategies. Derive each leg’s target from its child grid’s stored `fixedInitialQty`—never hardcode a quantity or create market-order backfills. Balance long and short inventory independently while preserving existing Tandem budget/side-ratio rebalance behavior.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
- Do not change leverage, capital/budget, ticker, exchange, authentication, position mode, order side, or order semantics.
- Feature defaults to disabled for existing strategies and must not alter Tandem #30 until explicitly enabled in its configuration.
- Add managed parameters with validation, hard bounds, and safe defaults for:
  - inventory-balancing enable flag;
  - inventory tolerance percentage;
  - future opening-order quantity boost cap;
  - maximum take-profit reserve while below target.
- Calculate each leg’s inventory as live position quantity plus safely identifiable pending opening-order quantity from existing child-grid orders.
- Adjust only future grid opening quantities, within the configured boost cap.
- Reserve additional quantity from ordinary take-profit closes only within the configured reserve cap.
- When inventory is at/above target, restore normal opening sizing and close behavior.
- Honor available margin, minimum order size, fast-price pause, existing safety gates, and current rebalance logic.
- Prevent cancel/recreate storms, emergency market orders, and new backfill orders.
- Preserve existing order idempotency and exchange semantics.
- Required pipeline: Architect plan and Manager approval before coding; Builder implementation; Auditor approval; final Manager review; passing checks/build before restart.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
- Architect plan is recorded and explicitly approved by Manager before implementation.
- Builder adds the opt-in balancing logic and configuration validation without changing locked inputs or unrelated strategies.
- Target derivation uses each child grid’s stored `fixedInitialQty`; no hardcoded `497` or equivalent fixed quantity exists.
- Tests cover target derivation, pending-opening accounting, under-target, within-tolerance, over-target, margin/minimum-size limits, fast-price pause, disabled mode, and no-storm/no-market-backfill behavior.
- Existing Tandem #30 produces identical behavior while the feature remains disabled.
- Auditor confirms implementation, tests, risk constraints, and documentation/changelog compliance.
- Final Manager review approves only after Auditor approval; type-check, test suite, and production build pass.
- Service is restarted only after all gates pass, then health and strategy checks confirm the service is running and Tandem #30 remains unchanged unless explicitly enabled.

## FILES-TO-TOUCH (your best guess of the files involved)
- `server/tandem-engine.ts`
- `server/managed-params.ts`
- `server/order-coordinator.ts`
- `server/strategy-engine.ts`
- `server/storage.ts`
- `shared/schema.ts`
- `shared/routes.ts`
- `server/routes.ts`
- `server/tandem-decision-log.ts`
- `server/gold-long-engine.test.ts` or new focused Tandem test file
- `data/changelog.md`
- Relevant pipeline artifacts under `data/pipeline-artifacts/` via the normal Architect/Manager/Builder/Auditor workflow