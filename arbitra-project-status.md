# Project status

Updated September 28, 2026. The maintained assessment is in
[docs/project-status.md](docs/project-status.md), and per-item status is in the
[completion plan](docs/completion-plan.md#status-september-27-2026).

arbitra is a beta:

- **Implemented:** the model-backed Audit, Feature and Testing workflows, the operator UI, the workflow editor, replay, incremental audits, the batch lane, advisors, a native Testing adapter, and subscription CLI transports (Claude Code, Codex, Antigravity CLI) selectable per role.
- **CI:** passes on Linux and macOS.
- **Acceptance complete:** Docker and browser.
- **Live providers:** every public workflow has run live on subscriptions, and Gemini also ran on its API. The OpenAI and Anthropic API protocols have no live evidence, because the owner tests only on subscriptions. That validation, with live batch drivers and context limits, is deferred to a later phase as the [paid-API bundle](docs/completion-plan.md#deferred-the-paid-api-bundle).

The linked documents keep live evidence separate from implemented capabilities.

The earlier assessment is preserved unchanged after an archival notice in
[the historical project status](docs/history/project-status-before-model-integration.md).
