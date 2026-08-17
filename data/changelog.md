# Cryvolmon Change Log

- 2026-08-15T00:30:52.013Z — Added the Council Work Log panel backed by /api/decisions, verified TypeScript and production build, and confirmed the live service returns the endpoint successfully after restart.
- 2026-08-15T01:08:43.929Z — Redesigned trade page for better user experience and added button to add keys for Bitrue and Bitunix exchanges
- 2026-08-15T08:13:01.068Z — 2026-08-15 — Completed and verified the compact trading page with simplified account panels, Bitunix/Bitrue Add Keys dialogs using the existing session key route, and live HTTP checks; production build passed and service was already running the new bundle.
- 2026-08-15T17:48:16.628Z — Completed the resumable manager workflow and tandem order-coordination changes; TypeScript check and production build passed, and the already-running service answered live HTTP checks without another restart.
- 2026-08-15T17:51:54.787Z — Cancelled all ADAUSDT pending orders without closing positions and verified the running tandem rebuilt child grid orders after the test.
- 2026-08-15T18:07:51.588Z — Corrected tandem rebalance tolerance to measure 3% relative to each configured side weight, adjusted both grid multipliers toward target weights, and verified type-check, production build, and live service logs.
- 2026-08-15T18:43:09.781Z — 2026-08-15 — Resumed tandem balancing verification after server restart; source already contained weight-relative correction, TypeScript check and production build passed, and the running service returned HTTP 200 with live tandem/grid cycles.
- 2026-08-15T18:52:00.000Z — Fixed the autonomous manager work loop so jobs always complete: restart_service is now deferred and fires only AFTER the manager final reply, so the closing steps (log_change, git_commit, mark_job done) are no longer killed mid-restart; run_shell/run_sudo reject cryvolmon service restart/stop/start commands to close the restart-loop bypass; and a turn that ends with a final reply auto-completes the active job. Verified TypeScript check, production build, and live restart.
- 2026-08-15T19:52:53.527Z — 2026-08-15 — Resumed the interrupted balancing review: confirmed mild 1.05 outer-open growth and 0.95 outer-close decay are implemented for tandem child grids, with missing-order rebuilds on each cycle; TypeScript check and production build passed, and a service restart was queued.
- 2026-08-15T20:02:33.506Z — Rechecked tandem balancing deployment: strategy remains running in waiting-liquidation with exchange capital tracking active; TypeScript check and production build passed.
- 2026-08-15T20:31:17.991Z — Investigated the compact trading interface origin: it was created by Manager commits 144e936 and 08a6309; confirmed the current key-button removal is only an uncommitted workspace edit with no recorded author or source.

- 2026-08-15T21:55:36.124Z — Worker wt-msuwzxam-iqnbz "Nightly summary 2026-08-15" done via groq/openai/gpt-oss-20b (fast summarization job, simple extraction, no deep reasoning needed) in 1s.
- 2026-08-15T22:12:17.118Z — Qwen recovered wt-msux2k7c-m9tju "Nightly summary 2026-08-15" — qwen (fallback): no JSON: (attempt 1/2). Foreman will reassign.
- 2026-08-15T22:12:20.584Z — Worker wt-msux2k7c-m9tju "Nightly summary 2026-08-15" done via groq/llama-3.3-70b-versatile (fast summarization, simple extraction, no deep reasoning needed) in 2s.
- 2026-08-15T22:31:30.312Z — Worker wt-msuy9zeh-yjimi "Ollama on this VM" done via groq/llama-3.3-70b-versatile (foreman accepted) in 1s — queued for manager review.
- 2026-08-15T22:35:59.515Z — Nightly review: worker wt-msuy9zeh-yjimi "Ollama on this VM" needs REWORK — re-queued: Contains extra markdown header and metadata; should be only title line and four numbered points, no other text.
- 2026-08-15T22:52:01.607Z — Worker wt-msuyg49k-t7w1x "Nightly summary 2026-08-15" failed (run error: fetch failed) — re-queued for foreman reassignment (attempt 1/2).
- 2026-08-15T22:52:16.269Z — Worker wt-msuyg49k-t7w1x "Nightly summary 2026-08-15" done via opencode/big-pickle (foreman accepted) in 12s — queued for manager review.
- 2026-08-15T22:55:10.442Z — Worker wt-msuy9zeh-yjimi "Ollama on this VM" done via groq/llama-3.3-70b-versatile (foreman accepted) in 1s — queued for manager review.
- 2026-08-15T23:05:47.110Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (2x fail) -> groq/openai/gpt-oss-120b (218ms)
- 2026-08-15T23:50:25.810Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (3x fail) -> groq/openai/gpt-oss-120b (203ms)
- 2026-08-16T00:10:47.817Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (4x fail) -> groq/openai/gpt-oss-120b (330ms)
- 2026-08-16T00:22:43.188Z — Modernized the council chat header with a conversation identity, clear-chat control, and preserved existing model and specialist routing; TypeScript check and production build passed.
- 2026-08-16T00:25:49.230Z — Verified the council UI change is built in dist and served by the VM; queued a service restart to ensure the running process reloads the current production bundle.
- 2026-08-16T00:28:39.358Z — Manager accepted worker task wt-msuy9zeh-yjimi "Ollama on this VM" (The four-line operational tip is complete, accurate, and matches the requested Ollama caveats.)
- 2026-08-16T00:30:01.285Z — Made the Council chat controls visibly explicit with a labeled New chat button and New conversation badge; type-check and production build passed.

- 2026-08-16T00:40:49.383Z — Worker wt-msv2wa3p-m4ojm "Worker task breakdown for X trend project" result rejected by foreman (The plan is missing explicit privacy/compliance and deployment documentation tasks, and the testing task is incomplete (truncated acceptance criteria).) — re-queued for rework (attempt 1/2).
- 2026-08-16T00:44:10.400Z — Worker wt-msv2wa3p-m4ojm "Worker task breakdown for X trend project" failed (run error: HTTP 404 404 page not found
) — re-queued for foreman reassignment (attempt 2/2).
- 2026-08-16T00:47:38.617Z — Worker wt-msv2wa3p-m4ojm "Worker task breakdown for X trend project" done via groq/openai/gpt-oss-120b (foreman accepted-with-reservations) in 4s — queued for manager review.
- 2026-08-16T00:50:25.729Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (2x fail) -> groq/openai/gpt-oss-120b (199ms)
- 2026-08-16T00:50:47.729Z — Worker wt-msv2wa3k-ircct "X trend listener architecture plan" result rejected by foreman (Missing sections: risks and blockers, and acceptance checklist are not provided. The result is incomplete per the job requirements.) — re-queued for rework (attempt 1/2).
- 2026-08-16T00:53:44.341Z — Worker wt-msv2wa3k-ircct "X trend listener architecture plan" failed (run error: HTTP 404 404 page not found
) — re-queued for foreman reassignment (attempt 2/2).
- 2026-08-16T00:56:54.816Z — Worker wt-msv2wa3k-ircct "X trend listener architecture plan" done via groq/openai/gpt-oss-20b (foreman accepted-with-reservations) in 2s — queued for manager review.
- 2026-08-16T01:00:01.276Z — Worker wt-msv2wa3m-5x7vu "Trend data model and scoring design" result rejected by foreman (The submission is incomplete and missing several required elements: the duplicate detection section is cut off, there are no explicit definitions for velocity, confidence scores, trend lifecycle state) — re-queued for rework (attempt 1/2).
- 2026-08-16T01:03:03.400Z — Worker wt-msv2wa3m-5x7vu "Trend data model and scoring design" done via groq/openai/gpt-oss-120b (foreman accepted) in 5s — queued for manager review.
- 2026-08-16T01:03:20.929Z — Added a small Dashboard Live Data tile for X with a password-style token dialog, server-only storage, protected file permissions, and token exclusion from git; TypeScript check and production build passed.
- 2026-08-16T01:05:20.553Z — Manager rework worker task wt-msv2wa3k-ircct "X trend listener architecture plan" (The report is truncated and still lacks the required complete acceptance checklist plus concrete X source-attribution and redistribution requirements; return a complete, self-contained plan.) — rework requested but retry budget exhausted; keeping result for operator review.
- 2026-08-16T01:05:20.555Z — Manager rework worker task wt-msv2wa3p-m4ojm "Worker task breakdown for X trend project" (Complete the truncated TS-01 end-to-end testing ticket and add the missing deployment documentation/runbook task with clear acceptance criteria.) — rework requested but retry budget exhausted; keeping result for operator review.
- 2026-08-16T01:05:20.559Z — Manager accepted worker task wt-msv2wa3m-5x7vu "Trend data model and scoring design" (Useful scoring and storage design; keep its assumptions clearly marked as unverified until the actual X API tier and fields are tested.)

- 2026-08-16T01:06:13.285Z — Worker wt-msv2wa3n-7ixaq "VM operations plan for real-time trend job" done via groq/openai/gpt-oss-120b (foreman accepted) in 4s — queued for manager review.
- 2026-08-16T01:30:40.969Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (2x fail) -> groq/openai/gpt-oss-120b (305ms)
- 2026-08-16T12:06:05.356Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (2x fail) -> groq/openai/gpt-oss-120b (330ms)
- 2026-08-16T12:30:18.019Z — Executed plan to verify Bitrue gold connectivity and add a gold-engine health tile.
- 2026-08-16T12:32:05.098Z — Started building and running the project to execute the plan for the gold long bot improvements.

- 2026-08-16T12:35:46.216Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (2x fail) -> groq/openai/gpt-oss-120b (196ms)
- 2026-08-16T12:36:59.718Z — Added a read-only Gold Engine Health endpoint and dashboard tile for E-XAUT-USDT status, mark, budget, and tracked orders; TypeScript check and production build passed.

- 2026-08-16T12:55:25.380Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (5x fail) -> groq/openai/gpt-oss-120b (199ms)
- 2026-08-16T14:45:25.608Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (6x fail) -> groq/openai/gpt-oss-120b (266ms)
- 2026-08-16T15:57:46.742Z â€” Manager rework worker task wt-msv2wa3n-7ixaq "VM operations plan for real-time trend job" (The response is incomplete and lacks a health-check endpoint for the live gold mark price) â€” sent back through foreman/worker for rework with actionable feedback (attempt 1/2).

- 2026-08-16T15:58:13.333Z — Worker wt-msv2wa3n-7ixaq "VM operations plan for real-time trend job" result rejected by foreman (The response is incomplete: missing sections on log rotation, full observability checklist, dashboards/alerts, deployment/rollback steps, and a detailed failure runbook. It stops mid‑sentence and does) — re-queued for rework (attempt 2/2).
- 2026-08-16T16:01:06.548Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (7x fail) -> groq/openai/gpt-oss-120b (259ms)
- 2026-08-16T16:01:19.190Z — Worker wt-msv2wa3n-7ixaq "VM operations plan for real-time trend job" failed permanently after 2 attempts: run error: HTTP 404 404 page not found
- 2026-08-16T16:33:40.327Z â€” Proposed gold grid-bot params: grid step 0.5%, order size 0.5% of 41.27 USDT budget (~0.2065 contract units), max 10 orders, liquidation guard at 3,939.39 USDT. Logged for review.
- 2026-08-16T16:44:04.805Z â€” Separated gold budget handling from Bitunix: gold entry and health now read available USDT from Bitrue only, with configured capital as a ceiling; TypeScript check and production build passed.
- 2026-08-16T16:54:11.759Z â€” Created the stopped, dry-run Bitrue Gold Grid draft for E-XAUT-USDT with the reviewed budget and guard settings; added the missing trading-page start hook; TypeScript check and production build passed.
- 2026-08-16T16:59:02.643Z â€” Gold long strategy configured in dry-run with baseCapital 41.27 USDT, leverage 10, liquidationGuard $3,939.39, 0.5% grid step, 0.5% order size, max 10 queued orders, 10% fee buffer
- 2026-08-16T17:00:50.495Z â€” 2026-08-16 — Resumed gold strategy review: verified the stopped Bitrue E-XAUT-USDT draft, live health endpoint returned mark 4360.92, available budget 41.27 USDT, zero open orders, and no error; TypeScript check and production build passed.

- 2026-08-16T17:06:06.621Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (8x fail) -> groq/openai/gpt-oss-120b (205ms)
- 2026-08-16T17:11:16.099Z â€” Fixed the generic Start action for Gold Long: it now checks Bitrue credentials, resets the engine to entry phase, and triggers an immediate cycle; TypeScript check and production build passed.

- 2026-08-16T17:25:45.661Z — Seat watchdog: SWITCH strategist: openrouter/google/gemma-4-26b-a4b-it:free (12x fail) -> groq/openai/gpt-oss-120b (171ms)
- 2026-08-16T21:48:30.657Z — Worker wt-mswbjx1w-2ftkp "Nightly summary 2026-08-16" failed (run error: fetch failed) — re-queued for foreman reassignment (attempt 1/2).
- 2026-08-16T22:04:04.191Z — Worker wt-mswbjx1w-2ftkp "Nightly summary 2026-08-16" failed (run error: fetch failed) — re-queued for foreman reassignment (attempt 2/2).
- 2026-08-16T22:19:37.832Z — Worker wt-mswbjx1w-2ftkp "Nightly summary 2026-08-16" failed permanently after 2 attempts: run error: fetch failed
- 2026-08-17T13:00:27.530Z — Seat watchdog: SWITCH architect: opencode/claude-sonnet-4 (2x fail) -> groq/openai/gpt-oss-120b (378ms)
- 2026-08-17T13:19:19.715Z — Added a Remove control for stopped pipeline loops; it clears the saved loop state and its saved artifacts after confirmation, while running jobs still require cancellation first. TypeScript check and production build passed.
- 2026-08-17T13:26:31.666Z — Recovered the Architect seat from an exhausted Abacus model to healthy Groq GPT-OSS 120B, stopped startup logic from silently replacing that valid seat, and capped pipeline context at 3,500 characters to leave room below the provider’s 8k request limit; TypeScript check, production build, and live Architect probe passed.
- 2026-08-17T13:28:01.767Z — Further hardened Architect recovery: reduced the shared pipeline snapshot to 1,800 characters so its instructions, tool definitions, plan request, and completion reserve remain below Groq's 8k request limit; TypeScript check and production build passed.

- 2026-08-17T13:36:10.200Z — Seat watchdog: SWITCH architect: openrouter/openrouter/free (2x fail) -> groq/openai/gpt-oss-120b (196ms)
- 2026-08-17T13:42:01.019Z — Recovered the Architect seat from an unauthorized mixed endpoint to Groq GPT-OSS 120B and capped pipeline handoff context at 3,500 characters; Architect probe, TypeScript check, and production build passed without trading changes.
- 2026-08-17T13:58:48.607Z — 2026-08-17 — Repaired the Architect seat’s unauthorized mixed-provider configuration by switching it to authenticated Groq GPT-OSS 120B with Groq’s matching endpoint; a live Architect smoke test returned ARCHITECT_PROVIDER_OK. No trading or exchange settings changed.
- 2026-08-17T14:00:49.085Z — Fixed Architect pipeline request sizing: member seats now receive a compact, tool-backed context instead of the full dashboard/archive payload, preventing Groq GPT-OSS 120B’s 8k TPM request overflow; TypeScript check and production build passed.
