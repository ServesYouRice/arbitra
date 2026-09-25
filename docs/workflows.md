# Workflows

One workflow engine, three modes. Audit, Feature and Testing are graphs over the same
runner and the same node kinds — there is no second engine, and adding one would be the
architectural failure the specification warns about most directly.

## The graph model

A workflow is JSON validated by `packages/workflow/src/graph-schema.ts`
(`WORKFLOW_SCHEMA_VERSION`, `validateWorkflow`, `parseWorkflow`, `serialiseWorkflow`).
Validation failures are `Diagnostic` values on a `WorkflowValidationError`, not thrown
strings, so a bad graph reports every problem at once.

`packages/core/src/runner/workflow-runner.ts` executes it, bounded by
`DEFAULT_CONCURRENCY_LIMIT` and resumable from the journal.

### Node kinds

The taxonomy is **closed** at six kinds. It lives in `packages/schemas/src/glyphs.ts` —
in `schemas`, deliberately, because a seventh kind is a specification change rather than a
UI change. `packages/workflow/src/node-kinds.ts` enforces it.

| Glyph | Kind | Meaning |
|---|---|---|
| ■ | `deterministic` | Application code. No model, no spend, no ambiguity. |
| ◆ | `model` | One model call or a bounded tool loop. The only place tokens are spent. |
| ◇ | `gate` | Deterministic branch. Decides whether more models are worth paying for. |
| ↻ | `loop` | Bounded iteration with an explicit maximum. Never open-ended. |
| ◫ | `human` | Checkpoint requiring an operator decision. |
| ▣ | `subgraph` | Composed, typed sub-workflow. Verification is one of these. |

The same table drives the CLI, the Markdown renderer and the graph view. `pnpm run
design:check` fails if a second copy appears anywhere.

### Edges carry contracts

`packages/workflow/src/edge-contracts.ts` types what crosses an edge: an `InputContract`,
a `PromptContract`, a `ContextContract` and an `OutputContract` with an explicit
`ValidationBehaviour`. An edge is not a wire — it is the declaration of what the next node
is allowed to see and what it must return.

### Context policy

`packages/workflow/src/context-policy.ts` declares `CONTEXT_MODES` and
`CONTEXT_TRUST_LEVELS` with a `DEFAULT_CONTEXT_POLICY`. This is what keeps discovery
independent: an auditor in independent mode does not receive another auditor's findings,
so agreement between them means something. Weakening a context policy to "help" a model is
how a multi-auditor run quietly becomes a single-auditor run with extra cost.

### Gates and human checkpoints

`packages/core/src/runner/graph-checkpoints.ts` gives every graph the same `gate` and
`human` executors, in Audit, Feature and Testing runs alike. Neither kind passes implicitly.
The shipped presets do not contain these nodes. Graphs registered through the
orchestrator's `graphs` option use them, and so do
[operator-authored graphs](#operator-authored-graphs).

A `gate` node names a deterministic policy in `config.policy`. The built-in `quality_gate`
evaluates the public quality-gate reasons over the artifacts written so far, without the
terminal-state requirement. A composition root can register more policies through
`gatePolicies`; it cannot replace a built-in. A missing policy fails with
`GATE_POLICY_REQUIRED:<node>`, and an unregistered one fails with `UNKNOWN_GATE_POLICY:<node>:<policy>`.
Every evaluation is published as `gate-evaluation-<node>`. A failed evaluation fails
the run before downstream nodes, and the public gate reports `gate_failed:<node>`.

A `human` node needs the run policy `workflow.checkpoints`:

```json
{ "checkpoints": { "mode": "interactive" } }
{ "checkpoints": { "mode": "automatic", "decisions": { "approval": "approve" } } }
```

- **Interactive.** The node persists a pending checkpoint and the run becomes `BLOCKED`.
  The checkpoint's `version` is a hash of the node definition and its inputs. Changed
  inputs create a new version, and earlier decisions no longer apply. The only
  decisions are `approve` and `reject`. The prompt is `config.prompt` or the node label.
- **Automatic.** The node never waits, and it never makes up an approval either. Every human node needs an
  explicit operator-authored decision in `decisions`. Otherwise the run is refused with
  `AUTOMATIC_CHECKPOINT_DECISION_REQUIRED:<node>`. Decisions are recorded as
  `decidedBy: "run_policy"`. Interactive policies cannot preconfigure decisions.

A human node without a policy fails with `CHECKPOINT_POLICY_REQUIRED:<node>`. An unknown mode fails
configuration validation. The same checks run in `estimate` and `start`, and on
resume/replay against the stored definition. They fail before a run is created. The policy is stored with the run
context when the run is created. Later edits to the saved configuration cannot change how
an existing run's checkpoints resolve.

Run status lists each dispatched human node as a `kind: "human"` checkpoint with
`checkpointId` (the node ID), `version`, `status` (`pending`, `approved` or `rejected`),
`prompt`, `decisions`, `mode` and `decidedBy`, plus the run's `checkpointMode`. Respond to the
current version through either interface:

```text
orchestrator respond-checkpoint <run-id> <checkpoint-id> <version> approve|reject
POST /runs/:id/checkpoints/:checkpointId   {"version": "<64 hex>", "decision": "approve"}
```

A response requires a blocked, idle run and an interactive policy. An unknown checkpoint
returns 404. A stale version, a second decision for the same version (from any process),
automatic mode or a non-blocked run returns 409. Deciding does not resume the run; call `resume`.
Approval completes the node. Rejection fails the run as a policy outcome: the public
gate reports `checkpoint_rejected:<node>`, and the CLI exits `1`, not `2`. Until an operator decides,
the public gate reports `checkpoint_pending:<node>`, and `run`/`resume`/`status` exit `3`.

### Operator-authored graphs

An operator can edit a graph and save it as a version, then run that version. The graph
uses the shared workflow schema (`packages/workflow/src/graph-schema.ts`), the six node kinds
and the edge and context contracts. It runs through the one shared runner with the Audit
executors. There is no second engine, and nothing generates a graph from a model.

**Versions.** `packages/persistence/src/workflow-graph-store.ts` stores each graph once in
a content-addressed artifact store. The version is the SHA-256 of the graph's canonical JSON.
Each version record holds the parent version, the save time from an injected clock, and the
authorizations the graph needed. It is created once and cannot be replaced. Every read
re-checks the record and the body's content address. Saving an identical graph again returns
the existing version. State lives under `<state>/workflows/`.

**Validation.** The server's validator (`packages/runtime/src/authored-graphs.ts`) decides
every check. Each diagnostic has a stable code and a path:

| Check | Codes |
|---|---|
| Schema, the six kinds, edge and context contract shapes | `SCHEMA`, `INVALID_GRAPH_ID`, `INVALID_NODE_ID` |
| Edges and reachability (`packages/workflow/src/graph-structure.ts`) | `SELF_LOOP`, `DUPLICATE_EDGE`, `EDGE_INTO_ENTRY`, `UNREACHABLE_NODE`, `CONTEXT_TRUST_ESCALATION` (model output carried as system-trusted context) |
| Bounded loops | `UNBOUNDED_CYCLE` rejects any edge cycle, because iteration must be a `loop` node with an explicit `maximum`. `LOOP_BOUND_EXCEEDED` rejects a maximum above 3. At run time, the loop's maximum caps the configuration's consensus rounds. |
| Audit stage contracts | `ENTRY_NOT_DETERMINISTIC`, `UNSUPPORTED_NODE`, `UNKNOWN_MODEL_ROLE` (model nodes are `auditor-<name>`, `planner` or `critic`), `AUDITOR_REQUIRED`, `CONSENSUS_LOOP_REQUIRED`, `VERIFICATION_SUBGRAPH_REQUIRED`, `EDGE_CONTRACT_UNSATISFIED` (each auditor must be upstream of consensus, then verification, then the planner, then the critic) |
| Gates and human checkpoints (P09) | `GATE_POLICY_REQUIRED`, `UNKNOWN_GATE_POLICY`, and, against a configuration, `CHECKPOINT_POLICY_REQUIRED`, `AUTOMATIC_CHECKPOINT_DECISION_REQUIRED`, `UNKNOWN_CHECKPOINT_NODE` |
| Model roles, against a configuration | `MODEL_ROLE_UNAVAILABLE`: an auditor with no profile (or, with no models configured, no scripted auditor), or a planner or critic role not bound in `workflow.modelExecution.roles` |
| Privileged changes | `UNAUTHORIZED_CHANGE` |

Some changes are privileged: control-plane protocol sources (non-empty
`prompt.protocolLayers`, or `protocol*` / `controlPlane` keys in a node's config), write
authority (`write*`, `authorization`, `apply*` keys), Testing execution (a node named
`execute`, or `testing`, `execution` or `sandbox` keys), and reusing a shipped preset ID.
Each category needs its own explicit authorization (`authorize: ["write_authority", …]`).
Without one, the change is rejected. The record keeps only the authorizations the graph uses.
An authorization lets a graph be saved and dispatched. It never gives a run authority it does
not already have: the Audit executors ignore these keys, and write authority still comes
only from a Testing configuration's own execution authorization.

**Dispatch.** A run configuration names one exact version:

```json
{ "mode": "audit", "workflow": { "graph": { "id": "reviewed-audit", "version": "<64 hex>" }, "checkpoints": { "mode": "interactive" } } }
```

`workflow.graph` requires audit mode and cannot be combined with `workflow.preset`. It never
means "latest". `estimate` and `start` load the version and validate it again against the
run's configuration, before any run exists. Failures are preflight configuration
diagnostics (HTTP 400, also listed by `preflight`): `WORKFLOW_GRAPH_VERSION_ABSENT` or
`WORKFLOW_GRAPH_ID_MISMATCH` at `workflow.graph`, or each validator code at
`workflow.graph(<id>).<path>`. The run context records `workflowGraph`
(`id`, `version`). The runner's stored definition is the saved graph itself. Resume and Audit
replay re-check that the definition's content address equals the recorded version and that
the version still exists (`RUN_WORKFLOW_GRAPH_MISMATCH`, `WORKFLOW_GRAPH_VERSION_ABSENT`).
A later version of the same graph never changes an existing run. A replay cannot toggle the
critic on a saved graph (`REPLAY_SAVED_GRAPH_IMMUTABLE`). Run status reports
`workflowGraph: { id, version, executedVersion }`.

**Interfaces.**

```text
GET  /workflows                              saved graphs by ID, plus an editable template of each Audit preset
GET  /workflows/:id                          the versions of one graph
GET  /workflows/:id/versions/:version        one immutable version
POST /workflows/validate  {"graph", "configurationId"?, "authorize"?}   diagnostics; writes nothing
POST /workflows           {"graph", "parentVersion"?, "configurationId"?, "authorize"?}

orchestrator workflow list | show <id> [version]
orchestrator workflow validate <graph.json> [--configuration=<id>] [--authorize=<category,...>]
orchestrator workflow save <graph.json> [--parent=<version>] [--configuration=<id>] [--authorize=<category,...>]
```

In the web app, the graph column has two modes: a read-only run view and an editor. The
editor starts from a preset template or a saved version. You can add, remove and connect
nodes of the six kinds, and the inspector edits each node and edge. It shows the server's
diagnostics as you edit, checked against the selected configuration. Undo and redo cover
every edit, and saving creates a new version. Unsaved changes are marked. Leaving the editor,
switching views, opening another graph or unloading the page asks first. Every operation
works from the keyboard. The shortcuts are Ctrl/⌘+Z to undo, Ctrl/⌘+Shift+Z or Ctrl+Y to
redo, Ctrl/⌘+S to save, and Delete to remove the selected node or edge. After a save, the
editor shows the exact `workflow.graph` reference for a run configuration. A run's graph view
shows the saved version it executes, and whether the executed graph matches it. Browser
evidence is in [`docs/qa/p16/`](qa/p16/README.md).

## Audit mode

```text
■ preflight ─ ◇ complexity router ─┬─ ◆ auditor A ─┐
                                   ├─ ◆ auditor B ─┼─ ■ validate ─ ■ cluster ─ ■ issue board
                                   └─ ◆ auditor C ─┘
   ─ ◆ peer review (↻ bounded) ─ ◇ converged? ─ ▣ verification ─ ■ canonical issues
   ─ ◆ planner ─ ◇ critic required? ─ ◆ critic ─ ■ renderer
```

**Routing.** `packages/core/src/preflight/complexity-gate.ts` recommends an
`OrchestrationIntensity` from repository signals, and
`packages/core/src/routing/difficulty.ts` scores tasks across `DIFFICULTY_DIMENSIONS`. The
router is deterministic: it decides whether more models are worth paying for, and records
why.

**Depth.** `packages/workflow/src/nodes/discovery/depth.ts` allocates auditor scopes for
`fast`, `balanced` and `deep` (`allocateDiscoveryScopes`), including hotspot-weighted
coverage.

**Validation before opinion.** `packages/workflow/src/nodes/validate-findings.ts` rejects a
finding whose evidence range does not exist in the snapshot, before any model is asked
about it. A model cannot argue a finding into existence.

**Clustering.** `packages/workflow/src/clustering/deterministic.ts` clusters findings
deterministically; `clustering/escalate.ts` records escalated pairs
(`SemanticClusteringDecision`, `recordSplit`) so the cost of a semantic path — if §25.4
metrics ever justify one — is measured rather than assumed.

**Issue board.** `packages/core/src/issue-board/operations.ts` and `projection.ts` build the
board from an append-only operation log (`packages/persistence/src/issue-ops.ts`). The
board is a projection; the log is the truth.

**Consensus.** `packages/workflow/src/consensus/engine.ts` runs bounded rounds under a
`ConsensusPolicy` (`full`, `risk_weighted`, `minimal`; `DEFAULT_CONSENSUS_POLICY`).
Converged issues stop early; disputed issues go another round, to a maximum of three.
Dissent is retained, never discarded — a 2–1 result keeps the losing evidence and its
review denominator.

**Verification.** `packages/workflow/src/nodes/verification/` is a `subgraph`. Its ladder
(`ladder.ts`) tries deterministic methods first — cited lines, symbol or call path, route
and middleware config, dependency path, an allowlisted safe test, a bounded deterministic
check — and only then asks a single model question (`engine.ts`). A high-risk, evidence-
backed, location-citing objection escalates an issue here rather than being outvoted. The
number of disputes verification resolves is reported, because that number is what says
whether the stage was worth building.

**Canonical issues.** `packages/workflow/src/nodes/canonical-issues.ts` emits support
count, review denominator, dissent, counter-evidence, coverage, minority findings,
suppression candidates, unexamined surfaces and recorded limitations.

**Planner and critic.** `packages/workflow/src/nodes/planner/` produces the Validation
Contract, Task DAG and capability routing (see [`task-ir.md`](task-ir.md)).
`nodes/critic/selection.ts` picks a critic at or above the planner's capability tier and
records `kind: "skipped"` with `reason: "no_available_critic_at_or_above_planner_capability"`
when none qualifies — a skipped critic is a recorded degradation, not a silent absence.
`nodes/revision.ts` revises only on blocking critique.

## Feature mode

The shared CLI/server runtime dispatches configured Feature runs. Use `mode: "feature"`,
the `feature-simple` preset, provider bindings in `workflow.modelExecution`, and explicit
Feature settings:

```json
{
  "preset": "feature-simple",
  "feature": {
    "request": "Add session preferences while preserving existing sessions",
    "mode": "interactive",
    "maximumRequirementsRevisions": 1,
    "roles": {
      "requirements": "requirements-profile",
      "exploration": "exploration-profile",
      "planner": "planner-profile",
      "reviewers": ["reviewer-a", "reviewer-b"],
      "critic": "critic-profile"
    }
  }
}
```

These profile IDs must exist in `models` and have endpoint bindings. Reviewers need
distinct independence groups; the critic must be independent of the planner. Low-risk
Features skip targeted review and criticism, so reviewers and critic may be omitted for
that path. If exploration requires review, missing profiles fail explicitly.

Interactive high-impact defaults pause the run in `BLOCKED`. Inspect, revise, approve
and resume through the CLI:

```text
orchestrator run feature-config.json
orchestrator requirements <run-id>
orchestrator revise-requirements <run-id> <artifact-id> draft.json
orchestrator approve-requirements <run-id> <current-artifact-id> <ambiguity-id>...
orchestrator resume <run-id>
```

The localhost API exposes `GET /runs/:id/requirements`,
`POST /runs/:id/requirements/approve` (`artifactId`, `ambiguityIds`) and
`POST /runs/:id/requirements/revise` (`artifactId`, `draft`). Mutations require a
blocked run and the current artifact ID; stale versions return HTTP 409. An edit clears
interactive approvals. Approval does not resume execution automatically. Unresolved
requirements review also blocks, allowing an operator draft revision followed by fresh
exploration/review. Automatic mode records defaults without operator checkpoints but
does not override disputed review.

`maximumRequirementsRevisions` defaults to one proposal per run and accepts 0–3; zero
keeps operator-only revision. A complete independent review with unresolved requirements
can trigger a proposal from the configured requirements model. Proposals retain explicit
lineage, acceptance responsibility, scope exclusions and high-impact ambiguity coverage.
Review limitations block proposal generation. The durable reservation counts across
restarts and checkpoint changes, so repeated resume cannot reset the limit.

In automatic mode a validated proposal becomes a new contract, then fresh exploration
and independent review check it. In interactive mode it remains separate from the approved
contract. `requirements <run-id>` exposes `revisionProposal`; select it with
`apply-requirements-revision <run-id> <proposal-artifact-id>` or
`POST /runs/:id/requirements/apply-revision` with `artifactId`. Application clears prior
approvals, so inspect and approve the new high-impact defaults before resuming. Re-review
receives immutable original feedback and the model's resolution claims, and remains
mandatory after model revision even if the new risk score is lower. Continuing disagreement
at the revision limit remains `BLOCKED` and permits an operator draft revision.

Successful plans publish an `implementation` artifact containing the rendered file tree,
including `manifest.json`, requirements, tasks and validation. Export it through the
existing artifact/JSON export interfaces. Source files are not modified; command policy
and write authority still need resolution in the consuming executor. Blocking questions,
critic feedback or exploration limitations fail the gate and withhold that handoff.
All model stages share one harness, provider scheduler and durable budget within the run.

Same engine. `packages/workflow/src/nodes/requirements/` produces a durable Requirements
Contract and routes by ambiguity and repository risk (`routing.ts`), preserving assumption
and acceptance traceability into planning.

The runtime library has durable requirements checkpoints, grounded exploration and
targeted independent requirements review with up to three rounds. Draft revisions
invalidate operator approvals and downstream review identities. The web Feature contract
view offers the same inspect, approve, revise, apply-proposal and resume operations through
these routes (see [Web](architecture.md#web)). Feature uses the runner's subgraph primitive.
The graph view expands it into the stages its artifacts record; full stage detail stays in
artifacts and traces. Audit-policy replay is rejected for Feature runs; Feature
replay has its own contract (see [Feature and Testing replay](#feature-and-testing-replay)).
Ordinary durable resume is supported.

`packages/runtime/src/model-feature-planning.ts` composes the selected planner with an
independent critic and at most one revision/re-review. Only a complete, non-degraded
critique with blocking items triggers revision. Revisions must preserve requirement
traceability, premise provenance and existing unresolved questions, and provide exactly
one resolution claim per blocking item. The independent re-review receives the original
plan, critique and claims; remaining blockers, rejected mappings and blocking plan
questions prevent a passing result. Completed model activities are reused on restart,
including when the revised plan is unchanged. Oversized mandatory review, planning,
critique and revision contexts use staged composition over complete requirement records;
see [context and output capacity](harness.md#context-and-output-capacity) for the
remaining explicit limits.

## Testing mode

The shared CLI/server runtime supports plan-only Testing. Configure `mode: "testing"`,
the canonical harness, model endpoint bindings in `workflow.modelExecution`, and:

```json
{
  "preset": "testing-plan",
  "testing": {
    "mode": "plan",
    "goal": "Protect authorization and session behavior against regressions",
    "roles": { "analyst": "gap-analyst", "planner": "planner" },
    "commands": []
  }
}
```

The analyst must have frontier capability. Deterministic inventory includes test files
and supported manifests within the selected source scope. Risk surfaces require exact
source evidence; every candidate must be selected or explicitly rejected with a reason.
A test category elsewhere in the repository does not establish coverage of a surface.
Unreviewed source/test paths and model-reported limitations fail the planning gate.

Package `test` and `test:*` scripts provide command candidates. For other frameworks,
`commands` accepts `{command, evidence: {path, startLine, endLine, text}}`; the exact
repository line range must contain that command alone. Explicit evidence paths are
included only within the selected scope. Custom commands retain `requires_approval`;
derived package scripts record their origin without granting execution permission.
Missing commands with selected gaps prevent planning. Resume rejects source or command
metadata changes. Oversized gap selection and planning contexts are composed in bounded
durable stages; see [context and output capacity](harness.md#context-and-output-capacity).

The planner links every selected gap to tasks and validation assertions. Concrete write
paths must classify as tests or test configuration; production-file paths and invented
commands are rejected. Successful nonempty plans publish the implementation tree under
run artifacts. An analysis selecting no gaps publishes an explicit no-work outcome;
it is not proof of test coverage. Blocking questions withhold the handoff.

All stages share the durable model budget and resume machinery. In plan mode commands
are never run, the source tree stays unchanged, and the planning result records `testsExecuted: false`.
Audit-policy replay is rejected for Testing runs; Testing replay has its own contract (see
[Feature and Testing replay](#feature-and-testing-replay)). The web Testing execution view reviews the
stored authority, plan versus execution, attempts, checks, repair and the verified change set
through `GET /runs/:id/testing` and `GET /runs/:id/testing/change-set`. The graph view
expands both Testing subgraphs into their recorded stages.
Guarded execution is opt-in: use `workflow.preset: "testing-execute"` (or omit the preset),
set `workflow.testing.mode: "execute"`, and supply `workflow.testing.execution` with:

- `authorization`: concrete `partitions: [{id, paths}]`, exact `tasks: [{taskId, partitionId, exclusive}]`, and `maximumParallelTasks` from 1–16. Disjoint ready tasks can write concurrently; dependencies, shared files, declared conflicts and exclusive tasks constrain batches.
- `models`: `fast`, `balanced`, and `frontier` profile IDs, each tool-capable and meeting its capability tier.
- `maximumAttempts`: 1–10, preserved across restart.
- `maximumRepairRounds` (optional): 0–5 repair rounds after final verification, default 3; `0` disables repair.
- `verification`: `execution` containing a local digest-pinned Docker image, a bounded `maximumRuns`, and `checks: [{id, executable, arguments, sourcePaths}]`; plus `bindings: [{command, checkId, expectedExitCode, authorization}]`. Binding authorization is `repository_script`, `allowlisted`, or `operator_approved` and must match each planned command's policy.

Write grants are operator authority, not model output. Every planned task and path must
match the grants before any worktree is created. Sandbox checks use a read-only copy of
the current worktree with no network; provide an already available image containing its
test dependencies. The runtime does not install dependencies or pull images. The model
receives leased file tools, not shell access. Source checkout files remain unchanged.

The summary keeps `outcome` for planning and adds `execution` for actual task/final-check
results. Passing execution requires a `testing-execution-completion` artifact referencing
an exact `testing-change-set-*` artifact. Retrieve it through the existing artifact API, or from `GET /runs/:id/testing/change-set`, which rechecks the completion and content hashes first.
Each changed file contains `expectedHash`, `contentHash` and UTF-8 `content`; an applying
tool must compare the destination bytes with `expectedHash` before replacing them.
Successful finalization cleans up its worktree and replays without new model/check calls.
Failed checks, incomplete evidence or missing handoff fail the public gate. No selected
gaps remains an explicit no-work result, not evidence that tests ran or coverage is complete.

Each writer batch settles before serial verification begins. Interrupted batches preserve
completed tool work and release leases only after every dispatched writer stops.

A later task can break an earlier task's passing check. If final verification finds
deterministic failures, the coordinator can reopen tasks for repair. It computes the
dependency/conflict closure of the failing tasks. The failing tasks are reopened. Other
tasks are reopened if they declared a conflict with a failing task or wrote a file in
its write scope or check sources, such as a shared fixture. Downstream dependents and
tasks sharing its scope are marked stale. The coordinator invalidates the reopened tasks'
passing attempts before any new writer is dispatched. Then the normal schedule runs again.
Reopened tasks receive the failing final evidence as feedback. They use their original write
grant, lease, attempt ledger and task check. Completed tasks are not rerun. The workspace
is then verified again in full. Repair never widens a write grant or adds scope.
Stale per-task and final evidence cannot complete a task or be exported.

Repair is bounded. Reopening consumes the task's `maximumAttempts`. Model tokens and
sandbox `maximumRuns` remain shared by the whole run. `maximumRepairRounds` limits the number
of reopen decisions. Each round is recorded in the durable `testing-repair-lineage` artifact
with its invalidated snapshot, failures, and reopened and stale tasks. The execution outcome's
`repair` field reports these rounds. Restart finishes a committed reopen and resumes an
interrupted repair attempt without repeating completed writes. It returns the recorded
terminal decision without new model or sandbox calls. The run blocks without a handoff for
exhausted rounds (`repair_rounds_exhausted`) or exhausted attempts (`repair_attempts_exhausted`
or `task_attempts_exhausted`). It also blocks when the workspace returns to invalidated bytes
(`repair_oscillation`). Incomplete final checks, including exhausted sandbox budgets, also block;
they are not repaired. Cancellation stops the run, and a later resume can continue it. Only
the exact final bytes that pass fresh verification are exported. Repair is covered with
injected sandbox/provider ports. Its real-Docker repetition is still outstanding.
Native harness execution and live-provider/Docker acceptance QA remain open.
The [completion plan](completion-plan.md) also tracks oversized contexts and the remaining extensions.

## Feature and Testing replay

Replay creates a **new run** from a saved source run; it never continues or modifies the
source. Continuing an interrupted run is `resume`, which keeps the run's own identity,
journal and contract. Each mode has its own replay contract
([`replay-contracts.ts`](../packages/runtime/src/replay-contracts.ts)). Audit replay keeps
its existing meaning: reuse round-zero discovery under new consensus policy
(`replay <run-id> --consensus-policy …`). Audit policy overrides are rejected for Feature
and Testing runs.

A Feature or Testing replay request names its mode and may replace the saved
configuration with one of the same mode:

```json
{ "mode": "feature", "configuration": { "...": "optional, same mode" },
  "requirements": { "decision": "reuse_approved", "artifactId": "requirements-contract-version-…" } }
{ "mode": "testing", "execution": { "mode": "plan" } }
{ "mode": "testing", "execution": { "mode": "execute", "authorization": { "maximumParallelTasks": 1,
  "partitions": [{ "id": "tests", "paths": ["test/session.test.ts"] }], "tasks": [{ "taskId": "TASK-001", "partitionId": "tests", "exclusive": false }] } } }
```

Submit it with `replay <run-id> --request <file.json>` or `POST /runs/:id/replay`. Both
call the same orchestrator. The route returns once the new run exists, with its stage
decisions, and the run then streams on its own events. `GET /runs/:id/replay` and the
run summary's `replay` field report provenance. A request whose mode differs from the
source run fails with `REPLAY_MODE_MISMATCH` (HTTP 409). Malformed requests fail with
`INVALID_REPLAY_REQUEST` (400). No run is created for either.

**Stages.** Feature has five stages: `requirements`, `exploration`, `review`,
`requirements-revision` and `planning`. Testing has three: `analysis`, `planning` and,
in execute mode, `execution`. Each stage owns the model activities whose IDs it matches.
Its identity binds several components:

- the repository snapshot digest and scope;
- the harness;
- its own settings: the Feature request and requirements mode, the complete Testing
  settings for analysis, and the write authorization for planning;
- the model profiles and endpoints of its roles, plus the output limit;
- the pinned protocol versions and hashes, and prompt overrides;
- the identity of the preceding stage.

The replay computes both runs' identities before creating the new run. It stores the
decisions in the new run's immutable `replay-contract` artifact. A stage is reused only
when every component is equal; otherwise the decision names each changed component
(`changed:models`, `changed:upstream`, and so on). Protocol bytes are pinned into the new
run before it starts. A protocol the source never pinned cannot have produced a source
output, so it does not invalidate the stage; the decision lists it as
`sourceUnpinnedProtocols`. A source whose pinned copy is missing or corrupt is treated
the same way and listed there too; its outputs are still reused only under the
per-activity check below, which includes the protocol hash they were produced under.

Within a reused stage each activity is also checked on its own. Its saved output must
carry a replay identity equal to the new request's. That identity covers the full
messages, the model profile and endpoint, the protocol, the harness policy, tools and
source paths; budgets, retries, rate limits and the batch lane are excluded. Reused
outputs are published in the new run with `replayedFrom` provenance naming the source
artifact. They make no provider call and consume none of the new run's token budget.
Every other activity is regenerated and charged to the new run. Each lookup is recorded
as `replay-activity-<key>` with `reused` or a reason:

- `stage_invalidated`
- `source_activity_absent`
- `source_artifact_unreadable` (missing or corrupt, detected by content hash)
- `source_activity_identity_unavailable` (saved before replay identities existed)
- `activity_identity_changed`
- `source_output_invalid`

Missing or corrupt source artifacts are never trusted. They force regeneration.

**Requirements.** By default (`reapprove`) a Feature replay derives its requirements
again. It reuses a compatible saved draft, but interactive high-impact defaults need a
fresh approval in the new run. `reuse_approved` must name the source's *current*,
fully approved contract. The replay then copies that contract, its lineage and any
revision ledger into the new run and verifies that the copy resolves to the same version.
The request fails with HTTP 409 in these cases:

- `REPLAY_REQUIREMENTS_CONTRACT_STALE`: a superseded version is named;
- `REPLAY_REQUIREMENTS_NOT_APPROVED`: approvals are pending;
- `REPLAY_REQUIREMENTS_CONTRACT_INCOMPATIBLE`: the requirements stage, request, source or
  model changed;
- `REPLAY_REQUIREMENTS_ARTIFACT_MISSING`: a contract artifact is missing.

**Testing execution.** A Testing replay must choose its execution. A `plan` replay drops
the execution settings. Its graph has no execute node, and it holds no sandbox, so it
cannot dispatch writers or checks. An `execute` replay is a new, explicitly authorized
execution. Its write grant comes only from the request, never from the source run or a
supplied configuration. The contract records the grant's digest with authority
`replay_request`. Execution is never reused. The run gets its own worktree, and writers
and checks run again, so its change set and completion rest on fresh evidence. A source
run in plan mode has no execution settings to reuse. An `execute` replay of it needs a
`configuration` that supplies them; otherwise it fails with
`REPLAY_EXECUTION_CONFIGURATION_REQUIRED`. Testing analysis activities are keyed by the
complete Testing settings, so changing the write grant also regenerates analysis and
planning.

Resuming a replay run uses its stored contract and never re-decides reuse from the
current configuration. A replay run whose contract is missing, corrupt or names another
source or mode is not resumed or reported (`REPLAY_CONTRACT_ABSENT`,
`REPLAY_CONTRACT_UNREADABLE`, `REPLAY_CONTRACT_MISMATCH`; HTTP 409).

Coverage runs through the public orchestrator, and through both the CLI request port and
HTTP for parity, with injected fake providers and sandboxes
([`model-replay.test.ts`](../packages/runtime/test/model-replay.test.ts),
[`replay-end-to-end.test.ts`](../packages/runtime/test/replay-end-to-end.test.ts),
[server `replay.test.ts`](../apps/server/test/replay.test.ts)). It includes full reuse;
changed models, wire protocols (endpoint transport), protocol prompts, scope, source,
requests, write grants and verification; stale and unapproved requirements contracts;
missing and corrupt source outputs, protocol pins and replay contracts; failed Feature
and Testing execution replays resumed as the same run; fresh worktrees and checks for
every execution replay; byte-level source immutability; and matching Feature and Testing
decisions over the CLI port and HTTP. Replay under live providers and real Docker has not
been exercised.

## Incremental Audit

An incremental Audit is a **new** model-backed Audit of the current snapshot that may reuse
work from a completed earlier Audit, its *base*. Replay reuses work for the same snapshot.
An incremental run reuses work from a base that audited a changed snapshot. It is off by
default and is always requested explicitly:

```text
orchestrator run audit.json --incremental <base-run-id>
POST /runs   {"configurationId": "…", "incremental": {"baseRunId": "<base-run-id>"}}
workflow.incremental: {"baseRunId": "<base-run-id>"}      (in the saved configuration)
```

The CLI flag and the HTTP field override the saved configuration's value. The request
becomes part of the run's stored configuration. `orchestrator incremental <run-id>`,
`GET /runs/:id/incremental` and the run summary's `incremental` field report the outcome.
`scope.exclude` (repository-relative path prefixes) removes paths from the snapshot for
any scope kind.

**Requests that fail before a run is created.** An absent base returns
`INCREMENTAL_BASE_ABSENT` (404). A base that is a Feature, Testing or scripted run returns
`INCREMENTAL_BASE_MODE_MISMATCH:<mode>` (409). A scripted target returns
`INCREMENTAL_REQUIRES_MODEL_AUDIT` (a preflight error). `workflow.incremental` outside
Audit mode fails schema validation. A malformed base ID returns 400.

**Fallback.** Some bases cannot establish safe reuse. The run is then a full audit, and
the reasons are recorded in `fallbackReasons`:

- `base_run_not_completed:<state>`
- `base_repository_differs`
- `base_snapshot_identity_unavailable` (the base predates this feature)
- `git_identity_unavailable`
- `git_history_rewritten` (the base commit is no longer an ancestor of `HEAD`)
- `workflow_graph_changed` (the executed graph differs from the base's, in its saved-graph
  `{id, version}` reference or its content version; a saved-graph run reuses only from a
  base that ran the same graph)
- `base_workflow_graph_unavailable`

**Snapshot identity.** Every model Audit records a `snapshot-identity` artifact before any
stage runs. It holds the SHA-256 of each snapshot file, the SHA-256 of each build or
dependency manifest (`package.json`, lockfiles, `tsconfig.json`, `go.mod`, `Cargo.toml`
and similar) in any ancestor directory of a snapshot file, and the Git `HEAD`. The run
compares these hashes with the base's to compute the changed files and manifests. Those
changes are expanded to affected surfaces (module topology, import and manifest relations),
and hotspots rank the changed paths when Git history is available. Paths from
`git diff` are recorded for information only. The byte hashes decide.

**Reuse unit.** The unit of reuse is one discovery activity: one auditor over one discovery
scope or one exact line window. Every model Audit records a `discovery-unit-<auditor>-<scope>`
artifact for each unit. The record holds the unit's identity, its cited line ranges and
the harness inspection footprint (the files the model read through tools). The identity
covers:

- the exact bytes of every file the unit was given or could read (its footprint);
- the transitive repository-internal imports of those files;
- the manifests in their ancestor directories;
- the run scope, including exclusions, and any line window;
- the pinned `production-audit` protocol and its prompt override;
- the model profile, endpoint and output reserve;
- the harness;
- the discovery policy (audit depth, effort, discovery budget, `security`, `contextPolicies`).

Before dispatching a unit, an incremental run compares the unit's identity with the
base's record of the same unit. It stores the decision as `incremental-unit-<key>` and
names each component that changed:

- `changed:footprint:<path>`, `changed:cited_lines:<path>:<a>-<b>`, `changed:imports:<path>`,
  `changed:manifests:<path>`
- `changed:scope`, `changed:protocol`, `changed:model`, `changed:harness`, `changed:policy`
- `base_unit_absent` (for example, allocation changed), `base_unit_identity_unavailable`
- `base_footprint_unavailable`, `footprint_outside_unit:<path>`, `manifest_unverifiable:<path>`

A missing record or footprint never counts as equal. A reusable unit obtains its model
outputs through the replay mechanism: each harness turn is reused only if its per-activity
replay identity (see [replay](#feature-and-testing-replay)) is unchanged. Tool calls
re-execute against the current snapshot. Findings are validated again against the current
snapshot. `incremental-unit-result-<key>` lists each finding with `reusedFrom` (base run
and findings artifact) and whether the findings equal the base's.

Units are allocated on the current snapshot in the same way as in a full run. A small
repository that fits one context is a single unit per auditor, so any change regenerates
that auditor's discovery; partial reuse comes from partitioned discovery. Only a
byte-identical unit is reused, so reused findings always cite unchanged bytes.
`baseFindingLineage` re-anchors each base finding by exact content only:

- `unchanged`
- `moved`, with the new location, when exactly one exact match exists
- `absent`
- `ambiguous`, when more than one exact match exists
- `unverifiable`, when the stored text was redacted

**Independence.** Reused discovery comes from independent discovery of identical inputs.
It is served only to the same auditor's same unit. Round-zero inputs never contain base,
peer or reused findings.

**Downstream stages.** Clustering, peer review, verification and planning are recomputed
over the union of reused and fresh findings. There is one exception: a stage whose whole
input identity matches the base may reuse the base's saved outputs. That identity covers
the repository digest, manifests, scope, harness, models, protocols, the consensus,
verification and discovery policy, and the upstream stage. Each output must also match
its per-activity replay identity. In that case the run also keeps the base's peer-review
view seed, so identical views can be reused. Consensus-policy changes therefore
regenerate only downstream stages; discovery is still reused.

**Report.** `savedWork` gives:

- reused and regenerated units;
- model calls reused and made;
- tokens saved, from the base's traces (usage the base provider did not report is counted
  as `callsWithUnknownUsage`, never as zero);
- regeneration reasons.

`coverage` lists uncovered snapshot paths per auditor and reused units that carried
truncation or unexamined surfaces. `degradedVersusFullRun` is true if either is non-empty.
The base run is only read. Resuming an incremental run keeps its recorded contract and
unit decisions; it never re-decides against the base.

**Evidence.** The evidence comes from injected fake providers and a Git fixture
([`incremental-audit.test.ts`](../packages/runtime/test/incremental-audit.test.ts)):

- An identical rerun made zero provider calls.
- Edits to cited lines, uncited lines, an imported file, a nested manifest, the root
  manifest, exclusions, consensus policy and audit depth each regenerated exactly the
  expected units or stages.
- The fixture compared a full run with an incremental run over a moved, a fixed, a recurring
  and a new defect in five modules. Both produced the same canonical issues and summary,
  with no coverage degradation. The full run made 25 provider calls (10 discovery); the
  incremental run made 21 (6 discovery) and reused 4 discovery units. Downstream stages
  regenerated because the repository changed.
- An interrupted incremental run resumed without repaying completed units.
- A failed base and rewritten Git history fell back to a full audit.
- The CLI and HTTP cores made identical decisions.

Live providers have not been exercised.

## Presets

Seven presets are executable through the shared runtime's
[`PRESET_GRAPHS`](../packages/runtime/src/graphs.ts). Six schema-only examples live in
[`../examples`](../examples); runnable model-backed templates for Audit, both Feature
modes, `testing-plan` and `testing-execute` live in
[`../examples/model-backed`](../examples/model-backed). See [Getting started](setup.md).

| Preset | Mode | Runtime shape |
|---|---|---|
| `audit-balanced` | audit | Two auditors, bounded consensus, verification and planner |
| `audit-deep` | audit | Three auditors, bounded consensus, verification, planner and critic |
| `diff-fast` | audit | One auditor, deterministic verification and planner; no peer review |
| `diff-review` | audit | Two auditors, bounded review, verification and planner |
| `feature-simple` | feature | Requirements, exploration, risk-directed review, planning/revision and handoff |
| `testing-plan` | testing | Inventory, grounded risk/gap selection, planner and handoff; no execution |
| `testing-execute` | testing | Planning, guarded writer/check/finalization stages and verified change handoff |

`pnpm run validate:examples` parses the schema-only examples and model-backed templates
with `runConfigSchema`, checks the templates against runtime preflight, and runs negative
controls proving a stale example fails. `pnpm run smoke:examples` runs every template
through the public runtime with fixture transports. It proves wiring, not live-provider
behavior. Other preset assets in packages/workflow are not automatically
available through CLI/server; unknown public preset IDs fail explicitly.
