# Cryvolmon Change Log

- 2026-08-15T00:30:52.013Z — Added the Council Work Log panel backed by /api/decisions, verified TypeScript and production build, and confirmed the live service returns the endpoint successfully after restart.
- 2026-08-15T01:08:43.929Z — Redesigned trade page for better user experience and added button to add keys for Bitrue and Bitunix exchanges
- 2026-08-15T08:13:01.068Z — 2026-08-15 — Completed and verified the compact trading page with simplified account panels, Bitunix/Bitrue Add Keys dialogs using the existing session key route, and live HTTP checks; production build passed and service was already running the new bundle.
- 2026-08-15T17:48:16.628Z — Completed the resumable manager workflow and tandem order-coordination changes; TypeScript check and production build passed, and the already-running service answered live HTTP checks without another restart.
- 2026-08-15T17:51:54.787Z — Cancelled all ADAUSDT pending orders without closing positions and verified the running tandem rebuilt child grid orders after the test.
- 2026-08-15T18:07:51.588Z — Corrected tandem rebalance tolerance to measure 3% relative to each configured side weight, adjusted both grid multipliers toward target weights, and verified type-check, production build, and live service logs.
- 2026-08-15T18:43:09.781Z — 2026-08-15 — Resumed tandem balancing verification after server restart; source already contained weight-relative correction, TypeScript check and production build passed, and the running service returned HTTP 200 with live tandem/grid cycles.
