# arbitra

Just another multi-model software audit and implementation orchestrator. I was too lazy to do it manually, and others didn't really work for me, so I figured, "fine, I will do it myself".

arbitra runs several independent models over one repository snapshot, makes them argue in
a structured way, resolves what it can deterministically, and emits a plan a different
agent can execute. Its premise — that independent auditors find defects a single model
misses — is treated as a hypothesis the system measures, not as a marketing claim.

## Status

The workspace implements an alpha runtime for **model-backed Audit, Feature planning,
Testing planning and guarded Testing execution**, alongside scripted Audit. Configured
model execution requires endpoint bindings and explicit roles; see
[`docs/provider-model.md`](docs/provider-model.md). Model Feature workflows now run through
the shared CLI/server runtime with durable requirements checkpoints, risk-directed review,
planning and an exportable implementation handoff; see [`docs/workflows.md`](docs/workflows.md#feature-mode).
Testing workflows compose grounded risk analysis and gap selection, with either a read-only
plan or opt-in guarded execution in an isolated worktree. Execution requires explicit
write partitions and digest-pinned sandbox checks; it exports verified changes without
modifying the source checkout. Native harnesses remain unimplemented. Live-provider and
Docker acceptance validation, final-invalidation repair, larger-context handling and
operator UI work remain. See [project status](docs/project-status.md) for implemented
capabilities and measured verification, and the [completion plan](docs/completion-plan.md)
for all remaining steps, dependencies and acceptance criteria.

One thing is worth knowing before reading further: **the premise is unmeasured on real
models.** `packages/testing/src/metrics/premise.ts` scores a run against a ground-truth
fixture, but the default suites run scripted auditors. A live evaluation runner and
recorded real-model measurements remain part of the completion plan. Every premise report
carries `interpretation: "smoke_test_only_not_proof"`. See
[`docs/evaluation.md`](docs/evaluation.md).

## Requirements

Node 22 (`>=22 <23`) and pnpm 10 (`>=10 <11`). No API key is needed to run the test
suites: the default suites make no network calls, and real-provider suites are
environment-gated and skipped unless their variables are set.

```bash
pnpm install
pnpm run ci # typecheck, lint, tests, example validation, design integrity
```

## Running it

`packages/runtime` composes the workspace packages into one `Orchestrator`. Both
interfaces call it — the CLI through `orchestratorCore`, the control plane through
`controlPlaneCore` — so there is one run lifecycle, not two.

```bash
pnpm build                                  # both entrypoints run from dist/

node apps/cli/dist/src/bin.js audit --preset audit-deep --full
node apps/server/dist/src/serve.js          # control plane on 127.0.0.1:4178
pnpm --filter @arbitra/web dev              # UI on 127.0.0.1:4173, proxied to the control plane
```

With the control plane up, the UI is addressable: `?run=<id>` opens a recorded run and
`?view=graph|issues|plan|feature|testing|evaluation|traces` opens a column-two view directly.
The trace browser filters recorded model attempts by node, model, protocol, outcome
and activity text. Select an attempt to inspect its identity, usage, failures, and
immutable input/output artifacts. Missing usage and cost remain labelled unavailable.

**With `models: {}`, the auditors are deterministic detectors.**
They produce real, evidence-grounded findings — every one cites a repository path and line
that validation checks — so the pipeline has something real to cluster, peer-review, verify and
plan over with no API key. They do not exercise the premise: every run they produce reports
`auditor_kind: scripted_auditors` and carries `interpretation: "smoke_test_only_not_proof"`.
To run models, configure `workflow.modelExecution` as described in the provider guide.
The model path uses independent discovery, bounded review, targeted verification,
planning and critique, with durable usage accounting and resume. Its source-only
security coverage is also reported degraded. A scripted run deliberately fails the CI quality gate
with `degraded_coverage`, even when no findings are produced; that is not a process crash.

Audit presets select three auditors (`audit-deep`), two (`audit-balanced` and
`diff-review`), or one (`diff-fast`). `diff-fast` skips peer review and verifies its
single-source findings deterministically. Repository, module, staged, working-tree and
revision-range scopes are supported. Resume checks the original repository snapshot;
replay creates a separate run from recorded discovery findings and leaves its source
unchanged.

## Repository layout

```text
apps/cli          command-line interface and CI exit codes
apps/server       localhost Fastify control plane (127.0.0.1:4178)
apps/web          four-column UI with a read-only workflow graph
packages/runtime  composition root: the one core the CLI and the server both call
packages/core     workflow runner, prompt compiler, preflight, renderer, replay
packages/workflow audit/feature/testing nodes, clustering, consensus, verification
packages/persistence  journal, artifact store, issue-op log, traces, metric queries
packages/providers    transports, model profiles, effort, scheduler, continuation
packages/harness      canonical harness adapter and profiles
packages/protocols    versioned protocol registry
packages/schemas      canonical schemas, provider projections, glyphs
packages/security     taint, exclusions, redaction, scanner, command policy
packages/tools        read-only repository tools and evidence bounds
packages/testing      fake transports, scripted auditors, premise scoring
docs/                 design language, brand assets, and this document set
examples/             six example run configurations and their validation gate
tooling/              ESLint rules that enforce architecture invariants
```

## Documentation set

| Document | Covers |
|---|---|
| [`docs/project-status.md`](docs/project-status.md) | current capabilities, limitations and dated verification evidence |
| [`docs/completion-plan.md`](docs/completion-plan.md) | remaining implementation and validation steps, dependencies and acceptance criteria |
| [`docs/architecture.md`](docs/architecture.md) | package layout, layering, the core loop, v1.1 extension points |
| [`docs/security.md`](docs/security.md) | trust, taint, control plane, suppression, command policy |
| [`docs/workflows.md`](docs/workflows.md) | the graph model, node kinds, the three modes, presets |
| [`docs/provider-model.md`](docs/provider-model.md) | model profiles, transports, effort, structured output |
| [`docs/harness.md`](docs/harness.md) | canonical harness, harness profiles, native mode |
| [`docs/task-ir.md`](docs/task-ir.md) | Task IR, Validation Contract, Plan IR, traceability |
| [`docs/durability.md`](docs/durability.md) | journal, activities, resume, crash semantics |
| [`docs/evaluation.md`](docs/evaluation.md) | corpora, metrics, replay, the premise test |

Presentation is governed by [`docs/DESIGN-LANGUAGE.md`](docs/DESIGN-LANGUAGE.md) and the
assets in [`docs/brand/`](docs/brand). Those are normative inputs: this document set
references them and never restates the palette as a second source. `pnpm run design:check`
verifies the implementation has not drifted from them.

## Commands

```bash
pnpm test                  # every workspace package's suite
pnpm run validate:examples # the six example configurations against the shipped schema
pnpm run design:check      # design token, shared-glyph and brand-asset integrity
pnpm --filter @arbitra/web e2e  # browser scenarios (Chromium, Firefox, WebKit); see docs/qa/p10
pnpm lint                  # ESLint, including the architecture rules in tooling/
pnpm typecheck
pnpm build
```

The CLI's own commands are documented in [`docs/architecture.md`](docs/architecture.md#cli).

## Example configurations

Six schema-example configurations live in [`examples/`](examples):

```text
examples/audit-balanced.json
examples/audit-deep.json
examples/diff-fast.json
examples/diff-review.json
examples/feature-simple.json
examples/testing-plan.json
```

The public runtime also supports `testing-execute`; its execution configuration is
documented in [Testing mode](docs/workflows.md#testing-mode). The six examples do not
cover every executable preset or supply complete live-provider settings.

Every one validates against `runConfigSchema` from
`packages/schemas/src/config.ts` in `pnpm run validate:examples`, which also runs negative
controls proving a stale example fails.

**Model identity in the examples is a placeholder.** `modelId` and `family` read
`replace-with-your-model-id` / `replace-with-your-model-family`, and both context and
output limits are `null`. arbitra does not ship a table of provider model names,
capabilities or prices: those change, and inventing them would be exactly the fabrication
the product refuses elsewhere. Fill them in from your provider's own documentation when
using the provider libraries. These examples validate schema coverage; they are not
model-backed CLI smoke tests. See [`docs/provider-model.md`](docs/provider-model.md).

No example carries a credential, and none can: `ConfigStore.validate`
(`packages/core/src/config/config-store.ts`) rejects any key ending in `apiKey`, `secret`,
`password`, `credential` or `accessToken` that holds a value, and requires any
`…EnvVar`-shaped key to hold an uppercase environment-variable name rather than the secret
itself. Credentials are resolved from the environment at call time and never reach disk or
an HTTP response. See [`docs/security.md`](docs/security.md).

## Licence

See [`LICENSE.md`](LICENSE.md).
