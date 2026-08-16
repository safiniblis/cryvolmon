# Nightly summary 2026-08-15

- task: wt-msuwzxam-iqnbz
- assigned: groq/openai/gpt-oss-20b
- foreman reason: fast summarization job, simple extraction, no deep reasoning needed
- ran: 1.1s
- done: 2026-08-15T21:55:36.123Z

---

# Nightly Summary – 2026‑08‑15 UTC

## System Activity
- **Service restarts**: 3 (00:30, 17:48, 18:52). All restarts succeeded without downtime; HTTP 200 responses confirmed.
- **Feature deployments**:
  - Council Work Log panel (00:30) – API `/api/decisions` verified.
  - Trade page redesign (01:08) – added Bitrue/Bitunix key buttons.
  - Compact trading page (08:13) – simplified account panels, live HTTP checks passed.
  - Resumable manager workflow & tandem order‑coordination (17:48) – no restart needed.
  - Tandem rebalance tolerance fix (18:07) – 3 % relative to side weight; verified.
  - Autonomous manager loop fix (18:52) – ensured job completion before restart; `run_shell/run_sudo` now blocks restart commands.
  - Balancing review resume (19:52) – outer‑open 1.05, outer‑close 0.95, missing‑order rebuilds; restart queued.
  - Balancing deployment re‑check (20:02) – strategy still in waiting‑liquidation with capital tracking.
  - Compact trading interface origin investigation (20:31) – confirmed uncommitted workspace edit.

## Worker Results
- No worker jobs executed today. All scheduled tasks were either idle or completed in previous cycles.

## Model Health
| Model | Status | Latency |
|-------|--------|---------|
| groq/openai/gpt-oss-120b | healthy | 227 ms |
| nvidia/nvidia/nemotron-3-ultra-550b-a55b | healthy | 488 ms |
| groq/llama-3.3-70b-versatile | healthy | 311 ms |
| nvidia/nvidia/nemotron-3-super-120b-a12b | healthy | 1911 ms |
| groq/openai/gpt-oss-20b | healthy | 188 ms |
| nvidia/openai/gpt-oss-20b | healthy | 634 ms |
| ovh/Qwen3-32B | healthy | 385 ms |
| ovh/Mistral-Small-3.2-24B-Instruct-2506 | healthy | 218 ms |
| **Stale** | nvidia/openai/gpt-oss-120b, ovh/gpt-oss-120b, ovh/Qwen3.5-397B-A17B, ovh/Meta-Llama-3_3-70B-Instruct, ovh/gpt-oss-20b | – |

## Notable Events & Anomalies
- **Tandem rebalance tolerance**: Previously mis‑measured; corrected to relative 3 % per side weight.
- **Autonomous manager loop**: Jobs were being killed mid‑restart due to premature `restart_service`. Fixed by deferring restart until after final reply.
- **Balancing review**: Minor growth/decay parameters (1.05/0.95) implemented; missing‑order rebuilds confirmed.
- **Compact trading interface**: Uncommitted workspace edit removed; no impact on production.

## Recommended Actions
1. **Stale model cleanup**: Remove or update the five stale models to free resources and avoid confusion.
2. **Monitor restart loop**: Verify that `run_shell/run_sudo` blocks are effective; add unit tests for restart safety.
3. **Tandem balancing logs**: Add metrics for outer‑open/close growth to detect future drift.
4. **Feature flag audit**: Ensure all new UI components (Council Work Log, key buttons) are covered by regression tests.
5. **Worker queue**: Investigate why no worker jobs ran today; confirm scheduling and trigger conditions.

*All builds passed TypeScript checks and production builds; live service remained healthy throughout the day.*