# Project status

Updated September 25, 2026 against commit 0c6fb12 (branch `beta`).

arbitra is a beta runtime for model-backed Audit, Feature planning, Testing planning and
guarded Testing execution. These share the CLI/server orchestrator, canonical harness,
durable model activities and run budget. The implementation queue is done except the
premise evaluation. Docker, Linux and browser acceptance are complete. Live-provider
acceptance so far covers Gemini only, natively and through its OpenAI-compatible endpoint, because the
OpenAI and Anthropic accounts have no API credit and the Gemini key is free tier.

The [completion plan](completion-plan.md#status-september-25-2026) is the authoritative
queue and records each item's status. An implemented path is not automatically
live-validated: injected-provider tests establish orchestration behavior, not model
quality or a vendor capability guarantee.

## Implemented capabilities

| Area | Current behavior | Remaining boundary |
|---|---|---|
| Setup | Model-backed templates for every mode and all four protocols; [`setup.md`](setup.md); preflight diagnostics before any run or spend; unenforced `budgets` refused for model-backed runs | Live credentials and spend are the operator's |
| Providers and harness | Four wire protocols plus compatible endpoints; canonical tool loop; bounded output repair; quota-aware error classes; durable attempts, usage, budgets and cancellation; output-limit detection; opt-in batch lane (OpenAI, Anthropic, Gemini); native Claude Code adapter for the Testing writer | Gemini live; OpenAI/Anthropic protocols, batch drivers and native conformance need funded accounts |
| Audit | Independent discovery, review, verification, planning, criticism, revision; staged composition for oversized contexts; opt-in incremental reuse from a prior run; operator-authored saved graphs | Live Audit acceptance incomplete (quota); oversized limits validated with scripted providers only |
| Feature | Requirements checkpoints, exploration, review, planning, revision and handoff; staged review/planning/critique; mode-specific replay; web contract view | Interactive mode not yet run live |
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

## Verification evidence

- **CI:** commit 0c6fb12 passed `pnpm run ci` and `pnpm build` on GitHub Actions on both `ubuntu-latest` and `macos-latest`. The same suite also passed locally: on macOS 26 (arm64), and in a clean `node:22-bookworm` Linux container.
- **Docker:** the Docker boundary and the Testing repair cases ran against a real engine. See [`qa/p04`](qa/p04/README.md).
- **Browsers:** acceptance ran on Linux arm64 as well as macOS, 51/51 runs on each. See [`qa/p10`](qa/p10/README.md), [`qa/p10-linux`](qa/p10-linux/README.md) and [`qa/p16`](qa/p16/README.md).
- **Live providers:** Gemini native and the OpenAI-compatible chat protocol passed transport conformance. Testing plan, automatic Feature and Testing execute (live writer plus Docker) passed through the CLI; live Audit did not complete before the free-tier quota ran out. See [`qa/p03`](qa/p03/README.md).
- **Advisors:** the live advisor path is recorded in [`qa/p13-live`](qa/p13-live/README.md).
- **Batch drivers:** every driver was refused before a job was created. See [`qa/p15-live`](qa/p15-live/README.md).
- **Embedding decision:** recorded in [`qa/p18`](qa/p18/README.md).

The live runs found 14 runtime defects in provider classification, Gemini encoding, evidence grounding, output parsing and repair, planner and peer contracts, and writer loops. All are fixed with regressions and listed in [`qa/p03`](qa/p03/README.md). Two further defects were exposed by the real Docker engine and one by Linux browsers; those are fixed too.

## Remaining work

See [WORK-REMAINING](../WORK-REMAINING.md) and the [status table](completion-plan.md#status-september-25-2026).
The remaining acceptance items need funded provider accounts or the next free-tier quota
window. Then the embedding decision is rerun on real-model findings (P18), and the final
review takes place (P19).

Earlier assessments are preserved in [historical notes](history/implementation-log-through-2026-09-23.md)
and the [pre-integration assessment](history/project-status-before-model-integration.md).
