# Architecture

This describes the system as built. The normative specification is
[`MASTER-BUILD-PROMPT.md`](MASTER-BUILD-PROMPT.md); where this document and the code
disagree, the code is the defect or this document is, and the review should say which.

## Layering

Dependencies point downward. Nothing below imports anything above it.

```text
apps/cli · apps/server · apps/web        interfaces
        │
packages/core                            orchestration: runner, preflight, prompt, render, replay
        │
packages/workflow                        typed nodes: discovery, clustering, consensus, verification, planner
        │
packages/harness · packages/providers    model execution: canonical loop, transports, profiles
        │
packages/protocols · packages/tools · packages/security
        │
packages/persistence · packages/schemas  durable state and canonical types
```

`packages/testing` sits outside the stack: fake transports, scripted auditors and premise
scoring, used by suites in every layer.

**The CLI and the UI call the same core.** `apps/server/src/routes/control-plane.ts`
delegates every lifecycle operation to a `ControlPlaneCore` port; `apps/cli/src/core.ts`
declares the same operations as `OrchestratorCore`. There is no second orchestration
implementation, and adding one would be the defect the specification names most often.

## The core loop

`packages/core/src/runner/workflow-runner.ts` executes a typed graph. Every node is one of
the six kinds in `packages/schemas/src/glyphs.ts` — the taxonomy is closed, and
`packages/workflow/src/node-kinds.ts` and `graph-schema.ts` enforce it.

```text
■ preflight            snapshot, exclusions, scope, hotspots, impacted surfaces
■ control plane        protocol assets resolved from a trusted source
◇ complexity router    decides whether more models are worth paying for
◆ discovery            independent auditors, isolated contexts, canonical harness
■ validate findings    deterministic schema and evidence-range checks
■ clustering           deterministic; escalated pairs recorded
■ issue board          built from an append-only operation log
◆ peer review          bounded rounds, dissent retained
▣ verification         deterministic ladder first, one model question last
■ canonical issues     support count, review denominator, dissent, coverage
◆ planner              Validation Contract, Task DAG, capability routing
◆ critic               conditional; skipped with a recorded reason
■ renderer             deterministic implementation/ output
```

Workflow code is deterministic by rule, not by convention:
`tooling/eslint-rules/no-workflow-nondeterminism.cjs` runs against
`packages/{core,workflow,persistence}/src` and fails the build on `Date.now()`,
`Math.random()` or direct network access outside an activity. Time and randomness are
injected through `packages/core/src/services/clock.ts` and `services/rng.ts`.

## Durability boundary

Everything that survives a crash lives in `packages/persistence`:

| Concern | Module |
|---|---|
| activity journal | `journal.ts`, `journal-load.ts` |
| fsync policy and durability classes | `fsync.ts` |
| content-addressed artifacts | `artifact-store.ts` |
| issue operation log | `issue-ops.ts` |
| model activity traces | `trace.ts` |
| rebuildable query index | `index-db/rebuild.ts` |
| byte-stable serialisation | `canonical-json.ts` |
| secret-bearing state kept out of the run directory | `private-store.ts` |
| guarded metric aggregation | `metrics/query.ts`, `metrics/queries.ts` |

See [`durability.md`](durability.md).

## Interfaces

### CLI

`apps/cli/src/command-registry.ts` is the authority on what exists. Implemented:

```text
validate  estimate  run  audit  status  resume  replay  diff  trace  export  report
```

`apps/cli/src/exit-policy.ts` is the sole mapping from outcome to process exit code:
`0` clear, `1` policy gate failed, `2` system failure, `3` suspended or blocked. An
unrecognised disposition fails closed at `2`. Every command can emit JSON with `--json`
(`apps/cli/src/output/json.ts`).

`report` renders the evaluation surface and redacts its output through
`redactSecrets` from `packages/security/src/redaction.ts`, failing closed with
`report_redaction_failed` if anything secret-shaped survives.

### Server

`apps/server/src/main.ts` builds a Fastify instance bound to `127.0.0.1:4178`. Every route
carries a canonical schema from `packages/schemas/src/http-control-plane.ts`; a route with
no schema entry throws `MISSING_HTTP_SCHEMA` at registration rather than serving unvalidated
input. Seventeen control-plane routes are listed in `apps/server/src/routes/inventory.ts`;
two evaluation routes (`GET /runs/:id/metrics`, `POST /runs/compare`) register only when a
metric store is wired, and return 404 otherwise.

There is no WebSocket surface. Run events stream over SSE (`apps/server/src/sse.ts`).
Every response passes `assertNoSecretEgress`, which fails the request rather than emitting
a credential.

### Web

`apps/web` renders the four-column shell from `docs/DESIGN-LANGUAGE.md`: Model Pool,
read-only workflow graph, prompt/context/contract, and inspector with run controls. The
graph is a live run view built with ELK layout and React Flow, and it is read-only — there
is no canvas editor in v1.

Column two is the only fluid column, so it carries the run-level views behind a tab strip
(`WORKSPACE_VIEWS` in `apps/web/src/shell/ArbitraWorkspace.tsx`): the workflow graph, the
Issue Board (`views/issue-board/`), the Plan view with its bidirectional traceability trail
(`views/plan/`), and the Evaluation surface (`views/evaluation/`). The Model Pool, contract
column and inspector stay in place across the switch, so run controls remain reachable from
every view.

## Known gaps

Recorded rather than hidden, per §32.1:

- **The premise is unmeasured on real models.** See [`evaluation.md`](evaluation.md).

## v1.1 extension points

None of the following is implemented. Each names where it would attach, so the deferred
work is legible without re-deriving it.

| Deferred feature | Extension point |
|---|---|
| Autonomous Testing execution (worktree, write scope, shell, egress sandbox) | `packages/workflow/src/nodes/test-inventory.ts` produces plan-only Task IR; execution would attach behind a new writable-scope tool surface in `packages/tools`, gated by `packages/security/src/command-policy.ts` |
| Native harness adapters | `packages/harness/src/adapter.ts` defines the port; `canonical/adapter.ts` is the only implementation. `harness.mode: "native"` is accepted by the schema and has no adapter behind it |
| Advisor runtime | `taskRouting.advisor` and `advisorMaxUses` exist in `packages/schemas/src/task-ir.ts`; `advisorTokens` is recorded in `packages/persistence/src/trace.ts`. Nothing consumes them |
| Full Feature multi-model consensus | `packages/workflow/src/consensus/engine.ts` is mode-agnostic; the Feature branch currently routes single-model |
| Incremental / repeat audit execution | Snapshot identity, hotspots and inspection footprints are already recorded by preflight and `packages/tools/src/footprint` |
| Provider batch API path | `modelProfileSchema.supports.batch` is recorded; `packages/providers/src/scheduler.ts` has no batch lane |
| Drag-and-drop workflow canvas editor | `apps/web/src/columns/graph` renders from workflow JSON and is read-only by construction |
| Polished trace-browser UI | Traces are complete in `packages/persistence/src/trace.ts`; only the inspector surfaces them |
| Local embedding clustering | `packages/workflow/src/clustering/deterministic.ts` is the deterministic path; §25.4 metrics would have to justify replacing it |

Data for these is recorded now, per §2.4: inspection and exposure footprints, immutable
snapshot identity, Git base/head/range, hotspots, the activity journal, the issue op log,
model/harness/protocol/prompt identity, clustering escalation metrics and provider
scheduler metrics.

## Explicitly out of scope

SaaS hosting, accounts, teams, cloud job queues, billing, PR creation, automated
deployment, generalized production-code implementation for Audit or Feature, learned model
routing, benchmark UI, marketplace, plugin ecosystem, model-generated dynamic workflows and
collaborative editing. None of these has an extension point, by design.
