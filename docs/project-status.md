# Project status

Updated September 28, 2026 against commit 1e5011d (branch `beta`).

arbitra is a beta runtime for model-backed Audit, Feature planning, Testing planning and
guarded Testing execution. These share the CLI/server orchestrator, canonical harness,
durable model activities and run budget. Every implementation item is done. What remains
in this phase is the P18 rerun on the premise evaluation's data, and the final review.
Live API-protocol, context-limit and batch validation is deferred to a later phase as the
[paid-API bundle](completion-plan.md#deferred-the-paid-api-bundle). Docker, Linux and browser acceptance are complete. Every public
workflow has now run live on subscriptions (Claude Code, Codex and the Antigravity CLI)
through the subscription CLI transports, and Gemini also ran natively and through its
OpenAI-compatible endpoint. The OpenAI and Anthropic API protocols have no live evidence,
because the owner tests only on subscriptions.

The [completion plan](completion-plan.md#status-september-27-2026) is the authoritative
queue and records each item's status. An implemented path is not automatically
live-validated: injected-provider tests establish orchestration behavior, not model
quality or a vendor capability guarantee.

## Implemented capabilities

| Area | Current behavior | Remaining boundary |
|---|---|---|
| Setup | Model-backed templates for every mode and all four protocols; [`setup.md`](setup.md); preflight diagnostics before any run or spend; unenforced `budgets` refused for model-backed runs | Live credentials and spend are the operator's |
| Providers and harness | Four wire protocols plus compatible endpoints; subscription CLI transports (Claude Code, Codex, Antigravity CLI, Gemini CLI for Code Assist accounts) selectable per role; canonical tool loop; bounded output repair; quota-aware error classes; durable attempts, usage, budgets and cancellation; output-limit detection; opt-in batch lane (OpenAI, Anthropic, Gemini); native Claude Code adapter for the Testing writer, on an API key, a token or the host subscription login | Subscription CLIs, Gemini and the native adapter live; OpenAI/Anthropic API protocols and batch drivers deferred to the [paid-API bundle](completion-plan.md#deferred-the-paid-api-bundle) |
| Audit | Independent discovery, review, verification, planning, criticism, revision; staged composition for oversized contexts; opt-in incremental reuse from a prior run; operator-authored saved graphs | Live three-vendor Audit found every seeded defect; a blocking plan question cannot be answered and resumed in Audit; oversized limits validated with scripted providers only |
| Feature | Requirements checkpoints, exploration, review, planning, revision and handoff; staged review/planning/critique; mode-specific replay; web contract view | Interactive mode passed live after an operator revision; requirements models can adopt an existing bug as the contract, which review and the checkpoint must catch |
| Testing | Risk analysis, gap selection, plans, guarded execution, bounded repair after final invalidation, bounded advisors, replay, web execution view | Generated tests are verified to pass, not to be right (a live test pinned a seeded defect) |
| Gates and checkpoints | Generic gate/human nodes with persisted, versioned decisions across CLI, HTTP, web and graph state | Shipped presets contain no such nodes; saved graphs use them |
| Persistence | Journals, content-addressed artifacts (published atomically), durable evaluation corpora, persistent trace index | Corpora have one writer per directory |
| Web | Graph view and editor, issue board, plan, evaluation, traces, Feature and Testing views; Playwright acceptance on three engines | Headless Linux arm64 and macOS only |

Audit and Feature export plans for a consuming implementation agent. Generalized
production-code implementation is outside the current [product scope](architecture.md#explicitly-out-of-scope).
Testing execution is opt-in and exports changes without applying them to the source
checkout.

## Recent implementation milestones

Dates below are commit dates in Europe/Belgrade; they describe delivered changes,
not the duration of each task.

| Date | Commits | Delivered |
|---|---|---|
| September 17 | 2a424fe, c501b36 | Provider-backed Audit composition, durable calls, canonical tools, typed peer operations and bounded source context |
| September 20 | 0696dad | Peer conflict follow-up, context/history and critic batching, revision and operational evaluation integration |
| September 21 | 4de07d2 | Trace browser, staged Audit planning/revision, sandbox verification adapter, Feature requirements/review/planning components |
| September 23, early | 8285e40 | Public Feature composition and revisions, Testing planning, write scheduling and isolated worktree/journal foundations |
| September 23, latest | 77149ef | Public Testing executor, model writers, durable retries, parallel dispatch, final checks, verified handoff and cleanup/recovery |
| September 24–25 | 391d3e4 … 64f887e (`beta`) | Completion-plan items P01, P02, P05, P07–P17 implemented; artifact publish race and ignored `budgets` fixed |
| September 26–27 | 65d7941 … b560162 (`beta`) | Subscription CLI transports (Claude Code, Codex, Antigravity CLI) as a product feature; native writer on the host subscription login; live handoff harness; 12 defects from the subscription runs fixed |
| September 27–28 | f2e9b1f … f1616f1 (`beta`) | Subscription live acceptance recorded (three-vendor Audit, interactive Feature, two plan handoffs); P12 completed with live failure paths; P06 version 2 prespecified and started |
| September 28 | cfc1cc8 … 1e5011d (`beta`) | Staged plan-revision patches and blocker-severity discovery findings repaired instead of failing a run or dropping a finding; paid-API bundle deferred out of this phase; P06 version 2.0.0 closed at run 2, version 2.1.0 prespecified and completed (insufficient evidence) |

## Verification evidence

- **CI:** commit f1616f1 passed `pnpm run ci` and `pnpm build` on GitHub Actions on both `ubuntu-latest` and `macos-latest`. The same suite also passed locally: on macOS 26 (arm64), and in a clean `node:22-bookworm` Linux container.
- **Docker:** the Docker boundary and the Testing repair cases ran against a real engine. See [`qa/p04`](qa/p04/README.md).
- **Browsers:** acceptance ran on Linux arm64 as well as macOS, 51/51 runs on each. See [`qa/p10`](qa/p10/README.md), [`qa/p10-linux`](qa/p10-linux/README.md) and [`qa/p16`](qa/p16/README.md).
- **Live providers:** Gemini native and the OpenAI-compatible chat protocol passed transport conformance ([`qa/p03`](qa/p03/README.md)). On subscriptions, every public workflow passed through the CLI, two exported Feature plans were accepted by fresh Claude Code executors, and a three-vendor Audit found every seeded defect ([`qa/p03-subscription`](qa/p03-subscription/README.md), [`qa/subscription-cli`](qa/subscription-cli/README.md)).
- **Native harness:** the Claude Code writer passed conformance against the real CLI on a subscription login. See [`qa/p12`](qa/p12/README.md).
- **Advisors:** the live advisor path is recorded in [`qa/p13-live`](qa/p13-live/README.md).
- **Batch drivers:** every driver was refused before a job was created. See [`qa/p15-live`](qa/p15-live/README.md).
- **Premise evaluation:** protocol 2.1.0 ran all 15 runs on three model families. One Claude Sonnet 5 run found 25 of 30 planted-defect chances; three pooled runs found all 10 defects, whether repeated Claude runs or three families. Every prespecified comparison was insufficient evidence ([`qa/p06-subscription`](qa/p06-subscription/README.md)).
- **Embedding decision:** recorded in [`qa/p18`](qa/p18/README.md).

The Gemini live runs found 13 runtime defects in provider classification, Gemini encoding, evidence grounding, output parsing and repair, planner and peer contracts, and writer loops. All are fixed with regressions and listed in [`qa/p03`](qa/p03/README.md), with one quality finding from human review (a generated test that pins a seeded defect). The subscription runs found 12 more, from a changed peer vote failing a run to a repair request reported as a prompt injection; they are listed in [`qa/p03-subscription`](qa/p03-subscription/README.md). Two further defects were exposed by the real Docker engine and one by Linux browsers; those are fixed too.

## Remaining work

See [WORK-REMAINING](../WORK-REMAINING.md) and the [status table](completion-plan.md#status-september-27-2026).
The API-protocol, context-limit and batch evidence needs funded provider accounts, which
the owner does not use for testing, so it is deferred out of this phase as the
[paid-API bundle](completion-plan.md#deferred-the-paid-api-bundle). The premise evaluation (P06) is complete: under protocol 2.1.0 on subscription models, every
comparison was insufficient evidence ([`qa/p06-subscription`](qa/p06-subscription/README.md)). Then the embedding decision is rerun on real-model findings (P18),
and the final review takes place (P19).

Earlier assessments are preserved in [historical notes](history/implementation-log-through-2026-09-23.md)
and the [pre-integration assessment](history/project-status-before-model-integration.md).
