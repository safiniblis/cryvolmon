## GOAL
Append one UTC-timestamped test entry to `data/changelog.md` confirming the build pipeline is operational.

## CONSTRAINTS (locked risk: leverage, capital, ticker, exchange semantics — never to be changed)
- Do not modify trading logic, risk settings, credentials, or exchange behavior.
- Use the actual current UTC timestamp.
- Append only; do not rewrite or remove existing changelog entries.
- No service reboot is required.

## ACCEPTANCE CRITERIA (how we know the job is done AND running)
- `data/changelog.md` contains a new entry with a UTC timestamp and clear pipeline-operational confirmation.
- Existing entries remain unchanged.
- The appended entry is saved and readable after the job completes.

## FILES-TO-TOUCH (your best guess of the files involved)
- `data/changelog.md`