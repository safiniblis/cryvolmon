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
