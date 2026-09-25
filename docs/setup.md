# Getting started

This guide takes a fresh checkout to validated configurations and credential-free smoke
checks, then explains what to change before a live model run. Nothing here spends money
or grants write access unless you make the explicit edits described in
[Preparing a live run](#preparing-a-live-run).

## 1. Install and verify

Requirements: Node 22 (`>=22 <23`), pnpm 10 (`>=10 <11`) and git. Docker is needed only
for Testing execution and optional Audit verification checks. Provider accounts are
needed only for live runs.

```bash
pnpm install --frozen-lockfile
pnpm run ci      # typecheck, lint, all tests, example validation, design integrity
pnpm build       # the CLI and server run from dist/
```

The default suites make no network calls and need no credentials.

## 2. Two kinds of example

| Location | Kind | Use |
|---|---|---|
| [`examples/*.json`](../examples) | **Schema-only examples** | Show every run-configuration field and preset. They have no `workflow.modelExecution`, so runtime preflight rejects them for model runs (`RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED`). |
| [`examples/model-backed/*.json`](../examples/model-backed) | **Model-backed templates** | Complete configurations that pass runtime configuration preflight and are smoke-run, unmodified, through the public runtime. |

The model-backed templates:

| Template | Mode / preset | Wire protocols | Credential variables |
|---|---|---|---|
| `audit-mixed-providers.json` | Audit / `audit-deep` (3 auditors, critic) | OpenAI Responses, Anthropic Messages, Gemini Native | `ARBITRA_OPENAI_API_KEY`, `ARBITRA_ANTHROPIC_API_KEY`, `ARBITRA_GEMINI_API_KEY` |
| `audit-compatible-chat.json` | Audit / `audit-balanced`, module scope `src` | OpenAI Chat Completions (two compatible endpoints) | `ARBITRA_COMPATIBLE_API_KEY`, `ARBITRA_COMPATIBLE_B_API_KEY` |
| `feature-interactive.json` | Feature / `feature-simple`, interactive | Responses, Messages, Gemini | OpenAI, Anthropic, Gemini variables |
| `feature-automatic.json` | Feature / `feature-simple`, automatic | Messages, Chat Completions, Gemini | Anthropic, compatible, Gemini variables |
| `testing-plan.json` | Testing / `testing-plan` (read-only) | Gemini, Chat Completions | Gemini, compatible variables |
| `testing-execute.json` | Testing / `testing-execute` (guarded writes) | Responses, Messages | OpenAI, Anthropic variables |

Together they cover all four wire protocols; `audit-mixed-providers` is the mixed-provider
configuration. Every template names a placeholder model (`replace-with-your-model-id`)
and uses dedicated `ARBITRA_*` variable names, so an unrelated provider key already
exported in your shell cannot enable a run.

## 3. Validate every configuration

```bash
for file in examples/*.json examples/model-backed/*.json; do
  node apps/cli/dist/src/bin.js validate "$file"
done
pnpm run validate:examples   # the same gate CI runs, including negative controls
```

`validate` runs the runtime preflight and reports two things separately:

- **configuration** — schema, preset/mode agreement, roles, capabilities, effort,
  independence and write authority. Any configuration error exits `1`.
- **environment** — credential variables (presence only; values are never read into
  output), placeholder model identities, and the local Docker engine and image when
  the configuration needs them. These are reported but do not fail `validate`;
  `run` refuses to start while any remains.

The schema-only examples report `configuration: invalid` (exit `1`) with
`RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED`. This is expected: they are schema
coverage, not runnable model configurations. On a fresh checkout the model-backed templates
report `configuration: valid; environment: not ready` (exit `0`) with actionable lines
such as:

```text
  - [error environment] PROVIDER_CREDENTIAL_MISSING:openai at workflow.modelExecution.endpoints.1.apiKeyEnvVar: Environment variable ARBITRA_OPENAI_API_KEY is not set for endpoint openai (profiles analyst). ...
  - [error environment] SANDBOX_ENGINE_UNAVAILABLE at $environment: A running local Linux Docker engine is required for workflow.testing.execution.verification.execution. ... Detail: docker executable not found on PATH
```

Add `--json` for machine-readable diagnostics (`code`, `severity`, `scope`, `path`,
`message`).

## 4. Run the credential-free smoke checks

```bash
pnpm run smoke:examples
```

This runs [`example-smoke.test.ts`](../packages/runtime/test/example-smoke.test.ts) and
[`preflight.test.ts`](../packages/runtime/test/preflight.test.ts). Each model-backed
template is loaded unmodified and executed through the public CLI core and
`Orchestrator` against a small fixture repository. Only three things are replaced: the
HTTP client (a fixture that answers each stage in that protocol's native wire format),
the credential lookup, and the Docker sandbox. No network, credential or Docker engine
is used.

The smoke checks cover:

- both Audit templates completing with a durable Plan IR. The source-only security
  coverage is reported degraded, so the CI gate reports `degraded_coverage`, as documented;
- interactive Feature pausing in `BLOCKED`, approval through the CLI core, resume and
  export of the implementation handoff;
- automatic Feature and Testing plan completing with a passing gate and no source changes;
- Testing execution writing only the granted file in an isolated worktree, running the
  bound (fixture) check, and exporting a verified change set while the checkout stays unchanged;
- all four wire protocols across the set.

They prove configuration, preflight and runtime wiring. They do not measure model quality,
provider conformance or real Docker isolation; those remain completion-plan items
([P03](completion-plan.md#p03--build-and-run-live-provider-acceptance),
[P04](completion-plan.md#p04--validate-the-actual-docker-boundary)).

Without any configuration you can also run the scripted Audit, which uses deterministic
detectors and no provider:

```bash
node apps/cli/dist/src/bin.js audit --preset audit-balanced --module packages/tools
```

It exits `1` with `degraded_coverage` by design; see the [README](../README.md#running-it).
Snapshots are limited to 400 source files, so `--full` on this repository fails with
`REPOSITORY_FILE_LIMIT_EXCEEDED:400`. Use `--full` on smaller repositories, or narrow the
scope with `--module <path>`.

## Preparing a live run

Copy a template, then make each of these explicit edits. Until you do, `run` refuses
to start and dispatches nothing.

1. **Model identity.** Replace `modelId` and `family` in every profile.
   `MODEL_IDENTITY_PLACEHOLDER:<profile>` blocks live runs until you do.
2. **Capability provenance.** Review `supports`, `limits`, `effort`, `quirks`,
   `capabilityTier` and `structuredOutputDialect` against your provider's own
   documentation. arbitra ships no model catalogue and infers nothing: these values
   are your declaration. The runtime enforces them before dispatch (tool use,
   output/context limits, effort collapse) and records requested and resolved effort on every
   trace. The template values are conservative starting points, not claims about any
   model: `limits` are `null` (unknown, never treated as zero), `effort.supported` is
   `low`/`medium`/`high` with an explicit `xhigh → high` collapse, and `effort.params` is
   empty, so no provider-specific effort field is sent until you add one.
3. **Endpoints and credentials.** Adjust each `workflow.modelExecution.endpoints[]`
   `endpoint` URL (the compatible templates point at `http://127.0.0.1:8000/v1` and
   `:8001/v1`), then export each named `apiKeyEnvVar` in the shell that runs arbitra. The
   configuration may only name variables. A literal key is rejected
   (`RESOLVED_CREDENTIAL_FORBIDDEN`), and values are resolved at dispatch and never
   persisted or returned.
4. **Limits.** Lower the budget limits below for a first run.
5. **Scope and request.** Set `scope` and the Feature `request` or Testing `goal`.

Then:

```bash
node apps/cli/dist/src/bin.js validate my-config.json   # expect environment: ready
node apps/cli/dist/src/bin.js estimate my-config.json   # no provider calls
node apps/cli/dist/src/bin.js run my-config.json
```

Run from the repository you want to analyze. `run` uses the current directory as the
repository and stores runs under `.runs/`. That directory is excluded from snapshots.

### Endpoint and role binding

Every profile in `models` must be bound in `workflow.modelExecution.modelEndpoints` to an
endpoint whose `providerId` and `transport` match the profile's `provider` and
`transport`. Each provider needs a `rateLimits` entry. Several endpoints may share a
protocol, for example two OpenAI-compatible services. They keep separate URLs,
credentials and continuation state. Roles are always named explicitly:

| Mode | Where | Required |
|---|---|---|
| Audit | `models` keys | `auditor-a`, `auditor-b` (and `auditor-c` for `audit-deep`) — the preset's discovery nodes |
| Audit | `workflow.modelExecution.roles` | `planner`, `verifier`; `critic` for presets with a critic |
| Feature | `workflow.feature.roles` | `requirements`, `exploration`, `planner`; `reviewers` (two or more distinct `independenceGroup`s) and `critic` (independent of the planner) for anything above low risk |
| Testing | `workflow.testing.roles` | `analyst` (capability tier `frontier`), `planner` |
| Testing execute | `workflow.testing.execution.models` | `fast`, `balanced`, `frontier` writers — tool-capable and at or above that tier |

`independenceGroup` is your statement of which profiles are genuinely independent. Two
aliases of one model are not independent auditors or reviewers.

### Budget limits

These limits are enforced:

| Setting | Effect |
|---|---|
| `workflow.modelExecution.maximumTokens` | Durable run-wide admission budget in conservative estimated tokens (derived from request bytes, so it overstates provider tokens). Reservations are saved before dispatch; exhaustion suspends the run (`SUSPENDED_BUDGET`) rather than overspending. |
| `maximumOutputTokens`, `maximumContextTokens`, `maximumDiscoveryTokens` | Per-request output reserve and context caps. |
| `maximumRetries`, `timeoutMs`, `rateLimits` | Retry count, per-request timeout, per-provider pacing and concurrency. |
| `verification.maxModelQuestionsPerRound` | Targeted verification questions per round (0 disables). |
| `verification.execution.maximumRuns`, Testing `maximumAttempts` | Sandbox check runs and writer attempts. |

The `budgets` object (for example `maximumCostUsd`) is not enforced by the runtime, and
monetary cost is reported as unknown. Preflight therefore refuses a model-backed run whose
`budgets` is non-empty (`BUDGETS_NOT_ENFORCED`) rather than let it run under a cap that does
nothing; a scripted Audit only gets a warning. Every shipped example leaves `budgets` empty.

### Source scope

`scope.kind` is `repository`, `module` (`modules` are repository-relative directories,
such as `["src"]`) or `diff` (`diffMode` `staged`, `working_tree` or `range` with
`base`/`head` or `revisionRange`). Snapshots read source files with known source
extensions, up to 400 files and 512 KiB per file. Snapshots skip hidden directories
(except `.github`), `.git`, `node_modules`, `dist`, `build`, `coverage` and `.runs`.
Testing snapshots also include test metadata such as `package.json`. `security` (including
`excludeGlobs`) and `contextPolicies` are not applied by the runtime; preflight warns when
they are non-empty (`SECURITY_SETTINGS_NOT_ENFORCED`, `CONTEXT_POLICIES_NOT_ENFORCED`).
To exclude paths, use `scope.exclude`: repository-relative path prefixes removed from the snapshot.
Use `scope` to narrow what is read.

### Native mode

`harness.mode` defaults to `canonical`. `native` is accepted only for a Testing execute run,
and only the Testing writer runs natively; analysis, planning and verification stay
canonical. The single supported harness is Claude Code (headless `claude -p`, versions
`>=2.0.0 <3.0.0`), declared but **not yet conformance-verified** against the real CLI
(preflight warns `NATIVE_HARNESS_UNVERIFIED`). See
[harness.md](harness.md#native-harness-adapters) for the matrix and enforcement.

```json
"harness": {
  "mode": "native",
  "native": {
    "harnessId": "claude-code",
    "stages": ["testing-writer"],
    "apiKeyEnvVar": "ARBITRA_CLAUDE_CODE_API_KEY",
    "timeoutMs": 600000,
    "maximumTurns": 20,
    "maximumToolCalls": 40,
    "maximumTokensPerRun": 400000
  }
}
```

Host setup (never run configuration):

- `ARBITRA_CLAUDE_CODE_EXECUTABLE` — absolute path of the `claude` executable. Its
  `--version` is probed before every native run and must fall in the supported range.
- The variable named by `apiKeyEnvVar` — passed to the native process as
  `ANTHROPIC_API_KEY`, its only credential.
- Every writer profile in `workflow.testing.execution.models` must be an `anthropic`
  profile; its `modelId` is passed as `--model`. Advisors are refused in native mode.
- Optional `tools` (default `Read, Glob, Grep, Edit, Write`); shell, network, subagent,
  MCP and unknown tools are refused. `maximumTokensPerRun` is reserved against
  `workflow.modelExecution.maximumTokens` before launch and stays charged in full when the
  harness reports no usage.

Opt-in conformance against the real CLI (spends tokens):
`ARBITRA_NATIVE_HARNESS_CONFORMANCE=1 ARBITRA_CLAUDE_CODE_EXECUTABLE=/path/to/claude
ARBITRA_NATIVE_CONFORMANCE_MODEL=<model> ANTHROPIC_API_KEY=… pnpm --filter @arbitra/runtime exec
vitest run test/native-harness.conformance.test.ts`. Without those variables it is skipped.

### Docker prerequisites (Testing execute, Audit verification checks)

- A running local Linux Docker engine: `docker info --format '{{.OSType}}'` prints `linux`.
  Every sandbox command uses an empty Docker CLI configuration, so the engine's socket is
  resolved first from `DOCKER_HOST`, else from the current context
  (`docker context inspect`), and passed as `--host`. This is what makes Docker Desktop,
  Colima and OrbStack work when `/var/run/docker.sock` is absent. Only `unix://` and
  `npipe://` endpoints are used; a `tcp://` or `ssh://` engine is refused, because it
  cannot see the bind-mounted snapshot and is not the boundary being verified.
- The image is referenced as `name@sha256:<64 hex>` and already present locally:
  `docker image inspect <reference>` succeeds. arbitra never pulls or builds images.
  Preflight uses exactly these two read-only commands.
- The image contains every test dependency. Containers run with no network and a
  read-only snapshot, so nothing is installed at run time.
  [tooling/sandbox-image](../tooling/sandbox-image/Dockerfile) builds a Node 22 image with
  vitest preinstalled; its header shows how to obtain the digest reference.
- A `docker run` that the engine itself refuses (absent image, missing entrypoint:
  exit 125/126/127 with a `docker:` error) is recorded as `unavailable`, which makes the
  check incomplete rather than failed, so repair is not spent on an environment fault.

Real-container acceptance (P04, and the P07 repair cases against real containers):

```bash
docker build -t arbitra-sandbox-node tooling/sandbox-image
export ARBITRA_DOCKER_ACCEPTANCE=1
export ARBITRA_DOCKER_IMAGE="arbitra-sandbox-node@$(docker image inspect --format '{{.Id}}' arbitra-sandbox-node)"
pnpm --filter @arbitra/runtime exec vitest run test/docker-sandbox.acceptance.test.ts test/testing-repair.test.ts
```

Missing engine or image is a start-blocking error for Testing execution
(`SANDBOX_ENGINE_UNAVAILABLE`, `SANDBOX_IMAGE_UNAVAILABLE:<image>`). For Audit
verification checks it is a warning, because unavailable checks are recorded as
coverage gaps.

### Write authority (Testing execute only)

Only `testing-execute.json` grants write authority, and only to a disposable worktree.
The source checkout is never modified. The operator supplies it explicitly:

- `authorization.partitions[].paths` are exact repository-relative file paths. Directories,
  globs and control-plane paths are rejected (`TESTING_WRITE_PATH_INVALID`). Every granted
  path must appear in the `sourcePaths` of a command-bound check
  (`TESTING_WRITE_WITHOUT_VERIFICATION_CHECK`), or its changes could never be verified.
- `authorization.tasks[]` grants exact planned task IDs. Execution re-plans in the same
  run, so run `testing-plan` first, inspect the task IDs and write paths in its handoff,
  and grant those. If the plan does not match the grants, the run fails before any
  worktree is created with `TESTING_WRITE_AUTHORIZATION_INCOMPLETE`, naming the ungranted
  and unknown task IDs. Planning tokens have already been spent by then.
- `verification.bindings[]` bind each planned command to an allowlisted check and state
  its authorization (`repository_script`, `allowlisted` or `operator_approved`).

## Consuming handoffs

Handoffs stay inside the run. Nothing is written to your repository. Export a run with:

```bash
node apps/cli/dist/src/bin.js export <run-id> --json > run.json
```

`result.artifacts` maps artifact kinds to records whose `content` is the artifact's JSON text:

| Workflow | Artifact | Contents |
|---|---|---|
| Audit | `plan-ir`, `canonical-issues` | Plan IR (tasks, validation contract, traceability) and the evidence-backed issues it addresses |
| Feature, Testing plan | `implementation` | A file tree: `manifest.json`, `AGENTS.md`, `README.md`, `context/`, `issues/`, `tasks/<id>/task.md`, `validation/`, `execution/`, `progress.schema.json`, `progress.jsonl` |
| Testing execute | `testing-execution-completion`, `testing-change-set-*` | The verified change set. Each file has `expectedHash`, `contentHash` and UTF-8 `content` |

To materialize an implementation tree for an executing agent:

```bash
node -e '
const fs = require("node:fs"), path = require("node:path");
const [runFile, target] = process.argv.slice(1);
const tree = JSON.parse(JSON.parse(fs.readFileSync(runFile, "utf8")).result.artifacts.implementation.content);
for (const [name, content] of Object.entries(tree)) {
  const destination = path.resolve(target, name);
  if (!destination.startsWith(path.resolve(target) + path.sep)) throw new Error("unsafe path " + name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, { flag: "wx" });
}' run.json handoff/
```

Task commands in the tree carry `executionPolicy: "requires_approval"`. The consuming
executor still decides command policy and write authority.

A verified Testing change set is applied only on request, to a checkout you name:

```bash
node apps/cli/dist/src/bin.js apply-changes <run-id> <checkout-directory>
```

The command rechecks the completion record and content hashes, then compares every
destination's current SHA-256 with its `expectedHash` (a created file must not exist)
before writing anything. Any mismatch fails with exit `1`, lists the stale paths and
leaves the checkout untouched. Symbolic links and control-plane paths are refused. If you
apply the exported JSON with your own tooling, perform the same comparison.

Interactive Feature runs stop in `BLOCKED` (exit `3`) at a requirements checkpoint:

```bash
node apps/cli/dist/src/bin.js requirements <run-id>
node apps/cli/dist/src/bin.js approve-requirements <run-id> <artifact-id> <ambiguity-id>...
node apps/cli/dist/src/bin.js resume <run-id>
```

See [Feature mode](workflows.md#feature-mode) for revision and the equivalent HTTP routes.

## Preflight reference

| Code | Scope | Fix |
|---|---|---|
| `CONFIG_SCHEMA_INVALID` | configuration | Edit the field at `path`; the message is the schema's |
| `RESOLVED_CREDENTIAL_FORBIDDEN`, `INVALID_CREDENTIAL_ENVIRONMENT_REFERENCE` | configuration | Replace the literal secret with an uppercase `…EnvVar` variable name |
| `NATIVE_HARNESS_DISCOVERY_FORBIDDEN`, `NATIVE_HARNESS_MODE_UNSUPPORTED` | configuration | Native mode serves only the Testing writer: use a Testing execute run, or set `harness.mode` to `canonical` |
| `NATIVE_HARNESS_CONFIGURATION_REQUIRED`, `NATIVE_HARNESS_UNSUPPORTED:<id>`, `NATIVE_HARNESS_STAGE_UNSUPPORTED:<stage>` | configuration | Add `harness.native` naming a harness and stage from the support matrix |
| `NATIVE_HARNESS_TOOL_UNENFORCEABLE:<tool>` | configuration | Remove shell, network, subagent, MCP or unknown tools from `harness.native.tools` |
| `NATIVE_HARNESS_MODEL_INCOMPATIBLE:<id>`, `NATIVE_HARNESS_ADVISOR_UNSUPPORTED`, `NATIVE_HARNESS_CONTROL_PATH_IN_LEASE` | configuration | Use writer profiles the harness serves; remove advisors; never grant `CLAUDE.md`, `.claude/` or `.mcp.json` |
| `NATIVE_HARNESS_UNVERIFIED` | configuration (warning) | The matrix entry has no recorded real-CLI conformance yet |
| `BUDGETS_NOT_ENFORCED` | configuration | Set `budgets` to `{}`; limit spend with `workflow.modelExecution.maximumTokens` (error for model-backed runs, warning for scripted Audit) |
| `SECURITY_SETTINGS_NOT_ENFORCED`, `CONTEXT_POLICIES_NOT_ENFORCED` | configuration (warning) | Set the section to `{}`; exclude paths with `scope.exclude` or narrow `scope` |
| `UNKNOWN_WORKFLOW_PRESET`, `WORKFLOW_PRESET_MODE_MISMATCH` | configuration | Use a preset that executes the configured mode |
| `RUNTIME_MODEL_EXECUTION_CONFIGURATION_REQUIRED` | configuration | Add `workflow.modelExecution`, or remove all profiles for a scripted Audit |
| `MODEL_PROFILE_REQUIRED:<id>`, `MODEL_EXECUTION_ROLES_REQUIRED`, `MODEL_CRITIC_PROFILE_REQUIRED` | configuration | Add the named auditor profile or Audit role |
| `FEATURE_EXECUTION_CONFIGURATION_REQUIRED`, `FEATURE_MODEL_PROFILE_REQUIRED:<id>` | configuration | Add `workflow.feature` or the named profile |
| `FEATURE_REVIEW_INDEPENDENCE_REQUIRED`, `FEATURE_CRITIC_INDEPENDENCE_REQUIRED` | configuration | Use reviewers/critic from distinct `independenceGroup`s |
| `TESTING_EXECUTION_CONFIGURATION_REQUIRED`, `TESTING_MODEL_PROFILE_REQUIRED:<id>` | configuration | Add `workflow.testing` or the named profile |
| `TESTING_FRONTIER_ANALYST_REQUIRED` | configuration | Use a `frontier` profile as analyst |
| `TESTING_TASK_MODEL_CONFIGURATION_INVALID` | configuration | Writer must exist, declare `supports.tools`, and meet its tier |
| `MODEL_EFFORT_UNSUPPORTED:<id>` | configuration | Add the level to `effort.supported` or an explicit `effort.collapse` (warning for writer routing levels) |
| `TESTING_WRITE_PATH_INVALID`, `TESTING_WRITE_WITHOUT_VERIFICATION_CHECK` | configuration | Grant exact test file paths that a bound check covers |
| `CHECKPOINT_POLICY_REQUIRED`, `GATE_POLICY_REQUIRED`, `UNKNOWN_GATE_POLICY`, `UNKNOWN_CHECKPOINT_NODE`, … | configuration | For graphs with gate/human nodes (including operator-registered graphs): set `workflow.checkpoints` and give every gate a known policy |
| `BATCH_LANE_MODEL_PROFILE_REQUIRED`, other batch-lane codes | configuration | A `workflow.modelExecution.batch` lane must name a bound profile that declares `supports.batch`, on a transport with a batch driver |
| `ADVISOR_MODEL_CONFIGURATION_INVALID`, `ADVISOR_OUTPUT_LIMIT_EXCEEDED`, `ADVISOR_CONTEXT_LIMIT_EXCEEDED`, `ADVISOR_MODEL_ENDPOINT_ABSENT:<id>` | configuration | Each `workflow.testing.execution.advisors.models` tier must name a bound profile at or above that tier whose limits admit the advisor limits |
| `MODEL_IDENTITY_PLACEHOLDER:<id>` | environment (live runs) | Set real `modelId`/`family` |
| `PROVIDER_CREDENTIAL_MISSING:<endpoint>` | environment | Export the named variable |
| `NATIVE_HARNESS_EXECUTABLE_MISSING`, `NATIVE_HARNESS_CREDENTIAL_MISSING:<var>` | environment | Export `ARBITRA_CLAUDE_CODE_EXECUTABLE` (absolute path) and the `apiKeyEnvVar` variable |
| `SANDBOX_ENGINE_UNAVAILABLE`, `SANDBOX_IMAGE_UNAVAILABLE:<image>` | environment | Start a Linux Docker engine; make the pinned image present locally |

`run` reports these with exit `2` and reason `preflight_failed`, before a run
directory, snapshot or provider request exists. Feature and Testing replays apply the
same configuration and environment checks to the replay configuration before creating
their new run. The HTTP control plane returns them
as status `400`.
