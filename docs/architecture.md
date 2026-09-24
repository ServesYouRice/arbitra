# Architecture

This describes the system as built. [Project status](project-status.md) records dated
verification evidence; the [completion plan](completion-plan.md) tracks unfinished
implementation and validation. The original build specification is a locally retained
working input and is not required to read this public documentation set.

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
or execution evidence withholds the relevant handoff. Native harnesses produce an explicit
`RUNTIME_NATIVE_HARNESS_NOT_AVAILABLE` error; unknown presets produce `UNKNOWN_WORKFLOW_PRESET`.
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
| durable evaluation corpora, provenance and reports | `evaluation-corpus/` |

See [`durability.md`](durability.md).

## Interfaces

### CLI

`apps/cli/src/command-registry.ts` is the authority on what exists. Implemented:

```text
validate  estimate  run  audit  status  resume  replay  diff  trace  export  report
requirements  approve-requirements  revise-requirements  apply-requirements-revision
respond-checkpoint
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

`POST /runs/:id/checkpoints/:checkpointId` records one versioned decision for a generic
`human` node through the orchestrator. The server holds no checkpoint state. See
[Gates and human checkpoints](workflows.md#gates-and-human-checkpoints).

Four requirements routes expose saved Feature contracts and versioned approval/revision
operations. See [Feature mode](workflows.md#feature-mode) for their payloads and CLI
equivalents. HTTP body validation preserves JSON types; pagination parameters are parsed
explicitly from query text.

Three trace routes register when the trace store is wired: `GET /runs/:id/traces`,
`GET /runs/:id/traces/:traceId`, and
`GET /runs/:id/traces/:traceId/artifacts/:slot`. Lists support exact node/model/protocol/
outcome filters, activity substring search, and offset pagination (25 by default,
100 maximum). Trace IDs are positions in the committed append-only log; filtering
does not change them. Artifact slots (`input-0`, `input-1`, or `output`) resolve only
references attached to the selected attempt, with content-hash verification and the
same secret-egress guard. Historical outputs do not need a current named artifact entry.

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
(`views/plan/`), the Evaluation surface (`views/evaluation/`), and the trace browser
(`views/traces/`). The trace browser shows full model/harness/protocol identity,
requested/resolved effort, measured usage, outcome, refusal/error details and redacted
input/output artifacts. It refreshes on run events or explicit request, keeps unknown
measurements distinct from zero, and treats artifact content as untrusted text.
Trace list and detail responses are served from a persistent per-run index
(`packages/persistence/src/trace-index.ts`) that catches up incrementally from the
committed trace log and re-reads only the served records from it, so a page no longer
scans the whole log; the log stays authoritative and the index is rebuilt when stale or
corrupt. See [durability](durability.md#traces-and-the-rebuildable-index).
The Model Pool, contract
column and inspector stay in place across the switch, so run controls remain reachable from
every view.

## Known gaps

The [completion plan](completion-plan.md) records dependencies and acceptance criteria:

- **Live-provider/Docker acceptance and real-model premise evaluation remain outstanding.**
  Injected-provider tests do not establish model quality. See [`evaluation.md`](evaluation.md).
- Final Testing verification can reopen invalidated earlier work for bounded, durable repair
  under the original write grants (see [Testing mode](workflows.md#testing-mode)). The critical
  repair cases have not yet been repeated against the real Docker sandbox.
- Individually oversized records and mandatory global contexts can still fail explicitly
  across Audit, Feature and Testing.
- Durable Feature requirements checkpoints and generic gate/human checkpoints work through
  CLI/HTTP. Generic checkpoints apply to registered graphs; the shipped presets do not
  contain those nodes. Dedicated web controls and Feature/Testing replay remain incomplete.
- The trace browser and its persistent large-history query index are implemented;
  browser acceptance QA remains outstanding. Evaluation corpora are durable, but no
  live evaluation driver feeds them yet.
- The September 24 review found test-discovery and macOS reliability defects; see
  [verification evidence](project-status.md#verification-evidence).

## v1.1 extension points

These areas were originally grouped as v1.1 extensions. Their implementation status
now differs; all unfinished work is included in the completion plan.

| Deferred feature | Extension point |
|---|---|
| Autonomous Testing execution | Implemented through opt-in `testing-execute`: planning, authority preflight, parallel writers, serial checks, final verification, bounded repair and durable handoff. Real-sandbox repair QA, richer web views and live-provider/Docker QA remain; plan items P04/P07/P10/P11 |
| Native harness adapters | `packages/harness/src/adapter.ts` defines the port; `canonical/adapter.ts` is the only implementation. `harness.mode: "native"` is accepted by the schema and has no adapter behind it |
| Advisor runtime | `taskRouting.advisor` and `advisorMaxUses` exist in `packages/schemas/src/task-ir.ts`; `advisorTokens` is recorded in `packages/persistence/src/trace.ts`. Nothing consumes them |
| Feature workflow extensions | Public requirements/review/planning/revision is implemented; web checkpoints, expanded subgraphs, oversized contexts and Feature-specific replay remain; P08/P10/P11 |
| Incremental / repeat audit execution | Snapshot identity, hotspots and inspection footprints are already recorded by preflight and `packages/tools/src/footprint` |
| Provider batch API path | Opt-in batch lane and OpenAI/Anthropic/Gemini drivers in `packages/providers/src/batch/`, tested against injected HTTP only; every driver is declared-unverified and live validation remains (P15). See [`provider-model.md`](provider-model.md#batch-lane) |
| Drag-and-drop workflow canvas editor | `apps/web/src/columns/graph` renders from workflow JSON and is read-only by construction |
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
