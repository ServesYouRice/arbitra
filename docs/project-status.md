# Project status

Updated September 25, 2026 against commit 64f887e (branch `beta`).

arbitra is a beta runtime for model-backed Audit, Feature planning, Testing planning and
guarded Testing execution. These share the CLI/server orchestrator, canonical harness,
durable model activities and run budget. The implementation queue is largely done; what
remains is mostly acceptance that needs live providers, a Docker engine or a native
harness binary, plus a few explicit scale limits. Nothing here has run against a live
provider.

The [completion plan](completion-plan.md#status-september-25-2026) is the authoritative
queue and records each item's status. An implemented path is not automatically
live-validated: injected-provider tests establish orchestration behavior, not model
quality or a vendor capability guarantee.

## Implemented capabilities

| Area | Current behavior | Remaining boundary |
|---|---|---|
| Setup | Model-backed templates for every mode and all four protocols; [`setup.md`](setup.md); preflight diagnostics before any run or spend; unenforced `budgets` refused for model-backed runs | Live credentials and spend are the operator's |
| Providers and harness | Four wire protocols plus compatible endpoints; canonical tool loop; durable attempts, usage, budgets and cancellation; output-limit detection; opt-in batch lane (OpenAI, Anthropic, Gemini); native Claude Code adapter for the Testing writer | Live conformance for protocols, batch drivers and the native adapter; all declared-unverified |
| Audit | Independent discovery, review, verification, planning, criticism, revision; staged composition for oversized contexts; opt-in incremental reuse from a prior run; operator-authored saved graphs | Global planner outline and some per-item stages still fail explicitly when oversized |
| Feature | Requirements checkpoints, exploration, review, planning, revision and handoff; staged review/planning/critique; mode-specific replay; web contract view | Requirements generation and exploration are not yet staged |
| Testing | Risk analysis, gap selection, plans, guarded execution, bounded repair after final invalidation, bounded advisors, replay, web execution view | Real-sandbox acceptance; risk analysis is not staged |
| Gates and checkpoints | Generic gate/human nodes with persisted, versioned decisions across CLI, HTTP, web and graph state | Shipped presets contain no such nodes; saved graphs use them |
| Persistence | Journals, content-addressed artifacts (published atomically), durable evaluation corpora, persistent trace index | Corpora have one writer per directory |
| Web | Graph view and editor, issue board, plan, evaluation, traces, Feature and Testing views; Playwright acceptance on three engines | Browser runs recorded on macOS only |

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

## Verification evidence

On September 25, on macOS 26.6 (arm64) with Node 22.23.2, pnpm 10.24.0 and the frozen
lockfile, commit 64f887e passed `pnpm run ci` and `pnpm build` in one run:

| Suite | Result |
|---|---|
| runtime | 441 passed, 2 skipped (opt-in trace benchmark and native conformance) |
| providers | 79 passed, 7 skipped (credential-gated conformance) |
| security / workflow / core | 135 / 120 / 70 passed (core: 1 skipped) |
| web / CLI / server | 81 / 54 / 37 passed; server includes the real localhost HTTP integration |
| schemas / persistence / harness / testing | 58 / 52 / 28 / 25 passed |
| lint rules / examples / design check | 3 / 30 / 10 passed |

Browser acceptance: `pnpm --filter @arbitra/web e2e` passed all 51 runs — 14 operator
scenarios ([`qa/p10`](qa/p10/README.md)) and 3 editor scenarios ([`qa/p16`](qa/p16/README.md)),
each on Chromium 149, Firefox 151 and WebKit 26.5 on the same Mac. The trace index benchmark is in
[durability](durability.md).

The September 24 test-harness defects (unquoted glob, macOS path alias, five-second limits)
are fixed. Every package now fails when it discovers no tests. Linux has not yet run this
commit; the GitHub workflow will on push.

No live-provider call, Docker-backed run or native-binary run was performed. Every provider
batch driver and the native adapter are recorded as `declared_unverified`. The premise
flag helper still does not implement a live evaluation runner.

## Remaining work

See the [status table](completion-plan.md#status-september-25-2026) for per-item detail.

- **Needs provider credentials:** live-provider conformance and public workflow acceptance
  (P03), real-model premise evaluation (P06), a live advisor path (P13) and each batch driver (P15).
- **Needs a Docker engine:** Testing execution acceptance (P04) and real-sandbox repair (P07).
- **Needs a native harness binary:** Claude Code conformance (P12).
- **Needs another platform:** Linux CI and non-macOS browser runs (P01, P10).
- **Implementation still open:** oversized global planner outline, Feature requirements
  and exploration, and Testing risk analysis (P08); end-to-end protocol/scope replay (P11);
  an operator command for uncertain batch submissions (P15).
- **Decision and review:** the embedding decision after P06 (P18) and the final defect
  review with repeated live acceptance (P19).

Earlier assessments are preserved in [historical notes](history/implementation-log-through-2026-09-23.md)
and the [pre-integration assessment](history/project-status-before-model-integration.md).
