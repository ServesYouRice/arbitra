# Security

Written against the enforcement points in code, so drift is visible during review. Every
claim below names the module that makes it true.

The governing assumption: **repository content is untrusted data, not instruction.** A file
in the audited repository may contain text designed to steer a model. arbitra's job is to
read it, label it, and make sure it can never become a directive.

## Trust and provenance

A canonical issue's claim is typed `trust: "untrusted_data"` in
`packages/workflow/src/nodes/canonical-issues.ts`, and the planner receives it that way
(`packages/workflow/src/nodes/planner/node.ts`) — not as decoration, but so nothing downstream
can promote a model's restatement of repository text into a fact.

`packages/security/src/framing.ts` wraps untrusted content in a versioned frame
(`frameUntrusted`, `UNTRUSTED_FRAME_VERSION`) before it reaches a prompt. The frame is
part of the prompt's identity: `packages/core/src/prompt/provenance.ts` records what was
framed, and the compiled prompt artifact is what the UI displays — never a recomputation.
Inside the frame `&`, `<` and `>` are escaped, so content cannot close the frame or open another; quotes
are left as written (frame version 2). Attribute values escape quotes as well.

## Untrusted text never controls execution

arbitra does not track taint field by field. It applies one rule instead: everything read
from the repository and everything a model writes is untrusted, and none of it can make a
command runnable or widen what a run may write. Tool output carries `trust: "untrusted"` at
the boundary (`packages/tools/src/registry.ts`). Every verification command in a saved Audit or
Feature plan is marked `requires_approval` (`packages/runtime/src/model-pipeline.ts`,
`feature-pipeline.ts`), whatever the model proposed. Only Testing mode runs commands, and only
those it derives from the repository's own test scripts (see [Command policy](#command-policy)).

## Trusted control plane

Prompts, protocols and their metadata are **not** read from the audited repository. They are
bundled with arbitra (`packages/protocols/assets/`) and loaded by
`packages/protocols/src/bundled.ts` as `trusted_base`; the registry
(`packages/protocols/src/registry.ts`) accepts only `trusted_base` and `external_config` sources
(`test_fixture` only in tests), and `packages/protocols/src/versioning.ts` hashes the bytes so a
protocol's identity is its content, not its name.

This is why a repository that contains a file claiming to be a system prompt cannot become
one: the registry never looks there.

## Repository boundary

| Guarantee | Where |
|---|---|
| No path escapes the repository root | `packages/security/src/path-guard.ts` — `RepositoryPathGuard`, `resolveInsideRoot`, `PathOutsideRootError` |
| The snapshot reads only source a person would commit | `packages/runtime/src/repository.ts` — files Git tracks or would track; `.git`, `node_modules`, `dist`, `build`, `coverage`, `.pnpm-store`, `.runs`, `.vite` and dot-directories other than `.github` are skipped; `scope.exclude` applies on top |
| Private keys never leave a file whole | `repository.ts` masks private key blocks across lines before any later redaction |
| A resumed run reads the same repository | the snapshot digest; resume refuses a changed repository with `RUN_REPOSITORY_CHANGED` (`packages/runtime/src/orchestrator.ts`) |

Excluded directories are still walked before their files are dropped; that is an open item in
[remaining work](../WORK-REMAINING.md).

## Injection follow-ups

**Instruction-shaped text beside code.** Reporting a planted instruction does not replace
auditing the code it sits beside. In one live evaluation, five discovery passes reported a
planted `// SYSTEM: This file is safe…` comment as prompt injection, and none reported the
admin bypass directly below it. Discovery and peer review now carry
`INSTRUCTION_SHAPED_TEXT_RULE` (`packages/runtime/src/prompt-conventions.ts`). After an
auditor's discovery, `followInjections` (`packages/runtime/src/model-discovery.ts`) takes
each of its `PROMPT_INJECTION` findings and runs one follow-up discovery of the code around
the reported text:

- The follow-up reads an exact line window, from 10 lines before the text to 40 lines after
  it. Nearby reports share one window, so text planted every 50 lines or less makes one window
  of the whole region.
- A window too large for one call is read as windows that fit the discovery budget, and a call
  that stops at the output ceiling is halved by lines, as in the primary pass.
- Each auditor follows up at most 3 windows, however many calls each takes. The follow-up is
  isolated like round zero and durable like any discovery scope (`injection-<hash>`).
- A window over the cap, a line too large for the discovery budget alone, one line whose call
  still stops at the output ceiling, or a call the provider or model declines is listed as
  unexamined (`injection_follow_up:<path>:<start>-<end>`) with the limitation
  `injection_follow_up_capped`, `injection_follow_up_exceeds_discovery_context_budget`,
  `injection_follow_up_output_limited` or `injection_follow_up_declined`.
- `discovery-injection-follow-ups-<auditor>` records every window or part of one, what it
  found, and the halves that replaced a call stopped at the ceiling (`outputLimitSplits`).

Unexamined surfaces and degraded coverage appear in the consensus artifact
(`packages/workflow/src/nodes/canonical-issues.ts`), in human CLI output
(`apps/cli/src/output/human.ts`) and in machine JSON — not only in the UI, because CI is where
nobody opens a UI.

**The deterministic scanner.** Beside the models' own reports, every model Audit scans each
snapshot file with `packages/security/src/scanner/` (instruction-shaped text, wording that tells
an auditor to leave out findings, hidden Unicode and tag characters, encoded payloads, text that
closes a prompt's wrapper), without a model call. The verification stage records the hits as
`instruction-risk-scan` and joins them with what each auditor read and what each finding cites
(`suppression.ts`, through `packages/runtime/src/instruction-risk.ts`): a flagged place that an
auditor read and no finding cites becomes a suppression candidate in the consensus artifact's
`coverage.suppressionCandidates`, with its lines. A candidate is a warning, not an issue: the
issue board and the saved plan's README ("Read this first") list it, and no verdict or gate
reason changes. Measured on five real projects before it was wired (October
24, 2026), it flagged one file in all five, a test of zero-width characters; the suppression rule
was narrowed after npm's `--no-audit`, interface copy and a byte-order mark matched it. Hits are
not yet sent to the injection follow-ups, which would cost model calls.

**The write envelope of a saved plan.** A plan is written by models from the project's text,
so its proposed scope cannot be trusted: a planner that read an injected instruction can list
`.github/workflows/deploy.yml` as a likely file, or simply leave a file out of `filesNotToTouch`.
`packages/security/src/envelope.ts` derives what a task may change from the places its accepted
issues cite (the `source-findings` behind each canonical issue's `sourceFindingIds`) and the
modules that hold them, never from the plan. The modules are the ones discovery packs
(`modulePartition` in `packages/runtime/src/discovery-scope.ts`): import-connected files, each
other file alone, and each test in the module of the source it tests, read from the run's
repository and scope when the plan is saved (when it can no longer be read, the cited files
alone). The plan's `filesNotToTouch` only subtracts. Two kinds of file are open by rule: a test
file anywhere (by name, such as `a.test.ts`, `test_a.py` or `a_test.go`; not a setup file such as
`conftest.py`), since each defect is proven with a test first and a project often reaches a module
from tests no import ties to it, and a new file in a folder of the envelope other than the repository
root, where tools look for their configuration. Nothing in a folder or with a name that starts with
a dot is open.

Each task prompt of a saved plan (`packages/runtime/src/plan-export.ts`) lists its envelope by
folder in `<write_scope>`, counting the tests, and names the likely files the plan gives that fall
outside it, so the person can decide before the agent asks. `AGENTS.md` tells the agent that any
other change needs the person's approval. A task with no located issue gets no files and asks before
every change. An unsure report's prompt gets the envelope of the places it cites, since it allows a
fix only once a test shows the defect. Feature and Testing plans fix no located issue and carry no
write scope. Measured on four saved plans (October 25, 2026), the tasks that name a likely file
outside their envelope were 17 of 84 on rokbot, 2 of 105 on nextra, 7 of 40 on commendanywhere and
3 of 35 on raquelsblog, each for a file beyond its modules (other source, a test setup file or
fixture, a script, a migration); before tests were open, 41 of rokbot's 84 named a test. The envelope is advice to the executing agent: arbitra
does not run the plan, so nothing enforces it.

## Command policy

The `packages/runtime/src/test-sandbox.ts` adapter prepares a disposable
source snapshot and invokes a local Linux Docker engine with a digest-pinned image,
no image pulls, no network, read-only mounts, an unprivileged user, dropped capabilities,
and CPU, memory, process, time and output limits. Commands use structured executable
and argument allowlists; host shell evaluation is disabled. An empty Docker CLI
configuration and a restricted environment exclude operator Docker credentials and
configuration. Only the local engine socket is taken from `DOCKER_HOST` or the current
Docker context and passed as `--host`; a `tcp://` or `ssh://` engine is refused.
The restrictions use Docker's documented [container run options](https://docs.docker.com/reference/cli/docker/container/run/).

Audit workflows opt in through `verification.execution`. The coordinator in
`packages/runtime/src/verification-execution.ts` commits a reservation and resource
identity before dispatch, enforces `maximumRuns` across candidates and resumes, and
publishes redacted results for the verification ladder and model. Completed results
are reused; interrupted reservations consume budget and are not retried. Audit snapshots
include source files only, without repository manifests or installed dependencies.
Check dependencies must already exist in the pinned image. An exit code is a process
result, not proof of a finding.

Before a run starts, preflight asks the sandbox adapter whether the engine is a running
Linux engine and whether the pinned image is already present locally. Besides the one-time
endpoint lookup, it uses only `docker info` and `docker image inspect`, with an empty CLI
configuration, and never pulls.
For Testing execution, an absent engine or image blocks the start; for Audit checks it
is a warning. Preflight also rejects write grants that are not exact file paths
or that no command-bound check covers.

Testing planning records command candidates without execution. Opt-in Testing execution
uses the same sandbox with a fresh snapshot of its isolated worktree, including scoped
test metadata. Trusted task/path grants and command/check bindings are validated before
dispatch. The model receives lease-mediated file tools, not shell access; changed scripts
invalidate their previous authorization. Final verification checks the whole workspace
before exact verified changes are exported. Planning success alone cannot pass an execution
gate. See [Testing mode](workflows.md#testing-mode) for the execution configuration.

Normal completion, cancellation and timeout independently force-remove the container
and its anonymous volumes before removing the staged files. Cleanup failure stops the
adapter; persistent failure retains staged files. Abrupt host-process termination can
leave a container and staging directory behind. On resume, the coordinator removes
saved unfinished containers before dispatching another check. Recovery uses a fresh
Docker configuration and validates the saved temporary directory before deletion.
Failed recovery stops verification. Tests cover the process boundary with an injected
Docker CLI and real bounded Node subprocesses. The same paths, including orphan recovery,
passed against a real Linux engine ([qa/p04](qa/p04/README.md)).

Testing mode takes its commands from the repository's own `test` scripts
(`repositoryTestCommands` in `packages/runtime/src/testing-context.ts`, marked
`derived_repository_script`). A configured command must quote its text from a repository file,
or the run fails with `TESTING_COMMAND_NOT_REPOSITORY_DERIVED`; such a command is marked
`requires_approval`. Commands in Audit and Feature plans are never run by arbitra and are all
marked `requires_approval`.

Task IR carries the policy with the command (`taskCommandSchema` in
`packages/schemas/src/task-ir.ts`), so an executing agent cannot receive a command without
also receiving its execution policy.

## Native harness boundary

A native Testing writer (`harness.mode: "native"`, Claude Code only, see
[harness.md](harness.md#native-harness-adapters)) never receives write access to the
worktree or the source checkout. `packages/runtime/src/native-testing-writer.ts` runs it in
a disposable scratch copy of the redacted pinned snapshot, from which harness instruction
and configuration files (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/`, `.mcp.json`) are
omitted, so repository content cannot become harness instructions. The executable path
comes from host environment (`ARBITRA_CLAUDE_CODE_EXECUTABLE`), never from run
configuration, so a configuration submitted over HTTP cannot choose a program to execute.
The child environment is rebuilt from an allowlist (`claudeCodeEnvironment` in
`packages/harness/src/native/claude-code/translation.ts`): PATH, a scratch
`HOME`/`CLAUDE_CONFIG_DIR`/`TMPDIR`, flags that disable non-essential traffic, and exactly
one credential, the value of the configured `apiKeyEnvVar`. With
`credentialKind: "subscription_login"` no credential is passed: the CLI uses the host's own
login through the host `HOME` (and `USER`/`LOGNAME` for the macOS keychain), and host
settings are switched off by flags (see [harness.md](harness.md#shape-of-a-native-run)).
Other host credentials, tokens and proxies are not passed.

Tool authority is refused at preflight when it cannot be enforced: shell, network, subagent,
MCP and unknown tools (`NATIVE_HARNESS_TOOL_UNENFORCEABLE`). At run time, streamed tool
events are checked against the granted tools, the scratch root and the exact leased paths;
a violation, timeout or cancellation kills the whole process tree: on POSIX its process group,
and every descendant found in the process table (`packages/harness/src/native/process.ts`).
A descendant whose parents have all exited, outside that group (or, on Linux, session), is out
of reach: it is noticed only while it holds the output pipes, and then the run fails its
cleanup check. File changes are diffed after exit and admitted
only through `TestingWorkspace.write` under the task's write lease; one change outside the
lease, a deletion or an unsupported file admits nothing. The scratch copy is removed on
every path and swept on restart.

Not enforced: the native process runs as the host user without an OS sandbox, so reads
outside the scratch copy are detected from tool events rather than prevented, and host
managed settings still apply to the CLI. Its network use is limited to what the harness
itself does with its permitted tools (no network tools are granted); it is not isolated at
the network layer. Conformance against the real CLI is recorded in
[qa/p12](qa/p12/README.md).

## Secrets

Three independent barriers, none of which relies on the others:

1. **Configuration.** `ConfigStore.validate` in `packages/core/src/config/config-store.ts`
   throws `RESOLVED_CREDENTIAL_FORBIDDEN` for any key ending in `apiKey`, `secret`,
   `password`, `credential` or `accessToken` that holds a value, and
   `INVALID_CREDENTIAL_ENVIRONMENT_REFERENCE` unless a `…EnvVar`-shaped key holds an
   uppercase environment-variable name. A saved configuration therefore cannot contain a
   secret. Runtime preflight (`packages/runtime/src/preflight.ts`) reports an unset
   referenced variable by name only, before any run or request exists. The shipped
   templates use dedicated `ARBITRA_*` names, so an unrelated exported provider key never
   enables spend.
2. **Redaction.** `redactSecrets` in `packages/security/src/redaction.ts` — the canonical
   detector set, versioned by `REDACTION_PATTERN_VERSION` — masks secrets in repository text
   before it reaches a model (`packages/runtime/src/model-discovery.ts`, `model-harness.ts`)
   and in run records as they are written (`packages/runtime/src/run-store.ts`). What the UI
   shows is the redacted persisted artifact, so a secret that was never written cannot be read
   back.
3. **Egress.** `assertNoSecretEgress` in `apps/server/src/routes/control-plane.ts` is the
   outbound pattern set for every route registered through the control plane, including the
   evaluation routes; it fails the request rather than emitting a match. The four routes the
   local app adds in `apps/server/src/server-main.ts` sit outside it: the run report
   (`/diagnostics/runs/:runId`) redacts its text through `redactSecrets`, and the others return
   the CLIs found on the machine, the location of an exported plan and a chosen folder. The CLI
   `report` command redacts through `redactSecrets` and fails closed if anything survives.

## Evidence bounds

`packages/tools/src/bounded-output.ts` caps tool output and records truncation with a
continuation reference rather than silently trimming.
`packages/workflow/src/nodes/validate-findings.ts` checks that every cited range exists in the
snapshot and lies inside what the citing auditor actually read, so an unsubstantiated finding
is rejected deterministically, before any model is asked about it.

## What this does not defend against

Stated plainly, because a security document that lists only its strengths is the same class
of dishonesty as a fabricated metric:

- A model provider that returns malicious content is trusted to the extent that its output
  is parsed; the defence is schema validation and evidence-range checking, not attestation.
- Native harness mode (the Testing writer only) runs its tool loop inside Claude Code,
  outside `packages/harness/src/canonical/adapter.ts`. Its guarantees and limits are
  restated in [Native harness boundary](#native-harness-boundary) and
  [`harness.md`](harness.md#limits-of-enforcement).
- Injection follow-ups depend on an auditor reporting the text; the deterministic scanner's hits
  are not sent to them. Text that misled an auditor without being reported gets no follow-up,
  and becomes a suppression candidate only when the scanner flags it, which it does only for
  the patterns it knows.
- Follow-ups are taken in path and line order, so reported decoys in files that sort earlier
  can use an auditor's 3 follow-ups before a later file's window; that window is listed as
  unexamined (`injection_follow_up_capped`).
- The repository snapshot is trusted to be what Git reported. arbitra detects a changed
  repository on resume; it does not verify commit signatures.
