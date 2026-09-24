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
orchestrator's `graphs` option use them, and operator-authored graphs (P16) will too.

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
invalidate operator approvals and downstream review identities. Dedicated requirements
controls in the web UI remain unfinished. Feature uses the runner's subgraph primitive; stage detail is available in
its artifacts and traces. Audit-policy replay is explicitly unsupported for Feature;
ordinary durable resume is supported.

`packages/runtime/src/model-feature-planning.ts` composes the selected planner with an
independent critic and at most one revision/re-review. Only a complete, non-degraded
critique with blocking items triggers revision. Revisions must preserve requirement
traceability, premise provenance and existing unresolved questions, and provide exactly
one resolution claim per blocking item. The independent re-review receives the original
plan, critique and claims; remaining blockers, rejected mappings and blocking plan
questions prevent a passing result. Completed model activities are reused on restart,
including when the revised plan is unchanged. Oversized mandatory Feature revision
contexts fail explicitly; hierarchical Feature revision is not yet implemented.

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
metadata changes. Oversized mandatory selection/planning context fails explicitly.

The planner links every selected gap to tasks and validation assertions. Concrete write
paths must classify as tests or test configuration; production-file paths and invented
commands are rejected. Successful nonempty plans publish the implementation tree under
run artifacts. An analysis selecting no gaps publishes an explicit no-work outcome;
it is not proof of test coverage. Blocking questions withhold the handoff.

All stages share the durable model budget and resume machinery. In plan mode commands
are never run, the source tree stays unchanged, and the planning result records `testsExecuted: false`.
Audit-policy replay is unsupported for Testing. Dedicated web controls and expanded
Testing subgraph views remain open.
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
an exact `testing-change-set-*` artifact. Retrieve it through the existing artifact API.
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
The [completion plan](completion-plan.md) also tracks oversized contexts, web controls,
mode-specific replay and the remaining extensions.

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
