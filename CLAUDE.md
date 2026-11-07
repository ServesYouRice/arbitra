# arbitra

## Claude web sessions: checks before push

- Dependencies and browsers for the full checks are installed by `.claude/hooks/session-start.sh` when a Claude web session starts.
- Run `.claude/hooks/check.sh` (in the background if slow) before every push and pull request.
- Pushes and pull requests are blocked until it has passed on the exact code being pushed.
- Never bypass, skip or weaken a check to get past the gate.
- If a check cannot run here, tell the user instead of working around it.
