## Finding

The Architect was miswired to an external endpoint that rejects its credential. The external provider seats also currently reject or rate-limit their configured keys.

I switched Architect to the healthy local Qwen seat and confirmed it can answer directly, but the pipeline’s 60-second Architect timeout is too short for that local model. Build checks pass.

RECOVERY_BLOCKED: the local fallback needs its pipeline timeout raised before it can complete a plan reliably; external provider authorization is still unavailable.