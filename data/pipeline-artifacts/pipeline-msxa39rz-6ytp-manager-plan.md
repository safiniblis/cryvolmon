## Finding

The Architect seat was miswired: it identified as OpenCode while pointing at the Abacus endpoint, causing the 403.

I corrected it to the healthy Groq Architect seat. Verification then exposed the remaining issue: the pipeline sends about 9,646 tokens to a provider limited to 8,000, so it is rejected before planning.

No trading settings or exchange behavior changed.

RECOVERY_BLOCKED: the pipeline context must be reduced below the Architect’s 8,000-token limit before it can run.