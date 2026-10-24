# arbitra

arbitra has AI models from different vendors audit your code project side by side, checks each issue against the
source before it plans a fix, and hands you the plan as prompts a coding agent can carry out. It runs on your own
computer, uses the Claude and ChatGPT subscriptions you already have, and never changes your code.

**Try it:** download the [latest release](https://github.com/ServesYouRice/arbitra/releases/latest) (a single `.exe`
on Windows, or the zip with Node.js 22.13 or newer anywhere) and follow [TESTERS.md](TESTERS.md). What leaves your
machine during a run is on one page: [privacy](docs/privacy.md).

## What it found on real projects

The maintainer's own projects, October 2026, each a single run with Claude Opus 5.5, GPT-6.1 Sol and Gemini 3.8
Flash. "Confirmed" means the verifier model found the defect in the source; lower-severity reports are listed but not
checked.

| Project | Lines | Confirmed issues | Time | Tokens | Tokens per confirmed issue |
|---|---|---|---|---|---|
| A web app (rokavatar) | 10,716 | 23 (3 high) | 110 min | 15.6M | 677K |
| A blog with a CMS (blog) | 14,204 | 41 (3 high) | 63 min | 13.1M | 320K |
| A comments service (commentanywhere) | 11,719 | 51 (1 critical, 7 high) | 40 min | 7.5M | 146K |
| A screen-sharing app ([nextra](https://github.com/ServesYouRice/nextra)) | 38,967 | 126 (1 critical, 21 high) | 105 min | 26.8M | 213K |

The first two ran with a peer-review round between the auditors, which later versions leave out.

**Proven, not only confirmed:** on nextra, the plan's prompts for its critical issue (any viewer with the public link
could get the host's operator rights) and for a high one (one malformed message from a viewer stopped the server) each
led to a test that failed on the unchanged code and passed after the fix
([nextra PR #76](https://github.com/ServesYouRice/nextra/pull/76)). The other issues have not been carried out yet.

**What it costs and what it is not:** a run can use a third of a Claude Max five-hour window, so start with a small
project. A confirmed issue is a model's reading of the code, not a test, until a plan is carried out. Gemini is
optional: Google's terms do not support driving its CLI from another application on consumer plans.

Whether models from several vendors find defects one model misses is a question arbitra measures and publishes,
losses included, not a selling point: see [what is measured so far](#what-is-measured-so-far).

## Status

arbitra is a **beta** runtime for **model-backed Audit, Feature planning, Testing planning
and guarded Testing execution**, alongside scripted Audit. Start with
[`docs/setup.md`](docs/setup.md): it walks through model-backed templates for every mode,
endpoint and role binding, and the preflight checks that run before any spend.

- **Audit** runs independent discovery, bounded review, verification, planning and
  criticism. It can reuse unchanged work from a prior run (`--incremental`) and can run
  operator-authored workflow graphs saved from the web editor.
- **Feature** runs durable requirements checkpoints, risk-directed review, planning and an
  exportable implementation handoff; see [`docs/workflows.md`](docs/workflows.md#feature-mode).
- **Testing** plans from grounded risk analysis and, when explicitly authorized, executes in
  isolated worktrees with bounded repair, verified change export and optional bounded
  advisors. The source checkout is never modified.
- Runs can be replayed with mode-specific reuse contracts, and gates and human checkpoints
  are durable and versioned across CLI, HTTP and the web UI.

Models run through API keys or, per role, through the vendors' own CLIs signed in with a
Claude, ChatGPT or Google AI subscription ([setup](docs/setup.md#subscription-clis-instead-of-api-keys)).

**Beta means:** everything above passes the full local check with injected providers and sandboxes, and the
web UI passes browser acceptance on Chromium, Firefox and WebKit. Every public workflow
has also run live on subscription models, Gemini has run on its API, Docker acceptance ran
on a real engine, and the native Claude Code adapter passed conformance against the real
CLI. The OpenAI and Anthropic API protocols and the batch drivers have not run live; that
work is [deferred](#deferred-to-a-later-phase-the-paid-api-bundle). See the
[verification evidence](docs/qa/README.md) for what was measured, and
[remaining work](WORK-REMAINING.md) for what remains.

### What is measured so far

- **Small fixtures (P06, 10 planted defects).** Claude Sonnet 5, GPT-5.6 Luna and Gemini 3.8 Flash: one Claude run
  found 25 of 30 defect chances, and three pooled runs found all 10, whether they were repeated Claude runs or three
  vendors. At that size no comparison decides anything ([record](docs/qa/p06-subscription/README.md)).
- **A harder private benchmark, pilot only (P20, 3 projects, 21 planted defects).** Wherever three pooled Opus 5.5
  runs missed a planted defect, a panel of Opus 5.5, GPT-6.1 Sol and Gemini 3.8 Flash found it, in about 0.6 times
  their time and 0.7 times their tokens. Two caveats: 21 defects make this an estimate, not a test, and the pilot
  projects were made harder until one Opus run missed defects, which favours a panel with other vendors in it. The
  held-out part (9 projects, 63 defects) has not been run
  ([completion plan](docs/completion-plan.md#p20--stress-test-the-premise-on-a-hard-benchmark)).
- **Real projects:** the [table above](#what-it-found-on-real-projects). Across the four runs, issues only one model
  found: Opus 88, Sol 47, Gemini 7, for Gemini's 1 to 2 million discovery tokens a run. Single runs are not a
  measurement of the vendors; every run's report and Evaluation tab show these numbers, so they add up across projects.

"Confirmed" means a verifier model found the defect in the source. Proof by execution comes from carrying out the
plan: each prompt asks for a test that fails before the fix, and the run's report reads the results back
([design audit](docs/design-audit.md#what-changes), item 16). Runs without models use scripted detectors and are
labelled `smoke_test_only_not_proof` ([evaluation](docs/evaluation.md)).

### Deferred to a later phase: the paid-API bundle

Three pieces of live validation need funded API accounts, which the project's own testing does not use: the
OpenAI Responses, OpenAI Chat and Anthropic Messages protocols run live (P03), oversized-context handling at real
models' limits (P08), and each batch driver on a funded account (P15). Their code is in place and covered by
injected-provider tests; only the live evidence is missing. The
[completion plan](docs/completion-plan.md#deferred-the-paid-api-bundle) lists what exists, the acceptance criteria
and how to run each part.

## Requirements

Node 22.13 or newer (`>=22.13`; the whole check passes on 22.13, 24, 25 and 26) and pnpm 10 (`>=10 <11`). No API key is needed to run the test
suites: the default suites make no network calls, and real-provider suites are
environment-gated and skipped unless their variables are set.

```bash
pnpm install
pnpm run ci # typecheck, lint, tests, example validation, design integrity
```

**New here? Follow [Getting started](docs/setup.md).** It covers validating every
configuration, running the credential-free smoke checks, and the explicit edits a live
model run requires.

## Running it

**To just use it:** on Windows, download `arbitra-<version>-windows.exe` from the
[latest release](https://github.com/ServesYouRice/arbitra/releases/latest) and double-click it; it needs nothing
installed. Anywhere else, download the zip and, with Node.js 22.13 or newer installed, double-click `arbitra.cmd`
(Windows) or `arbitra.command` (macOS, Linux). It installs and builds on first start. Either way the app opens on
<http://127.0.0.1:4178>.
[`TESTERS.md`](TESTERS.md) walks a first audit through.

`packages/runtime` composes the workspace packages into one `Orchestrator`. Both
interfaces call it — the CLI through `orchestratorCore`, the control plane through
`controlPlaneCore` — so there is one run lifecycle, not two.

```bash
pnpm build                                  # both entrypoints run from dist/

node apps/cli/dist/src/bin.js audit --preset audit-deep --module packages/tools  # --full: repositories up to 400 source files
node apps/server/dist/src/serve.js          # the app and its control plane on 127.0.0.1:4178
pnpm --filter @arbitra/web dev              # for UI work: a dev server on 127.0.0.1:4173, proxied to the control plane
```

With the control plane up, the UI opens on the list of runs. **New run** prepares a
configuration from a template or a saved one, lists what the template leaves to fill in,
checks it with the orchestrator's preflight and estimate, then saves and starts it.
**Workflows** is the graph editor. A run's page shows its state, the gate, what executed it
(models, or scripted detectors that make no model call) and any decision it waits on, then
the tabs its mode has: Overview, Issues or Requirements, Plan, Execution (Testing),
Activity (the graph, every model attempt and every artifact) and Evaluation. Every place is
an address: `?run=<id>&view=<tab>&item=<kind>:<id>` opens a run on a tab with an issue, node,
plan step, attempt or artifact selected, and the older `?view=graph|feature|testing|traces`
links still land on the matching tab. Missing usage and cost remain labelled unavailable.

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
single-source findings; the plan addresses the ones verification confirms, and says that no
second auditor checked them. Repository, module, staged, working-tree and
revision-range scopes are supported. Resume checks the original repository snapshot;
replay creates a separate run from recorded discovery findings and leaves its source
unchanged.

## Repository layout

```text
apps/cli          command-line interface and its exit codes
apps/server       localhost Fastify control plane (127.0.0.1:4178)
apps/web          operator UI: run list, run pages, new-run form, workflow editor
packages/runtime  composition root: the one core the CLI and the server both call
packages/core     workflow runner, prompt compiler, preflight, renderer, replay
packages/workflow audit/feature/testing nodes, clustering, consensus, verification
packages/persistence  journal, artifact store, traces, evaluation corpora, metric queries
packages/providers    transports, model profiles, effort, scheduler, continuation
packages/harness      canonical harness adapter and profiles
packages/protocols    versioned protocol registry
packages/schemas      canonical schemas and glyphs
packages/security     redaction, untrusted-text framing, path guard, write leases
packages/tools        read-only repository tools and output bounds
packages/testing      scripted auditors, premise evaluation, handoff acceptance
docs/                 design language, brand assets, and this document set
examples/             schema-only examples, model-backed templates and their validation gate
tooling/              architecture lint rules, live-run scripts, packaging, sandbox image, evaluation tools
```

## Documentation set

| Document | Covers |
|---|---|
| [`docs/setup.md`](docs/setup.md) | getting started: validation, smoke checks, live-run preparation, preflight codes, handoffs |
| [`docs/qa/README.md`](docs/qa/README.md) | dated verification evidence per item: checks, Docker, browsers, live providers, evaluations |
| [`docs/completion-plan.md`](docs/completion-plan.md) | remaining implementation and validation steps, dependencies and acceptance criteria |
| [`docs/architecture.md`](docs/architecture.md) | package layout, layering, the core loop, v1.1 extension points |
| [`docs/privacy.md`](docs/privacy.md) | what leaves your machine, to whom, and how to send less |
| [`docs/security.md`](docs/security.md) | untrusted text, control plane, repository boundary, sandbox, secrets |
| [`docs/workflows.md`](docs/workflows.md) | the graph model, node kinds, the three modes, presets |
| [`docs/provider-model.md`](docs/provider-model.md) | model profiles, transports, effort, structured output |
| [`docs/harness.md`](docs/harness.md) | canonical harness, harness profiles, native mode |
| [`docs/task-ir.md`](docs/task-ir.md) | Task IR, Validation Contract, Plan IR, traceability |
| [`docs/durability.md`](docs/durability.md) | journal, activities, resume, crash semantics |
| [`docs/evaluation.md`](docs/evaluation.md) | corpora, metrics, replay, the premise test |
| [`docs/research.md`](docs/research.md) | the public research the design was checked against: model labs, comparable tools, papers |
| [`docs/design-audit.md`](docs/design-audit.md) | the October 14 audit of every stage against the labs' own pipelines, and what changes |

Presentation is governed by [`docs/DESIGN-LANGUAGE.md`](docs/DESIGN-LANGUAGE.md) and the
assets in [`docs/brand/`](docs/brand). Those are normative inputs: this document set
references them and never restates the palette as a second source. `pnpm run design:check`
verifies the implementation has not drifted from them.

## Commands

```bash
pnpm test                  # every workspace package's suite
pnpm run validate:examples # schema-only examples and model-backed templates, with negative controls
pnpm run smoke:examples    # model-backed templates through the public runtime, credential-free
pnpm run design:check      # design token, shared-glyph and brand-asset integrity
pnpm --filter @arbitra/web e2e  # browser scenarios (Chromium, Firefox, WebKit); see docs/qa/p10
pnpm lint                  # ESLint, including the architecture rules in tooling/
pnpm typecheck
pnpm build
```

The CLI's own commands are documented in [`docs/architecture.md`](docs/architecture.md#cli).

## Example configurations

There are two kinds, and they are kept apart deliberately:

- **Schema-only examples** — six files in [`examples/`](examples)
  (`audit-balanced`, `audit-deep`, `diff-fast`, `diff-review`, `feature-simple`,
  `testing-plan`). They show every run-configuration field and preset. They carry no
  `workflow.modelExecution`, so runtime preflight rejects them for model runs.
- **Model-backed templates** — twelve files in [`examples/model-backed/`](examples/model-backed):
  mixed-provider and compatible-endpoint Audit, interactive and automatic Feature,
  Testing plan and Testing execute on API keys, covering all four wire protocols, and the
  same five modes on subscription CLIs (`subscription-*.json`, with a Gemini variant of the
  Audit). They
  pass runtime configuration preflight, and `pnpm run smoke:examples` runs each one
  unmodified through the public runtime with fixture transports, so no credential,
  network or Docker engine is needed.

`pnpm run validate:examples` parses both sets with `runConfigSchema` from
`packages/schemas/src/config.ts`, checks the templates against runtime preflight, and
runs negative controls proving a stale example fails.

**Model identity is a placeholder in both sets.** `modelId` and `family` read
`replace-with-your-model-id` / `replace-with-your-model-family`, and both context and
output limits are `null`. The web app's New run page fills them in from a small catalogue of
the subscription CLIs' models (`apps/web/src/pages/new-run/model-catalog.ts`: IDs, tiers,
limits and effort words, no prices). A live run refuses placeholder identities
(`MODEL_IDENTITY_PLACEHOLDER`) and missing credentials before any request is sent. The
templates name dedicated `ARBITRA_*` credential variables, so nothing spends or writes
implicitly. See [Getting started](docs/setup.md) and
[`docs/provider-model.md`](docs/provider-model.md).

No example carries a credential, and none can: `ConfigStore.validate`
(`packages/core/src/config/config-store.ts`) rejects any key ending in `apiKey`, `secret`,
`password`, `credential` or `accessToken` that holds a value, and requires any
`…EnvVar`-shaped key to hold an uppercase environment-variable name rather than the secret
itself. Credentials are resolved from the environment at call time and never reach disk or
an HTTP response. See [`docs/security.md`](docs/security.md).

## Why it exists

Running the same review across several models by hand was slow, and no existing tool combined them, so arbitra was
built for it. Its design was checked against the labs' published guidance and review pipelines: [research](docs/research.md)
and the [design audit](docs/design-audit.md).

## Licence

See [`LICENSE.md`](LICENSE.md).
