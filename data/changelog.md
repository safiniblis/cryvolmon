# Cryvolmon Change Log

- 2026-08-15T00:30:52.013Z — Added the Council Work Log panel backed by /api/decisions, verified TypeScript and production build, and confirmed the live service returns the endpoint successfully after restart.
- 2026-08-15T01:08:43.929Z — Redesigned trade page for better user experience and added button to add keys for Bitrue and Bitunix exchanges
- 2026-08-15T08:13:01.068Z — Completed and verified the compact trading page with simplified account panels, Bitunix/Bitrue Add Keys dialogs using the existing session key route, and live HTTP checks; production build passed and service was already running the new bundle.
- 2026-08-15T17:21:08.459Z — Fixed tandem parent close/reduce orders fighting child grid opens at the same price. Added server/order-coordinator.ts: parent closes reserve their grid cell, child grids skip opening against a pending close near that level, and stale reservations expire on each cycle. Also gave the council manager a write_file tool (create/overwrite files) and raised manager maxTokens to 8000 with a 5-minute timeout. Verified TypeScript check, production build, and live service restart.
