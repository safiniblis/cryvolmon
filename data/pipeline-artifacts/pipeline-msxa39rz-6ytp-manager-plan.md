Recovered the Architect stage.

- Cause: the Architect was labelled OpenCode but pointed at Abacus, so its credential was rejected (403).
- Fixed: rewired it to Groq GPT‑OSS 120B and capped pipeline handoff context to fit its request limit.
- Verified: Architect probe, TypeScript check, and production build passed. No trading settings changed.

Commit: `519c11b`

RECOVERY_FIXED: provider wiring and prompt-size limit repaired.