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

Same engine. `packages/workflow/src/nodes/requirements/` produces a durable Requirements
Contract and routes by ambiguity and repository risk (`routing.ts`), preserving assumption
and acceptance traceability into planning.

The **full multi-model Feature consensus branch is v1.1** and is not implemented. The
consensus engine is mode-agnostic and will be reused unchanged when it lands; the Feature
branch currently routes single-model.

## Testing mode

Plan-only, by construction. `packages/workflow/src/nodes/test-inventory.ts` inventories the
existing test architecture deterministically, selects gaps that cite production failure
modes, and emits a Validation Contract and test Task IR.

**It does not execute anything and cannot.** Routing decisions are recorded but not run,
every command is repository-derived, and the working tree is unchanged.
Autonomous Testing execution — worktree, write scope, shell, egress sandbox — is **v1.1**
and not implemented.

## Presets

Six configurations in [`../examples`](../examples), one per shipped preset:

| Preset | Mode | Scope | Consensus | Shape |
|---|---|---|---|---|
| `audit-balanced` | audit | repository | `risk_weighted`, 2 rounds | two auditors and a planner |
| `audit-deep` | audit | repository | `full`, 3 rounds | three frontier auditors, verification, planner, critic |
| `diff-fast` | audit | diff | `minimal`, 0 rounds | one fast auditor, deterministic verification only |
| `diff-review` | audit | diff | `risk_weighted`, 2 rounds | two auditors and verification |
| `feature-simple` | feature | module | `minimal`, 1 round | requirements and planner |
| `testing-plan` | testing | repository | `minimal`, 1 round | gap analyst and planner, plan-only |

`pnpm run validate:examples` parses all six with `runConfigSchema` and runs negative
controls proving a stale example fails.
