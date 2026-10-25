# Architecture

This describes the system as built. [Verification evidence](qa/README.md) records dated
evidence; [remaining work](../WORK-REMAINING.md) tracks what is unfinished.

## Layering

### Composition boundary

The executable CLI/server composes scripted Audit and a bounded model Audit over the
selected source snapshot. Configured models require endpoint bindings and explicit
planner/verifier/critic roles in `workflow.modelExecution`; see
[`provider-model.md`](provider-model.md). Model Audit includes independent discovery,
bounded peer review, targeted verification, planning, critique and durable resume/replay.
Model calls use the canonical tool loop, pinned trusted protocols, layered prompts and
durable model traces. Feature runs also use the shared runner: a dynamic Feature subgraph
owns durable requirements, exploration, risk-directed review, planning and bounded revision.
Re-entering that subgraph after a checkpoint edit reuses only stages for the current
contract. A deterministic renderer publishes the implementation tree as a run artifact.
Testing runs compose deterministic inventory, grounded frontier risk analysis, complete
gap selection and a traceable test plan through the same runner and shared model budget.
Planning records repository-derived commands without executing them. Opt-in Testing
execution adds operator-authorized write partitions, isolated worktrees, bounded parallel
model writers, sandbox checks, final verification and durable change export. It leaves
the source checkout unchanged. Resume checks include test metadata; incomplete analysis
or execution evidence withholds the relevant handoff. Native harness mode is admitted only for
the Testing writer (see [harness.md](harness.md#native-harness-adapters)); Audit, Feature and
planning-only runs refuse it explicitly. Unknown presets produce `UNKNOWN_WORKFLOW_PRESET`.
Schema validation and saving a configuration do not imply that its execution mode is
available. This boundary is distinct from the planned v1.1 extensions.

Audit runs honor their selected repository and source scope. Durable context binds
resume/replay to the original source digest. Replay reuses source discovery artifacts in
a new run and recomputes downstream stages; it never overwrites its source run.

### Dependency direction

Dependencies point downward. Nothing below imports anything above it.

```text
apps/cli · apps/server · apps/web        interfaces
        │
packages/runtime                         composition: Orchestrator, model pipelines, sandbox, CLI/HTTP cores
        │
packages/core                            orchestration: runner, preflight, prompt, render, replay
        │
packages/workflow                        typed nodes: clustering, consensus, peer review, verification, planner
        │
packages/harness · packages/providers    model execution: canonical loop, transports, profiles
        │
packages/protocols · packages/tools · packages/security
        │
packages/persistence · packages/schemas  durable state and canonical types
```

`packages/testing` sits outside the stack: fixtures, scripted auditors, premise scoring and the
premise-evaluation driver, used by suites in every layer.

**The CLI and the UI call the same core.** `apps/server/src/routes/control-plane.ts`
delegates every lifecycle operation to a `ControlPlaneCore` port; `apps/cli/src/core.ts`
declares the same operations as `OrchestratorCore`. There is no second orchestration
implementation.

## The core loop

`packages/core/src/runner/workflow-runner.ts` executes a typed graph. Every node is one of
the six kinds in `packages/schemas/src/glyphs.ts` — the taxonomy is closed, and
`packages/workflow/src/node-kinds.ts` and `graph-schema.ts` enforce it.

The executable `audit-deep` graph ([`graphs.ts`](../packages/runtime/src/graphs.ts)) has eight
nodes; the other Audit stages run inside their executors (see [Audit mode](workflows.md#audit-mode)):

```text
■ preflight            snapshot summary; a model run resolves its protocol assets
◆ auditor A · B · C    independent discovery, isolated contexts, canonical harness
↻ consensus            validate findings, cluster, issue board, bounded peer review
▣ verification         ladder (live runs: rungs inconclusive), one model question last;
                       canonical issues with support count, review denominator, dissent, coverage
◆ planner              Validation Contract, Task DAG, capability routing
◆ critic               reads the plan against the issues it has to resolve
```

In a model run, the last of planner and critic renders the final plan as the run's
`implementation` artifact (`handoff` in `packages/runtime/src/model-pipeline.ts`).

Workflow code is deterministic by rule, not by convention:
`tooling/eslint-rules/no-workflow-nondeterminism.cjs` runs against
`packages/{core,workflow,persistence}/src` and fails the build on `Date.now()`,
`Math.random()` or direct network access outside an activity. Randomness is seeded from run
and activity identity by `packages/core/src/services/rng.ts`.

## Durability boundary

Everything that survives a crash lives in `packages/persistence`:

| Concern | Module |
|---|---|
| activity journal | `journal.ts`, `journal-load.ts` |
| fsync policy and durability classes | `fsync.ts` |
| content-addressed artifacts | `artifact-store.ts` |
| model activity traces | `trace.ts` |
| rebuildable query index | `index-db/rebuild.ts` |
| byte-stable serialisation | `canonical-json.ts` |
| guarded metric aggregation | `metrics/query.ts`, `metrics/queries.ts` |
| durable evaluation corpora, provenance and reports | `evaluation-corpus/` |

See [`durability.md`](durability.md).

## Interfaces

### CLI

`apps/cli/src/command-registry.ts` is the authority on what exists. Implemented:

```text
validate  estimate  run  audit  status  resume  replay  diff  trace  export  report
requirements  approve-requirements  revise-requirements  apply-requirements-revision
respond-checkpoint  batches  resolve-batch  workflow  incremental  apply-changes
```

`apps/cli/src/exit-policy.ts` is the sole mapping from outcome to process exit code:
`0` clear, `1` policy gate failed, `2` system failure, `3` suspended or blocked. An
unrecognised disposition fails closed at `2`. Every command can emit JSON with `--json`
(`apps/cli/src/output/json.ts`).

`validate` runs `Orchestrator.preflight` (`packages/runtime/src/preflight.ts`). It
reports configuration diagnostics, which fail validation with exit `1`, separately from
environment diagnostics: credential variables, subscription CLI install, version and login,
the native harness executable, placeholder model identities, and the local Docker engine and
image. `run`, `estimate` and the server's `POST /runs` apply the same configuration checks.
`run` and `POST /runs` also refuse environment errors before a run directory, snapshot or
provider request exists (exit `2`, reason `preflight_failed`; HTTP `400`). See the
[preflight reference](setup.md#preflight-reference).

`report` prints a run's summary and its gate, and redacts its output through
`redactSecrets` from `packages/security/src/redaction.ts`, failing closed with
`report_redaction_failed` if anything secret-shaped survives.

### Server

`apps/server/src/main.ts` builds the Fastify instance. Every request whose `Host` or `Origin`
is not a loopback address is refused with 403 (`NON_LOCAL_CONTROL_PLANE_REQUEST`), and an error
whose message contains a secret is answered with `HTTP_SECRET_EGRESS_BLOCKED` instead. The route
families in `apps/server/src/routes/` take their canonical schemas from
`packages/schemas/src/http-control-plane.ts`; a route with no schema entry throws
`MISSING_HTTP_SCHEMA` at registration rather than serving unvalidated input. Twenty-one
control-plane routes are listed in `apps/server/src/routes/inventory.ts`. The other families,
such as the two evaluation routes (`GET /runs/:id/metrics`, `POST /runs/compare`), register only
when the core provides them; `controlPlaneCore` (`packages/runtime/src/control-plane-core.ts`)
provides every family.

Four of the control-plane routes exist for the operator UI and read only what runs recorded.
`GET /runs` lists every run newest first: its state and the reason recorded with its latest
transition, mode, workflow, repository, whether models or scripted detectors executed it,
creation and last-event times (the modification times of its once-written `context.json` and
its append-only `events.jsonl`), whether this process is executing it, the operator
decisions it waits on, and, once it has completed, the same gate the CLI turns into an exit
code (`Orchestrator.gate`). A running state with `live: false` means another process (such as
the CLI) is executing the run or it was interrupted; no lock tells the two apart, so the UI
says so and leaves resuming to the operator. A run whose records cannot be read is listed
with the reason rather than dropped. An entry is recomputed only when the run's context,
event log, artifact index or liveness changes, and at most eight runs are read at once. `GET /runs/:id/overview`
adds the settings the run was created with from its stored context: scope, peer review policy
and rounds, critic, checkpoint mode, saved graph, and the configuration of a model-backed run.
`GET /repositories/selected` names the repository a run reads when it names none.
`POST /preflight` runs `Orchestrator.preflight` on an unsaved configuration and, when it is
valid, the estimate over the repository it would read; nothing is saved and no run exists
afterwards.

Five workflow routes (`GET /workflows`, `GET /workflows/:id`,
`GET /workflows/:id/versions/:version`, `POST /workflows/validate`, `POST /workflows`) list,
validate and save operator-authored graphs as immutable content-addressed versions. See
[Operator-authored graphs](workflows.md#operator-authored-graphs).

`POST /runs/:id/checkpoints/:checkpointId` records one versioned decision for a generic
`human` node through the orchestrator, or, for the reserved `plan-questions` checkpoint, one
set of answers to an interactive Audit plan's blocking questions. The server holds no
checkpoint state. See [Gates and human checkpoints](workflows.md#gates-and-human-checkpoints).

`GET /runs/:id/batches` lists a run's provider batch submissions, including uncertain ones
and their recorded evidence. `POST /runs/:id/batches/:submissionId/resolve` records one
versioned operator decision (`provider_job`, `not_submitted` or `abandon`) through the
orchestrator. The CLI equivalents are `batches` and `resolve-batch`. See
[Batch lane](provider-model.md#batch-lane).

Four requirements routes expose saved Feature contracts and versioned approval/revision
operations. See [Feature mode](workflows.md#feature-mode) for their payloads and CLI
equivalents. HTTP body validation preserves JSON types; pagination parameters are parsed
explicitly from query text.

Two read-only Testing routes expose the operator view of a Testing run.
`GET /runs/:id/testing` returns the run's stored configuration and write authority,
the plan next to the attempt ledgers, check results, final verification, repair lineage and
handoff availability. `GET /runs/:id/testing/change-set` returns the exact verified change set
named by `testing-execution-completion`. The completion hash and every file's content hash are
rechecked first. It returns 404 when no verified handoff exists and 409 for a non-Testing run
or changed evidence. Both schemas are in `testingOperatorViewSchema` and
`testingVerifiedChangeSetSchema` (`packages/schemas/src/testing-operator.ts`). Neither route
writes, dispatches or applies anything.

Three trace routes register when the trace store is wired: `GET /runs/:id/traces`,
`GET /runs/:id/traces/:traceId`, and
`GET /runs/:id/traces/:traceId/artifacts/:slot`. Lists support exact node/model/protocol/
outcome filters, activity substring search, and offset pagination (25 by default,
100 maximum). Trace IDs are positions in the committed append-only log; filtering
does not change them. Artifact slots (`input-0`, `input-1`, or `output`) resolve only
references attached to the selected attempt, with content-hash verification and the
same secret-egress guard. Historical outputs do not need a current named artifact entry.

There is no WebSocket surface. Run events stream over SSE (`apps/server/src/sse.ts`).
Every response of a route family in `apps/server/src/routes/`, and every SSE event, passes
`assertNoSecretEgress`, which fails the request rather than emitting a credential.

`apps/server/src/server-main.ts` is the process entrypoint (`serve.ts` calls it, and so does the
single-file app). It reads its settings from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `ARBITRA_HOST` | `127.0.0.1` | Bind address; anything other than `127.0.0.1` or `::1` is refused |
| `ARBITRA_PORT` | `4178` | Port, 1 to 65535 |
| `ARBITRA_REPOSITORY` | the working directory | Repository a run reads when it names none; run state goes in its `.runs/` |
| `ARBITRA_WEB_DIST` | `apps/web/dist` | Web build to serve if its `index.html` exists; empty serves none |
| `ARBITRA_BUILD` | the short Git commit, else `tooling/launch/build-id` | Build named in the diagnostics |

It also registers four routes directly. They have no schema entry and do not pass
`assertNoSecretEgress`; the loopback check and the error handler still apply.

- `GET /diagnostics/environment` returns the build and what `detectEnvironment`
  (`packages/runtime/src/environment.ts`) found: the subscription CLIs and which API keys are
  set, never their values. `?refresh=1` checks again.
- `GET /diagnostics/runs/:runId` returns a run's plain-text report
  (`packages/runtime/src/run-report.ts`); every line passes `redactSecrets`.
- `POST /handoff/runs/:runId` writes the run's plan into its repository as prompts under
  `.arbitra/plans/` (`packages/runtime/src/plan-export.ts`). Runs themselves never write there.
- `POST /repositories/pick` opens the operating system's folder dialog on this machine and
  returns the chosen path, or `null` when cancelled (`apps/server/src/folder-picker.ts`).

When the web build is served, `apps/server/src/web-app.ts` answers any GET no route matches with
a file from it, and refuses a path outside its root.

### Web

`apps/web` is four addressable places (see [Pages, not columns](DESIGN-LANGUAGE.md#pages-not-columns)),
routed from the query string by `apps/web/src/app/router.tsx` so a run, its tab and its
selected item are a link and the back button walks them:

- **Runs** (`pages/RunsPage.tsx`) lists `GET /runs`, newest first, and polls while a run is
  active. Blocked runs are counted first, because they do nothing until someone acts.
- **Run** (`pages/run/`) has a header with the state in words (its code is in How it ran's
  details and the report), the one lifecycle action the state allows and what executed the
  run; a Summary that watches a working run from `GET /runs/:id/progress` (stage, time per
  stage, parts read per finding model, issues found so far, tokens, calls restarted after a
  timeout) and leads a finished Audit with its plan to save; a decision banner above every
  tab while the run is blocked, holding the human-checkpoint decisions, one answer field per
  blocking question an interactive Audit's plan left open, a link to requirements awaiting
  approval, and the resume that follows them; the tabs the run's mode can fill; and one
  details panel for the selected
  node, issue, plan step, model attempt or artifact. The run's settings come from
  `GET /runs/:id/overview`, never from a configuration being edited elsewhere.
- **New run** (`pages/new-run/`) edits one configuration object, starting from a template
  (the scripted smoke test, or one of `examples/model-backed/`), a saved configuration, a past
  run's settings, an imported file, or a saved workflow graph. It lists every placeholder a
  template leaves, runs `POST /preflight` for the diagnostics and the estimate, and starts a
  run only after saving the configuration it runs from; the start button says which save
  that is.
- **Workflows** (`pages/WorkflowsPage.tsx`) hosts the graph editor (`graph/GraphEditor.tsx`),
  which edits operator-authored graphs and saves immutable versions the server validates;
  see [Operator-authored graphs](workflows.md#operator-authored-graphs). A saved version
  links to a new run that executes it. Unsaved edits guard every way out: in-app links, the
  back button and `beforeunload`.

The run tabs reuse the views: the Issue Board (`views/issue-board/`), one line per canonical
issue with its dissent on the row and its full record in the details panel; the Plan view
(`views/plan/`), with blocking questions and critic objections first and bidirectional
traceability in the details panel; the Feature contract (`views/feature/`); the Testing
execution record (`views/testing/`); and Evaluation (`views/evaluation/`). Activity
(`pages/run/ActivityTab.tsx`) holds the executed graph (`graph/GraphView.tsx`, ELK layout and
React Flow), the trace browser (`views/traces/`) and every persisted artifact. A compiled
prompt artifact is shown as what the model received: its provenance, then each prompt layer
at the byte boundaries the compiler recorded.

The trace browser shows full model/harness/protocol identity, requested/resolved effort,
measured usage, outcome, refusal/error details and redacted input/output artifacts. It
refreshes on run events or explicit request, keeps unknown measurements distinct from zero,
and treats artifact content as untrusted text. The Feature contract view shows the
requirements contract and pending high-impact defaults; the operator can approve, revise
the draft and apply a model revision proposal through the existing requirements routes.
Every mutation names the contract artifact it was made against. A stale artifact returns
409, and the view says so and offers a reload. Approval never resumes the run; the resume is
the banner's. The Testing execution view reads the Testing routes above. It shows authority,
the plan beside execution, attempts, check results and repair rounds. A no-work result is
labelled as no work, not as coverage. The operator can download the verified change set or
plan handoff as JSON. The graph expands Feature and Testing subgraph nodes into the stages
their run recorded (`graph/recorded-stages.ts`), drawn with the same six node kinds;
unrecorded stages are omitted rather than guessed.

Browser acceptance runs through `pnpm --filter @arbitra/web e2e` (Playwright, Chromium, Firefox
and WebKit). It is not part of `pnpm test`. The scenarios start the real control plane from
`apps/server/fixtures/e2e-server.ts` over a temporary state directory. Runs come from the real
orchestrator with scripted provider and sandbox ports (`apps/server/fixtures/scripted-runs.ts`).
Results and screenshots are recorded in [`qa/p10/`](qa/p10/README.md) and
[`qa/p10-linux/`](qa/p10-linux/README.md); see also [verification evidence](qa/README.md).

Trace list and detail responses are served from a persistent per-run index
(`packages/persistence/src/trace-index.ts`) that catches up incrementally from the
committed trace log and re-reads only the served records from it, so a page no longer
scans the whole log; the log stays authoritative and the index is rebuilt when stale or
corrupt. See [durability](durability.md#traces-and-the-rebuildable-index).

## Known gaps

The [completion plan](completion-plan.md) records dependencies, acceptance criteria and status;
[verification evidence](qa/README.md) records what ran, where and when:

- **Live evidence for the OpenAI and Anthropic API protocols (P03) is deferred** to the
  [paid-API bundle](completion-plan.md#deferred-the-paid-api-bundle). Every public workflow
  has run live on subscriptions. Injected-provider tests do not establish model quality; the
  real-model premise evaluation (P06) is summarised in
  [`evaluation.md`](evaluation.md#live-evaluation).
- Final Testing verification can reopen invalidated earlier work for bounded, durable repair
  under the original write grants (see [Testing mode](workflows.md#testing-mode)). The repair
  cases, including the critical ones, have run against real containers
  ([qa/p04](qa/p04/README.md)).
- Individually oversized records and Feature requirements revision, which still makes one
  call, can fail explicitly; see
  [context and output capacity](harness.md#context-and-output-capacity).
- Durable Feature requirements checkpoints and generic gate/human checkpoints work through
  CLI/HTTP and the web Feature contract view. Generic checkpoints apply to registered graphs;
  the shipped presets do not contain those nodes. Feature/Testing replay has
  mode-specific contracts through CLI/HTTP ([workflows](workflows.md#feature-and-testing-replay)).
- The trace browser and its persistent large-history query index are implemented, and the
  trace browser is covered by browser acceptance (see [`qa/p10/`](qa/p10/README.md)).
  Evaluation corpora are durable, and the P06 driver
  (`packages/testing/src/premise-evaluation/`) imports live observations into them.

## v1.1 extension points

These areas were originally grouped as v1.1 extensions. Their implementation status
now differs; all unfinished work is included in the completion plan.

| Deferred feature | Extension point |
|---|---|
| Autonomous Testing execution | Implemented through opt-in `testing-execute`: planning, authority preflight, parallel writers, serial checks, final verification, bounded repair and durable handoff. The web Testing view covers authority, attempts, checks and repair. Repair and Docker QA ran against real containers (P04/P07), and plan and execute ran live on subscriptions ([qa/p03-subscription](qa/p03-subscription/README.md)) |
| Native harness adapters | Claude Code headless adapter (`packages/harness/src/native/`) for the Testing writer only, status `conformance_verified`: tested against a scripted stand-in process and, live, against Claude Code 2.1.283 on a subscription login (P12, [qa/p12](qa/p12/README.md)). See [harness.md](harness.md#native-harness-adapters) |
| Advisor runtime | Implemented for Testing writers in `packages/runtime/src/model-advisors.ts`: operator-capped, durably journaled advisor uses with no tools, traced under the advisor identity. Exercised live on Gemini native and compatible chat (P13, [qa/p13-live](qa/p13-live/README.md)). See [`task-ir.md`](task-ir.md#advisors) |
| Feature workflow extensions | Requirements/review/planning/revision, web contract view, expanded subgraphs and mode-specific replay are implemented. Automatic and interactive Feature ran live on subscriptions ([qa/p03-subscription](qa/p03-subscription/README.md)); requirements revision still makes one call (P08) |
| Incremental / repeat audit execution | Opt-in incremental Audit in `packages/runtime/src/incremental-audit.ts`. It reuses byte-identical discovery units and identity-matched downstream stages from a completed base, with fallback, provenance and saved-work/coverage reporting. Tested with injected fake providers only; live-provider exercise remains. See [Incremental Audit](workflows.md#incremental-audit) |
| Provider batch API path | Opt-in batch lane and OpenAI/Anthropic/Gemini drivers in `packages/providers/src/batch/`, tested against injected HTTP; a live run was refused by every provider before job creation, so every driver is declared-unverified. Live validation needs a funded account and is deferred to the [paid-API bundle](completion-plan.md#deferred-the-paid-api-bundle) (P15). See [`provider-model.md`](provider-model.md#batch-lane) |
| Drag-and-drop workflow canvas editor | Implemented: `apps/web/src/graph/GraphEditor.tsx` edits operator-authored graphs; versions are content-addressed and validated server-side, and runs execute and resume the saved version. Audit mode only (P16) |
| Local embedding clustering | `packages/workflow/src/clustering/deterministic.ts` is the deterministic path; the recorded escalation metrics (`clustering/escalate.ts`) would have to justify replacing it. A local MiniLM candidate was evaluated offline on authored and P06 real-model findings and not adopted (P18, [qa/p18](qa/p18/README.md)) |

The data these rely on is recorded: the activity journal, the full model/harness/protocol/prompt
identity of every model trace and, for a model Audit, clustering escalation metrics and the
snapshot identity with its Git head.

## Explicitly out of scope

SaaS hosting, accounts, teams, cloud job queues, billing, PR creation, automated
deployment, generalized production-code implementation for Audit or Feature, learned model
routing, benchmark UI, marketplace, plugin ecosystem, model-generated dynamic workflows and
collaborative editing. None of these has an extension point, by design.
