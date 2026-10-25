# Task IR, Validation Contract and Plan IR

The product's deliverable is a plan a *different* agent can execute without the run: the
`implementation` tree a run publishes, or the prompts a saved plan writes into the project
(see [Rendering](#rendering)). That only works if every task carries its own contract — not
a description, a contract.

## Traceability

```text
SOURCE FINDING → CANONICAL ISSUE → VALIDATION ASSERTION → TASK → VERIFICATION EVIDENCE
```

Every link is a persisted ID reference, never a relationship re-derived by a reader:

| Link | Where it lives |
|---|---|
| finding → issue | `canonicalIssue.sourceFindingIds` (`packages/workflow/src/nodes/canonical-issues.ts`) |
| issue → validation | `planIR.traceability.issueToValidation` (`packages/schemas/src/plan.ts`) |
| validation → task | `taskIR.addresses.validation` (`packages/schemas/src/task-ir.ts`) |
| requirement → validation → task | `planIR.traceability.requirementLinks` |
| task → evidence | `planTaskIR.expectedEvidence` and `verification.commands` |

The planner writes these links, and `packages/workflow/src/nodes/planner/traceability.ts`
(`validateTraceability`) checks them. The Planner fails hard (`PlannerTraceabilityError`)
rather than emitting a plan where a task maps to no assertion or an accepted issue is
covered by no task. In Audit and Feature plans, two tasks whose write scopes overlap must
also be ordered by a dependency path (`SHARED_WRITE_SCOPE_UNORDERED`; a directory covers its
files, and a glob in `likelyFiles` such as `src/**/*.ts` or `packages/*/package.json` counts as
the files it can match, doubtful cases as an overlap): a handoff renders only
`dependsOn` and `blocks`, and `conflictsWith` orders nothing. Testing execution serialises
shared writes itself, so its plans are exempt. The run adds the orders a plan leaves out
(`withSharedWritesOrdered`, applied to every plan, outline and revision a model returns): the
later task by id waits for the nearest earlier one that writes the same files, in its
`dependsOn` and in `taskGraph`. A plan states the orders that matter, so what it leaves
unordered is independent work on the same files, and any order serialises it; an order the
plan states is kept, whichever way it runs. Before that, in every mode, it makes the plan's
two statements of order agree (`withGraphMatchingDependencies`): an order a task's `dependsOn`
or `blocks` states is added to `taskGraph`, an edge only in `taskGraph` is added to the later
task's `dependsOn`, and an edge stated twice is kept once; edges naming unknown tasks are left
to the check. Observed live: a plan section was refused for one `dependsOn` missing from
`taskGraph`, and its repair wrote the section again. The check stays as the last line. Planner calls
refuse the other violations inside the call, so the bounded output repair can fix them. `apps/web/src/views/plan/traceability.ts` walks the same chain
in both directions in the UI.

## Validation Contract

`packages/schemas/src/validation-contract.ts`. Behavioural assertions defining what
correctness means, fixed *before* tasks are finalised:

```yaml
validation:
  - id: VAL-001
    assertion: Unauthorized users cannot change another user's role.
    evidence: [authorization regression test, relevant integration suite]
```

`id` matches `^VAL-[0-9]+$`, `assertion` is non-empty, and `evidence` must list at least
one item. An assertion with no evidence is not an assertion.

## Task IR

`packages/schemas/src/task-ir.ts` — strict, so an unknown field is an error.

```yaml
schemaVersion: 1
id: TASK-014                       # ^TASK-[0-9]+$
title: string

goal:
  objective:   string
  doneWhen:    []                  # observable completion conditions
  stopWhen:    []                  # where scope ends
  blockedWhen: []                  # when to stop and report

addresses:
  issues:       []
  validation:   []
  requirements: []

routing:
  capability:     frontier | balanced | fast
  effort:         low | medium | high | xhigh
  advisor:        frontier | balanced | fast | null    # requested advisor tier
  advisorMaxUses: number | null                        # may only lower the operator cap
  reason:         []

dependencies:
  dependsOn: []
  blocks:    []
  conflictsWith: []

scope:
  likelyFiles: []
  components:  []
  interfaces:  []
filesNotToTouch: []                # may only subtract from scope

readFirst:              []         # progressive disclosure, not the whole repository
context:                []         # advisory; cannot expand scope or authorise a command
invariants:             []
outOfScope:             []
implementationGuidance: []
acceptanceCriteria:     []

verification:
  preconditions: []
  commands:
    - command:         string
      expectedExitCode: number
      executionPolicy:  derived_repository_script | allowlisted | requires_approval
  checks: []

rollbackPlan: []
```

Three fields do more work than their size suggests.

**`filesNotToTouch` may only subtract.** It cannot widen scope. The renderer
(`packages/core/src/render/index.ts`) computes a task's effective write scope as the paths the
run grants it, limited to `likelyFiles` and minus this list. No shipped pipeline grants any:
Audit, Feature and Testing render every task with an empty effective write scope
(*display-only*), and the executing agent's environment decides what it may write. Testing
execution takes its write authority from the operator's grant instead
([Testing mode](workflows.md#testing-mode)).

**`executionPolicy` travels with the command.** An agent cannot receive a command without
its policy. The Audit and Feature handoffs mark every verification command
`requires_approval`, whatever the plan said (`packages/runtime/src/model-pipeline.ts`,
`feature-pipeline.ts`), so an executor asks before running any of them. A Testing plan may
use only the commands its analysis derived, with their policies: package `test` and `test:*`
scripts as `derived_repository_script`, commands the configuration declares as
`requires_approval`. See [security](security.md#command-policy).

**`context` is advisory and says so.** It may explain a contract; it cannot expand scope,
weaken an invariant or authorise a command. That asymmetry is what stops model-authored
prose from quietly becoming policy.

## Plan IR

`packages/schemas/src/plan.ts` wraps the above:

```text
schemaVersion · id · title · mode · reasoningOutcome · implementationStrategy · dependencies
acceptedIssueIds · unresolvedQuestions · validationContract · tasks · taskGraph
traceability · routingRecommendations · rolloutConcerns · migrationConcerns · premiseReport
```

`planTaskIRSchema` extends Task IR with `escalateIf`, `expectedEvidence` and a nullable
`estimatedTurns` — nullable because an unmeasured estimate is null, not a guess.

`unresolvedQuestions` carry `blocking` and `blastRadius`. A plan is allowed to say it does
not know something; it is not allowed to pretend it does.

`premiseReport` is mandatory and always carries
`interpretation: "smoke_test_only_not_proof"` plus at least one limitation. A plan cannot
be emitted claiming the multi-model premise was proved. See [`evaluation.md`](evaluation.md).

## Capability routing

The planner writes `routing.capability` and `routing.effort`, with `reason` recording why,
and `planIR.routingRecommendations` carries the same decision at plan level. Traceability
fails a task with no recommendation or no reason (`ROUTING_RECOMMENDATION_MISSING`). The
deterministic pipeline uses `balanced`/`medium`. No pipeline scores task difficulty itself;
routing is the planner's.

## Advisors

`routing.advisor` and `routing.advisorMaxUses` are consumed by the Testing writer through
`packages/runtime/src/model-advisors.ts`. An advisor is an activity inside the existing
node that executes the task, not a node kind, and its advice is input to that authorized
executor only.

**Operator policy decides; the task can only lower.** `workflow.testing.execution.advisors`
(`packages/schemas/src/advisor.ts`) maps each tier to a model profile and sets
`maximumUsesPerTask`, `maximumContextTokens` (admission estimate of one request, including
its output reserve), `maximumOutputTokens` and `maximumTokensPerTask`. The effective use
limit is `min(advisorMaxUses ?? cap, cap)`. No policy, an unmapped tier or a zero limit
disables the advisor (`not_configured`, `tier_not_configured`, `zero_uses`) and the writer
proceeds without advice. Preflight rejects advisor profiles that are absent, below their
tier, without an endpoint, or whose context/output limits cannot hold the policy.

**Durable uses.** Each use is journaled in `advisor-ledger-<task hash>` (state `dispatched`)
with its pinned request artifact *before* the provider request, then settled as
`completed`, `failed` or `cancelled`. A question is identified by the executor's request
ID (the writer uses its attempt ID): asking again replays the recorded outcome. Completed
advice replays from the durable model activity without a new request. A dispatch that
was interrupted by a crash is resolved replay-only and becomes `ADVISOR_USE_INTERRUPTED`;
it is never sent twice. Failed and cancelled uses stay consumed. Changing the task or the
policy after uses are journaled fails with `ADVISOR_CONFIGURATION_CHANGED` instead of
resetting the allowance. Exhaustion (`uses` or `tokens`) and a context that cannot fit
(`skipped: context_limit`) consume nothing and dispatch nothing.

**Usage.** Advisor calls go through the shared provider registry, rate scheduler and run
token budget. They are traced separately under `harnessId: "advisor-direct"`, the
advisor's model and a `<node>/advisor/<task hash>/use-<n>` activity ID, with `advisorTokens` set
from measured usage. Unknown usage stays `null`, is charged to both the run budget and the
per-task advisor cap at its admission estimate, and therefore still bounds later uses.

**No authority.** Advisors receive no tools and no peer, discovery or other executors'
output: their input is the task contract, the attempt, the executor's own previous
verification feedback and its pinned repository snapshot. The writer receives advice as
`advisory` data marked `untrusted_advisory_data` and `authority: "none"`, with precedence
task contract/write lease > verification evidence > advice. Recommendations naming paths
outside the write lease are flagged `outsideWriteAuthority`; contradictory advice on the
same path (`avoid` versus `add_test`/`modify_test`) is reported in `conflicts` and not
resolved by recency. The writer's tools, lease, commands and budgets are identical with
and without advice.

**Disabled in round-zero discovery.** `TaskAdvisor.consult` rejects round 0 and any
discovery activity with `ADVISOR_DISABLED_IN_DISCOVERY` before journaling anything, and
`ModelActivities` independently rejects advisor-marked requests for discovery activities,
tool-bearing advisor requests and harness turns.

Coverage is fixture-based (`packages/runtime/test/model-advisors.test.ts`), plus an opt-in
live test (`model-advisors.live.test.ts`, `ARBITRA_LIVE_ADVISOR=1`) that passed on Gemini
native and compatible chat ([`qa/p13-live`](qa/p13-live/README.md)).

## Rendering

`packages/core/src/render/` turns Plan IR into the `implementation` tree deterministically:
`render/markdown/` for prose, `render/manifest.ts` for the machine contract,
`render/execution-state.ts` and `render/progress.ts` for the status channels,
`render/markdown/neutralize.ts` to neutralise untrusted repository prose that appears as
evidence. A model Audit, and a Feature or Testing run whose plan passes its gate, publish the
tree as the `implementation` artifact; `export <run-id> --json` returns it
([Getting started](setup.md#consuming-handoffs)).

Saving the plan into the project is a second, separate form
(`packages/runtime/src/plan-export.ts`, on the operator's request only). It writes the Plan IR
as prompts under `.arbitra/plans/<date>-<run>/` in the audited repository, grouped by each
task's `routing.capability`, with a `results.json` the executor fills in per issue and a
premise check (`check-premises.mjs` and the `premises.json` it reads, `packages/runtime/src/premise-check.ts`)
that looks up what each prompt names in the code before its task starts. The run
reads that file back (`packages/runtime/src/plan-results.ts`) and reports how many issues a
failing test proved and how many were fixed
([Export the plan into the project](setup.md#export-the-plan-into-the-project)).

The manifest is authoritative; Markdown is generated from it. Task contracts are immutable
once rendered — evolving knowledge belongs in the execution directory, never in a rewritten
contract, because a contract that can be edited to match what was built is not a contract.
