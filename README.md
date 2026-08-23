# arbitra

Just another multi-model software audit and implementation orchestrator. I was too lazy to do it manually, and others didn't really work for me, so I figured, "fine, I will do it myself".

arbitra runs several independent models over one repository snapshot, makes them argue in
a structured way, resolves what it can deterministically, and emits a plan a different
agent can execute. Its premise — that independent auditors find defects a single model
misses — is treated as a hypothesis the system measures, not as a marketing claim.

## Status

v1 is implemented across the workspace packages listed in
[`docs/architecture.md`](docs/architecture.md). The v1.1 extension points are listed there
too, and are explicitly **not implemented** — no document in this set shows a v1.1 feature
as working.

One thing is worth knowing before reading further: **the premise is unmeasured on real
models.** `packages/testing/src/metrics/premise.ts` scores a run against a ground-truth
fixture, but the default suites run scripted auditors. Real-model measurement is
environment-gated and skipped by default, and every premise report the system produces
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

## Repository layout

```text
apps/cli          command-line interface and CI exit codes
apps/server       localhost Fastify control plane (127.0.0.1:4178)
apps/web          four-column read-only UI
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
docs/                 specification, design language, brand, and this document set
examples/             six example run configurations and their validation gate
tooling/              ESLint rules that enforce architecture invariants
```

## Documentation set

| Document | Covers |
|---|---|
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
pnpm lint                  # ESLint, including the architecture rules in tooling/
pnpm typecheck
pnpm build
```

The CLI's own commands are documented in [`docs/architecture.md`](docs/architecture.md#cli).

## Example configurations

Six configurations live in [`examples/`](examples), one per shipped workflow preset:

```text
examples/audit-balanced.json
examples/audit-deep.json
examples/diff-fast.json
examples/diff-review.json
examples/feature-simple.json
examples/testing-plan.json
```

Every one validates against `runConfigSchema` from
`packages/schemas/src/config.ts` in `pnpm run validate:examples`, which also runs negative
controls proving a stale example fails.

**Model identity in the examples is a placeholder.** `modelId` and `family` read
`replace-with-your-model-id` / `replace-with-your-model-family`, and both context and
output limits are `null`. arbitra does not ship a table of provider model names,
capabilities or prices: those change, and inventing them would be exactly the fabrication
the product refuses elsewhere. Fill them in from your provider's own documentation before
running. See [`docs/provider-model.md`](docs/provider-model.md).

No example carries a credential, and none can: `ConfigStore.validate`
(`packages/core/src/config/config-store.ts`) rejects any key ending in `apiKey`, `secret`,
`password`, `credential` or `accessToken` that holds a value, and requires any
`…EnvVar`-shaped key to hold an uppercase environment-variable name rather than the secret
itself. Credentials are resolved from the environment at call time and never reach disk or
an HTTP response. See [`docs/security.md`](docs/security.md).

## Licence

See [`LICENSE.md`](LICENSE.md).
