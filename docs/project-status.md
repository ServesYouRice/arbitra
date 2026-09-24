# Project status

Updated September 24, 2026 against commit 77149ef.

arbitra has an implemented alpha runtime for model-backed Audit, Feature planning,
Testing planning and guarded Testing execution. These paths share the CLI/server
orchestrator, canonical harness, durable model activities and run budget. Live-provider
and Docker acceptance validation, empirical audit evaluation, and the remaining
implementation work below are outstanding.

The [completion plan](completion-plan.md) is the authoritative queue. An implemented
path is not automatically live-validated; passing injected-provider tests establishes
orchestration behavior, not model quality or a vendor capability guarantee.

## Implemented capabilities

| Area | Current behavior | Remaining boundary |
|---|---|---|
| Providers and harness | Endpoint bindings for OpenAI Responses, OpenAI Chat, Anthropic Messages, Gemini Native and compatible endpoints; canonical tool loop; durable attempts, usage, budgets and cancellation | Live conformance evidence and native harness adapters are outstanding |
| Audit | Independent discovery, bounded review and conflict resolution, semantic escalation, verification, planning, independent criticism and bounded revision | Source-only security coverage remains degraded; individually oversized records and global contexts can fail explicitly |
| Feature | Requirements generation, durable approval/revision checkpoints, grounded exploration, independent review, planner/critic/revision and implementation handoff | Dedicated web controls, oversized-context composition and Feature-specific replay remain |
| Testing planning | Inventory, grounded risk analysis, complete gap selection, traceable plans and handoff | Oversized mandatory context remains limited; a plan does not establish that tests ran |
| Testing execution | Explicit write partitions, isolated worktrees, bounded parallel writers, retries, sandbox checks, final verification, exact change export and durable cleanup | Live-provider/Docker validation and automatic repair after final verification invalidates an earlier task remain |
| CLI/server | Shared run lifecycle, status, resume, Audit replay, artifacts, requirements commands/routes and SSE events | Generic graph checkpoint/gate composition and new replay semantics require further work |
| Web | Run graph, issue board, plan, evaluation and trace browser; run controls | Graph is read-only; Feature/Testing controls, expanded subgraphs and browser acceptance QA remain |
| Evaluation | Operational trace metrics and deterministic fixture-based premise scoring | Real-model quality measurements, persistent longitudinal corpora and embedding evaluation remain |

Audit and Feature export plans for a consuming implementation agent. Generalized
production-code implementation is outside the current [product scope](architecture.md#explicitly-out-of-scope).
Testing execution is opt-in and exports changes without applying them to the source
checkout. It needs configured model roles, concrete task/path authority and a locally
available digest-pinned Docker image containing the check dependencies.

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

## Verification evidence

The [GitHub CI run for 77149ef](https://github.com/ServesYouRice/arbitra/actions/runs/35918179891)
completed successfully on September 23. Local verification on September 24 used
Node 22.23.2, pnpm 10.24.0 and the frozen lockfile:

- Typecheck, lint and production build passed.
- Example/design validation passed all 26 tests; architecture lint-rule checks passed
  all three tests. CLI and web suites passed.
- The default runtime suite had 299 passing and 12 failing tests out of 311:
  11 five-second timeouts and one macOS path assertion. A serial targeted rerun with
  a 30-second timeout passed all 16 selected tests, including the 11 timeouts.
  This rerun does not make the unchanged default CI command pass on macOS.
- The path assertion at [orchestrator.test.ts](../packages/runtime/test/orchestrator.test.ts)
  compares a canonical /private/var path with its /var alias and still fails.
- The [testing package script](../packages/testing/package.json) expands an unquoted
  fixture glob into positional test filters and succeeds with no discovered tests.
  Quoting the glob in a direct invocation ran five files and passed all 22 tests.
- Server unit/route tests passed. Its real HTTP integration test was blocked by the
  local sandbox's localhost-listener restriction, then passed when allowed to bind.

These are recorded results, not a claim that all local CI checks pass unchanged.
[P01](completion-plan.md#p01--repair-test-discovery-and-platform-reliability) addresses
the remaining test-harness defects.

No live-provider call or Docker-backed acceptance run was performed for this review.
The existing environment-gated conformance test consumes an externally supplied report;
it does not itself invoke providers or authenticate the report. The premise flag helper
does not implement a live evaluation runner. The real-handoff script invokes an external
coding agent using a plan produced from scripted Audit responses. None of these alone
establishes live multi-model Audit correctness.

## Remaining work

The plan separates core validation and recovery work from the previously deferred
extensions. All are tracked; deferral is not a completion claim.

- Reliable CI, reproducible configuration, real-provider conformance and public-workflow
  acceptance, Docker acceptance, durable evaluation data and real-model premise evaluation.
- Final-invalidation repair, oversized-context handling, generic durable checkpoints and
  gates, Feature/Testing web controls, browser QA and Feature/Testing replay.
- Native harness adapters, bounded advisors, incremental/repeat audits, provider batching,
  a workflow canvas editor, trace indexing and an evidence-based embedding decision.
- A final defect review, cross-platform regression/build run and documentation reconciliation.

The old implementation plan was reported as 49 tasks complete. The original plan is
not present in this checkout, so that count has not been independently re-audited here.
It is not a completion measure for this queue. Earlier assessments and their original
unchecked lists are preserved in [historical notes](history/implementation-log-through-2026-09-23.md)
and the [pre-integration assessment](history/project-status-before-model-integration.md).
