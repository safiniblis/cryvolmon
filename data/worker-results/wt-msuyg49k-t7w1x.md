# Nightly summary 2026-08-15

- task: wt-msuyg49k-t7w1x
- assigned: opencode/big-pickle
- foreman reason: local model failed; use preferred capable model for important summarization
- foreman acceptance: accepted — verification unavailable (verifier reply was not JSON: )
- ran: 12.3s
- done: 2026-08-15T22:52:16.268Z

---

## Cryvolmon Operational Summary — 2026-08-15 UTC

### What Ran
- **Council Work Log panel** deployed, backed by `/api/decisions`; TypeScript/build verified and live service confirmed.
- **Trade page redesigned** with simplified account panels and Add Keys buttons for Bitrue and Bitunix.
- **Resumable manager workflow + tandem order-coordination** shipped; live HTTP checks passed without an extra restart.
- **Tandem balancing work** progressed: rebalance tolerance corrected to 3% relative to each configured side weight; outer-open 1.05 / outer-close 0.95 growth/decay and missing-order rebuilds verified on child grids.
- **Autonomous manager loop fixed**: `restart_service` now fires only after the manager's final reply so closing steps complete; `run_shell/run_sudo` block cryvolmon restart/stop/start commands, closing the restart-loop bypass.
- **Compact trading interface origin investigated**: original UI created by Manager commits `144e936`/`08a6309`; current key-button removal is an uncommitted