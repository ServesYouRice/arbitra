# Task IR, Validation Contract and Plan IR

The product's deliverable is a plan a *different* agent can execute from `implementation/`
alone. That only works if every task carries its own contract — not a description, a
contract.

## Traceability

```text
SOURCE FINDING → CANONICAL ISSUE → VALIDATION ASSERTION → TASK → VERIFICATION EVIDENCE
```

Every link is a persisted ID reference, never a relationship re-derived by a reader:

| Link | Where it lives |
|---|---|
| finding → issue | `canonicalIssue.sourceFindingIds` (`packages/schemas/src/canonical-issue.ts`) |
| issue → validation | `planIR.traceability.issueToValidation` (`packages/schemas/src/plan.ts`) |
| validation → task | `taskIR.addresses.validation` (`packages/schemas/src/task-ir.ts`) |
| requirement → validation → task | `planIR.traceability.requirementLinks` |
| task → evidence | `planTaskIR.expectedEvidence` and `verification.commands` |

`packages/workflow/src/nodes/planner/traceability.ts` builds these links, and the Planner
fails hard rather than emitting a plan where a task maps to no assertion or an accepted
issue is covered by no task. `apps/web/src/views/plan/traceability.ts` walks the same chain
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
  advisor:        frontier | balanced | fast | null    # schema only in v1
  advisorMaxUses: number | null                        # runtime is v1.1
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

**`filesNotToTouch` may only subtract.** It cannot widen scope. An executing agent's write
scope is `likelyFiles` minus this list, intersected with the repository's own scope
envelope — see [`security.md`](security.md).

**`executionPolicy` travels with the command.** An agent cannot receive a command without
its policy. `packages/security/src/command-policy.ts` re-resolves the policy against the
repository immediately before use; a derived script that changed or disappeared becomes
`requires_approval`, which means a human checkpoint, not a retry.

**`context` is advisory and says so.** It may explain a contract; it cannot expand scope,
weaken an invariant or authorise a command. That asymmetry is what stops model-authored
prose from quietly becoming policy.

## Plan IR

`packages/schemas/src/plan.ts` wraps the above:

```text
id · title · mode · reasoningOutcome · implementationStrategy · dependencies
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

`routing.capability` and `routing.effort` are chosen by
`packages/core/src/routing/difficulty.ts` across `DIFFICULTY_DIMENSIONS`, with `reason`
recording why. `planIR.routingRecommendations` carries the same decision at plan level, so
a reviewer can see where the router and the task disagree.

`advisor` and `advisorMaxUses` are **schema only in v1**. The advisor runtime is v1.1 and
not implemented; `advisorTokens` is recorded on traces so the data exists when it lands.

## Rendering

`packages/core/src/render/` turns Plan IR into the `implementation/` directory
deterministically: `render/markdown/` for prose, `render/manifest.ts` for the machine
contract, `render/execution-state.ts` and `render/progress.ts` for the status channels,
`render/markdown/neutralize.ts` to neutralise untrusted repository prose that appears as
evidence.

The manifest is authoritative; Markdown is generated from it. Task contracts are immutable
once rendered — evolving knowledge belongs in the execution directory, never in a rewritten
contract, because a contract that can be edited to match what was built is not a contract.
