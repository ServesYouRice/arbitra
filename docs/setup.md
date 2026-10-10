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

The same five modes also ship as **subscription templates**, served by vendor CLIs signed in
with your own Claude, ChatGPT or Google subscription instead of API keys (see
[Subscription CLIs](#subscription-clis-instead-of-api-keys)):

| Template | Mode / preset | Subscription CLIs |
|---|---|---|
| `subscription-audit.json` | Audit / `audit-deep` | Claude Code, Codex, Antigravity CLI |
| `subscription-feature-interactive.json` | Feature, interactive | Claude Code (planner), Codex and Antigravity CLI (reviewers) |
| `subscription-feature-automatic.json` | Feature, automatic | Claude Code (planner), Codex and Antigravity CLI (reviewers) |
| `subscription-testing-plan.json` | Testing / `testing-plan` | Claude Code (analyst), Codex (planner) |
| `subscription-testing-execute.json` | Testing / `testing-execute` | Codex (analyst), Claude Code (writer) |

Together they cover all four wire protocols and three of the four subscription CLIs (Claude
Code, Codex and the Antigravity CLI);
`audit-mixed-providers` is the mixed-provider configuration. Every template names a placeholder model (`replace-with-your-model-id`)
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

This runs [`example-smoke.test.ts`](../packages/runtime/test/example-smoke.test.ts),
[`subscription-smoke.test.ts`](../packages/runtime/test/subscription-smoke.test.ts) and
[`preflight.test.ts`](../packages/runtime/test/preflight.test.ts). The subscription smoke
checks replace the CLI processes with an in-process runner that speaks each CLI's event
format, so no CLI, login or model is needed; one of them mixes an API-key auditor with
subscription auditors in a single run. Each model-backed
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
provider conformance or real Docker isolation. Those are covered separately: provider
conformance in [P03](completion-plan.md#p03--build-and-run-live-provider-acceptance)
(accepted on subscriptions; the API protocols are
[deferred](completion-plan.md#deferred-the-paid-api-bundle)), and the real Docker boundary in [P04](qa/p04/README.md) (complete).

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

The same steps work in the web UI (`node apps/server/dist/src/serve.js` from the repository to
analyze, then `pnpm --filter @arbitra/web dev`). **New run** starts from any of these
templates, lists every placeholder still in it by path, and shows the model profiles with
their model ID and family to fill in. **Check configuration** runs the same preflight and
estimate as `validate` and `estimate`, without saving anything. **Save and start** saves the
configuration and starts the run, and only when preflight passes.

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

### Subscription CLIs instead of API keys

Any model role can be served either by an API endpoint (an `apiKeyEnvVar`, billed to API
credit) or by a **subscription CLI**: the vendor's official CLI, signed in with your own
subscription, run headless as a plain completion engine. You choose per endpoint, and one
run may mix both. arbitra keeps the tool loop, context, budgets, durability and policy; the
CLI's own agent tools are disabled, and any sign that it used one fails the call
(`CLI_AGENT_TOOL_USE_FORBIDDEN`).

| Transport | CLI | Endpoint | Sign in (once, in a terminal) | Executable |
|---|---|---|---|---|
| `claude-code-cli` | Claude Code 2.1–2.x | `cli://claude-code` | `claude auth login` with a Claude Pro or Max account; or `claude setup-token` for `auth: "oauth_token"` | `ARBITRA_CLAUDE_CODE_EXECUTABLE`, else `claude` on PATH, `~/.claude/local`, `~/.local/bin`, npm global bins, or the newest VS Code/Cursor/Windsurf extension binary |
| `codex-cli` | Codex CLI 0.150–0.199 | `cli://codex` | `codex login`, choose Sign in with ChatGPT (an API-key login is refused) | `ARBITRA_CODEX_EXECUTABLE`, else `codex` on PATH, npm global bins, or the ChatGPT app on macOS (`ChatGPT.app/Contents/Resources/codex-cli/bin/codex` since Codex 0.158, earlier `Contents/Resources/codex`; `~/Applications` before `/Applications`) |
| `antigravity-cli` | Antigravity CLI (`agy`) 1.1.15–1.x | `cli://antigravity` | run `agy` once and sign in with the Google account that holds your Google AI subscription (kept in the OS keyring) | `ARBITRA_ANTIGRAVITY_EXECUTABLE`, else `agy` on PATH, `~/.local/bin/agy` (the installer's location), or `%LOCALAPPDATA%\Microsoft\WinGet\Links\agy.exe` |
| `gemini-cli` | Gemini CLI 0.60–0.x | `cli://gemini` | run `gemini`, Login with Google using a Gemini Code Assist Standard or Enterprise account, and export `GOOGLE_CLOUD_PROJECT` | `ARBITRA_GEMINI_EXECUTABLE`, else `gemini` on PATH or npm global bins |

An executable override must be an absolute path. If it names a JavaScript entry point
(`.js`, `.cjs`, `.mjs`, for example an npm package's `cli.js`), arbitra runs it with its own
Node on every platform.

For Google, use `antigravity-cli` with a personal Google AI subscription (free, AI Pro or
Ultra). Since June 18, 2026 Google no longer serves the Gemini CLI to personal logins and
refuses them before any model call; arbitra reports that as `CLI_ACCOUNT_INELIGIBLE`.
`gemini-cli` remains for Code Assist Standard or Enterprise logins, and API-key users use the
`gemini-native` API transport. Install the Antigravity CLI with
`curl -fsSL https://antigravity.google/cli/install.sh | bash` (Windows:
`winget install Google.AntigravityCLI`). Its model slug carries the effort
(`gemini-3.8-flash-low`, `-medium`, `-high`; `agy models` lists them). A bare slug such as
`gemini-3.8-flash` needs `effort.params` entries like `{ "effort": "medium" }`, or the CLI
refuses it (`CLI_MODEL_UNAVAILABLE`, with that hint).

On Windows an npm `.cmd` shim is resolved to its Node script and run with Node, never through
`cmd.exe`. An endpoint looks like this; no URL, key or token value appears:

```json
{ "id": "claude-code", "providerId": "anthropic", "transport": "claude-code-cli", "endpoint": "cli://claude-code", "auth": "subscription_login" }
```

For a separate Claude token instead of the host login, use
`"auth": "oauth_token", "oauthTokenEnvVar": "ARBITRA_CLAUDE_CODE_OAUTH_TOKEN"`; the CLI then
runs with an isolated home and configuration directory. Profiles bound to CLI endpoints use
`structuredOutputDialect: "prompt_json"` and `historyPolicy: "verbatim"`; `effort.params` may
carry `{ "effort": "high" }` (Claude Code, Codex and the Antigravity CLI) and
`{ "thinkingTokens": N }` (Claude Code). Other effort fields are refused.

What each call does: it creates a fresh temporary directory, runs the CLI with an empty
working directory and an allowlisted environment (`HOME`, `PATH`, temporary directories,
locale, plus `CODEX_HOME`/`CLAUDE_CONFIG_DIR`/`GOOGLE_CLOUD_PROJECT` when set), checks the
CLI version against the support matrix, sends the framed conversation on stdin, reads the
CLI's event stream, kills the whole process tree on every exit path and deletes the
directory. Repository content reaches the model only through arbitra's framed prompt. Tool
calls are emulated: the model answers with a `{"toolCalls": [...]}` envelope or its final
answer, and arbitra runs the tools. Measured tokens are recorded; cost is recorded as
unknown, because subscription use is not billed per call. Traces record the CLI and its
version as the transport version (for example `claude-code/2.1.282`).

Preflight checks each CLI without spending a model call: installed
(`SUBSCRIPTION_CLI_NOT_INSTALLED`), supported version (`SUBSCRIPTION_CLI_VERSION_UNSUPPORTED`),
signed in (`claude auth status`, `codex login status`; the Antigravity CLI keeps its login in
the OS keyring and Gemini's cached Google login is only evidence, so both warn
`SUBSCRIPTION_CLI_AUTH_UNVERIFIED` until the first call), not signed in with an API key
(`SUBSCRIPTION_CLI_API_KEY_LOGIN`), and not at a usage limit recorded by an earlier call
(`SUBSCRIPTION_CLI_USAGE_LIMIT_REACHED`, kept in `~/Library/Caches/arbitra`,
`$XDG_CACHE_HOME/arbitra` or `%LOCALAPPDATA%\arbitra`).

**Limits and terms.** Subscription use is subject to each vendor's terms of service and to
the plan's personal usage limits; check that automated use through the official CLI is
permitted for your plan before relying on it. A plan limit fails the call as `QUOTA` with the
reset time when the CLI gives one (`CLI_USAGE_LIMIT_REACHED`); short throttles are
`RATE_LIMIT` and retried. Keep `rateLimits` low (the templates use `maxConcurrent: 1` and
`rpm: 10`) and `timeoutMs` generous (600000), because CLI calls carry several seconds of
start-up and a large vendor system context. Batch lanes are not available on CLI endpoints.

Known gaps: Claude Code still adds its own short environment block (working directory,
platform, date and the signed-in account's email) to the context; Codex declares a few
built-in functions that cannot be switched off (they are refused if used) and adds roughly
5,000 tokens of its own instructions per call; the Antigravity CLI adds about 24,500 tokens
of agent instructions per call, declares browser, command and file tools that cannot be
switched off (it runs with `--sandbox` and `--disable-slash-commands`, never
`--dangerously-skip-permissions`, and any tool step or soft-denied tool notice fails the
call), still reads the user's own settings under `~/.gemini/antigravity-cli` and keeps only the
first 191,580 bytes of a prompt (it silently drops the rest; only the model sees a truncation
note), so prompts over 190,000 bytes are refused (`CLI_PROMPT_TOO_LARGE`). On macOS the prompt
is the CLI's `-p` argument. A command line cannot carry that much on Windows (32,767
characters) or Linux (128 KiB per argument), so there the prompt is one stream-json message on
stdin (`--input-format stream-json`, agy 1.1.15 and later), which the CLI cuts at the same
point. The largest prompt arbitra sends is about `limits.contextTokens` (or
`maximumContextTokens`, if lower) minus `maximumOutputTokens` bytes, so keep that difference
within the limit: for example, `contextTokens` 200,000 with the shipped `maximumOutputTokens`
of 32,000, and discovery then splits a larger repository into prompts that fit. The Gemini CLI records
session history under `~/.gemini/tmp`. Output ceilings are enforced for Claude Code
(`CLAUDE_CODE_MAX_OUTPUT_TOKENS`); Codex, the Antigravity CLI and the Gemini CLI offer no
per-call output ceiling. Google AI Pro and Ultra quotas refresh on a five-hour cycle; an
exhausted quota is `QUOTA` and is recorded for preflight until the reset.

### Budget limits

These limits are enforced:

| Setting | Effect |
|---|---|
| `workflow.modelExecution.maximumTokens` | Durable run-wide admission budget in conservative estimated tokens (derived from request bytes, so it overstates provider tokens). Reservations are saved before dispatch; exhaustion suspends the run (`SUSPENDED_BUDGET`) rather than overspending. |
| `maximumOutputTokens`, `maximumContextTokens`, `maximumDiscoveryTokens` | Per-request output reserve and context caps. The subscription templates use 32,000 output tokens: subscription output is not billed per token, and live planners (a Plan IR for a few gaps) exceeded 8,000. |
| `maximumRetries`, `timeoutMs`, `rateLimits` | Retry count, per-request timeout, per-provider pacing and concurrency. |
| `maximumOutputRepairs` | Re-asks per model stage (0–3, default 0; templates use 1) after a reply fails output validation: unparsable JSON, schema, evidence grounding or plan traceability. Each re-ask is its own durable, budgeted activity that carries the rejection reason and the rejected reply as untrusted data. Provider failures, refusals and output-limit stops are never repaired. |
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
`>=2.0.0 <3.0.0`), conformance-verified against the real CLI 2.1.283 on a subscription
login ([evidence](qa/p12/README.md)). See
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
  `ANTHROPIC_API_KEY`, its only credential. Not used with `subscription_login` (below).
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

A Claude subscription can stand in for an API key: run `claude setup-token`, put the token
in the variable `apiKeyEnvVar` names and set `harness.native.credentialKind` to
`oauth_token`. The token is then passed to the native process only as
`CLAUDE_CODE_OAUTH_TOKEN` (for the conformance test:
`ARBITRA_NATIVE_CONFORMANCE_CREDENTIAL_KIND=oauth_token`).

To use the host's own Claude Code login instead (the account `claude` is signed in to on
this machine: macOS keychain, or `~/.claude/.credentials.json` on Linux), set
`credentialKind` to `subscription_login` and omit `apiKeyEnvVar`. It needs Claude Code
2.1.0 or later. No credential variable is passed: the native process gets the host `HOME`
(`USERPROFILE` on Windows), `USER`/`LOGNAME` (the keychain account) and the host
`CLAUDE_CONFIG_DIR` only when set, and runs with
host settings, memory, skills, plugins, hooks and MCP switched off (`--setting-sources ""`,
`--safe-mode`, an empty `--mcp-config`, `--no-session-persistence`,
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). A login that reports API-key authentication is stopped
before its first request (`NATIVE_HARNESS_API_KEY_IN_USE`). For the conformance test:
`ARBITRA_NATIVE_CONFORMANCE_CREDENTIAL_KIND=subscription_login`, with no key variable.

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
  One check (say `npm run test`) may list the files of several tasks. While a task is
  verified, granted files that no task has created yet are left out of that check's
  sources; any other missing source fails with `TESTING_CHECK_SOURCE_MISSING:<path>`. The
  final verification sees every created file.
- `authorization.tasks[]` grants exact planned task IDs. Real models do not plan the same
  tasks twice, so run `testing-plan` first, inspect the task IDs and write paths in its
  handoff, then start execution as a replay of that run
  (`replay <run-id> --request execute.json` with `{"mode":"testing","configuration":<the
  execute configuration>,"execution":{"mode":"execute","authorization":{...}}}`). Analysis
  and planning are reused without model calls, so the grant names exactly the plan you
  inspected. A direct `testing-execute` run plans afresh; if that plan does not match the
  grants, it fails before any worktree is created with
  `TESTING_WRITE_AUTHORIZATION_INCOMPLETE`, naming the ungranted and unknown task IDs.
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
| `NATIVE_HARNESS_CREDENTIAL_VARIABLE_REQUIRED`, `NATIVE_HARNESS_CREDENTIAL_VARIABLE_FORBIDDEN` | configuration | Name `harness.native.apiKeyEnvVar` for `api_key` (the default) and `oauth_token`; omit it for `subscription_login` |
| `NATIVE_HARNESS_MODEL_INCOMPATIBLE:<id>`, `NATIVE_HARNESS_ADVISOR_UNSUPPORTED`, `NATIVE_HARNESS_CONTROL_PATH_IN_LEASE` | configuration | Use writer profiles the harness serves; remove advisors; never grant `CLAUDE.md`, `.claude/` or `.mcp.json` |
| `NATIVE_HARNESS_UNVERIFIED` | configuration (warning) | The matrix entry has no recorded real-CLI conformance yet (not raised for Claude Code, which is verified) |
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
| `NATIVE_HARNESS_EXECUTABLE_MISSING`, `NATIVE_HARNESS_CREDENTIAL_MISSING:<var>`, `NATIVE_HARNESS_HOST_HOME_MISSING` | environment | Export `ARBITRA_CLAUDE_CODE_EXECUTABLE` (absolute path) and the `apiKeyEnvVar` variable; `subscription_login` needs the host `HOME` (`USERPROFILE` on Windows) |
| `SANDBOX_ENGINE_UNAVAILABLE`, `SANDBOX_IMAGE_UNAVAILABLE:<image>` | environment | Start a Linux Docker engine; make the pinned image present locally |
| `SUBSCRIPTION_CLI_NOT_INSTALLED:<endpoint>`, `SUBSCRIPTION_CLI_VERSION_UNREADABLE:<endpoint>`, `SUBSCRIPTION_CLI_VERSION_UNSUPPORTED:<endpoint>` | environment | Install a supported CLI version, or set its `ARBITRA_*_EXECUTABLE` to an absolute path |
| `SUBSCRIPTION_CLI_NOT_LOGGED_IN:<endpoint>`, `SUBSCRIPTION_CLI_API_KEY_LOGIN:<endpoint>` | environment | Sign in with the subscription using the command in the message (`claude auth login`, `codex login`, `gemini`) |
| `SUBSCRIPTION_CLI_USAGE_LIMIT_REACHED:<endpoint>` | environment | Wait for the reset shown, or bind those roles to another endpoint (warning when the reset time is unknown) |
| `SUBSCRIPTION_CLI_AUTH_UNVERIFIED:<endpoint>`, `SUBSCRIPTION_CLI_UNVERIFIED:<transport>` | environment (warning) | Sign-in is confirmed only by the first call; the CLI has no recorded live verification yet |

`run` reports these with exit `2` and reason `preflight_failed`, before a run
directory, snapshot or provider request exists. Feature and Testing replays apply the
same configuration and environment checks to the replay configuration before creating
their new run. The HTTP control plane returns them
as status `400`.
