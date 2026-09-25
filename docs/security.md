# Security

Written against the enforcement points in code, so drift is visible during review. Every
claim below names the module that makes it true.

The governing assumption: **repository content is untrusted data, not instruction.** A file
in the audited repository may contain text designed to steer a model. arbitra's job is to
read it, label it, and make sure it can never become a directive.

## Trust and provenance

`packages/security/src/provenance.ts` defines the provenance vocabulary and annotates
fields with their trust origin (`annotateTrust`, `FieldTrustMap`). A canonical issue's
claim is typed `trust: "untrusted_data"` in `packages/schemas/src/canonical-issue.ts` —
not as decoration, but so nothing downstream can promote a model's restatement of
repository text into a fact.

`packages/security/src/framing.ts` wraps untrusted content in a versioned frame
(`frameUntrusted`, `UNTRUSTED_FRAME_VERSION`) before it reaches a prompt. The frame is
part of the prompt's identity: `packages/core/src/prompt/provenance.ts` records what was
framed, and the compiled prompt artifact is what the UI displays — never a recomputation.

## Taint

`packages/security/src/taint.ts` propagates taint through derived values (`propagate`,
`taintForOutput`, `taintedBy`) with a bounded source list (`MAX_TAINT_SOURCES`). `CLEAN_TAINT`
is the only untainted starting point. Tool output is tainted at the boundary in
`packages/tools/src/registry.ts`, where every `ToolResult` carries `trust: "untrusted"`.

Taint is not a warning label that can be dropped: a value that reaches a control decision
carrying taint is a defect, and `packages/security/src/declassify/index.ts` is the only way
out. Declassification is category-bounded (`DECLASSIFIER_CATEGORIES`), path-bounded
(`DeclassifiableSchemaPath`) and produces a `DeclassificationProof` recording what was
released and why. There is no unproofed path.

`packages/security/src/control-class.ts` classifies schema paths (`controlClassOf`) so the
distinction between a field that can influence control flow and a field that is merely
displayed is mechanical rather than remembered.

## Trusted control plane

Prompts, protocols and their metadata are **not** read from the audited repository.
`packages/security/src/control-plane/resolver.ts` resolves control-plane assets from a
declared source and records which one
(`trusted_base` · `external_config` · `test_fixture` in
`packages/protocols/src/registry.ts`). `packages/security/src/control-plane/assets.ts`
holds the asset contract; `packages/protocols/src/versioning.ts` hashes the bytes so a
protocol's identity is its content, not its name.

This is why a repository that contains a file claiming to be a system prompt cannot become
one: the resolver never looks there.

## Repository boundary

| Guarantee | Module |
|---|---|
| No path escapes the repository root | `path-guard.ts` — `resolveInsideRoot`, `RepositoryPathGuard`, `PathOutsideRootError` |
| Immutable snapshot identity and drift detection | `snapshot.ts` — `RepositorySnapshot`, `DriftResult` |
| Mandatory and configured exclusions | `exclusions.ts` — `createExclusionPolicy`, `isExcluded` |
| Scope envelope the run may read | `envelope.ts` — `ProposedScope`, `EffectiveScope` |

Exclusions are policy, not filtering-after-the-fact: an excluded path is never opened, so
it cannot appear in a footprint, an artifact or a finding.

## Injection scanning and suppression candidates

`packages/security/src/scanner/index.ts` scans repository content for instruction-shaped
text (`scan`, `InstructionRisk`, versioned by `INJECTION_SCANNER_VERSION`, rules in
`scanner/rules/`). A hit is **not** treated as an attack.

`packages/security/src/suppression.ts` computes suppression candidates deterministically
from four inputs — scanner risk, audited scope, auditor exposure footprint, and finding
citations. A candidate is raised only when instruction-shaped content was *read by* an
auditor and *cited by no finding*. Its note says exactly what that means:

> Instruction-shaped repository content was exposed to an auditor, but no source finding
> cited this surface. This is not proof of a defect or an attack; it is an unresolved audit
> uncertainty.

Suppression candidates, unexamined surfaces and degraded coverage appear in the consensus
artifact (`packages/workflow/src/nodes/canonical-issues.ts`), in human CLI output
(`apps/cli/src/output/human.ts`) and in machine JSON — not only in the UI, because CI is
where nobody opens a UI.

`packages/security/src/overlap-allocator.ts` allocates the security overlap budget
(`allocateOverlap`) so deliberate double-coverage is a budgeted decision with a recorded
rationale rather than an accident.

## Command policy

The `packages/runtime/src/test-sandbox.ts` adapter prepares a disposable
source snapshot and invokes a local Linux Docker engine with a digest-pinned image,
no image pulls, no network, read-only mounts, an unprivileged user, dropped capabilities,
and CPU, memory, process, time and output limits. Commands use structured executable
and argument allowlists; host shell evaluation is disabled. An empty Docker CLI
configuration and a restricted environment exclude operator Docker contexts and credentials.
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
Linux engine and whether the pinned image is already present locally. It uses only
`docker info` and `docker image inspect`, with an empty CLI configuration, and never pulls.
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
one credential, the value of the configured `apiKeyEnvVar`. Other host credentials, tokens
and proxies are not passed.

Tool authority is refused at preflight when it cannot be enforced: shell, network, subagent,
MCP and unknown tools (`NATIVE_HARNESS_TOOL_UNENFORCEABLE`). At run time, streamed tool
events are checked against the granted tools, the scratch root and the exact leased paths;
a violation, timeout or cancellation kills the whole process group
(`packages/harness/src/native/process.ts`). File changes are diffed after exit and admitted
only through `TestingWorkspace.write` under the task's write lease; one change outside the
lease, a deletion or an unsupported file admits nothing. The scratch copy is removed on
every path and swept on restart.

Not enforced: the native process runs as the host user without an OS sandbox, so reads
outside the scratch copy are detected from tool events rather than prevented, and host
managed settings still apply to the CLI. Its network use is limited to what the harness
itself does with its permitted tools (no network tools are granted); it is not isolated at
the network layer. The adapter is `declared_unverified` until conformance against the real
CLI is recorded.

Normal completion, cancellation and timeout independently force-remove the container
and its anonymous volumes before removing the staged files. Cleanup failure stops the
adapter; persistent failure retains staged files. Abrupt host-process termination can
leave a container and staging directory behind. On resume, the coordinator removes
saved unfinished containers before dispatching another check. Recovery uses a fresh
Docker configuration and validates the saved temporary directory before deletion.
Failed recovery stops verification. Tests cover the process boundary with an injected
Docker CLI and real bounded Node subprocesses; live Docker validation requires a
running Linux engine and remains an outstanding acceptance task in the
[completion plan](completion-plan.md#p04--validate-the-actual-docker-boundary).

`packages/security/src/command-policy.ts` classifies every command a plan proposes
(`classifyCommand`, `classifyPlannedCommand`) into `derived_repository_script`,
`allowlisted` or `requires_approval`, and `assertCommandExecutable` throws
`CommandRequiresApprovalError` rather than running one that needs a human. The
classification is re-resolved against the repository at execution time; a derived script
that has changed or disappeared becomes `requires_approval`.

Task IR carries the policy with the command (`taskCommandSchema` in
`packages/schemas/src/task-ir.ts`), so an executing agent cannot receive a command without
also receiving its execution policy.

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
2. **Storage.** `packages/persistence/src/private-store.ts` keeps secret-bearing state out
   of the run directory that gets transported or inspected.
3. **Egress.** `assertNoSecretEgress` in `apps/server/src/routes/control-plane.ts` is the
   single outbound pattern set for every HTTP route, including the evaluation routes; it
   fails the request rather than emitting a match. The CLI `report` command redacts through
   `redactSecrets` in `packages/security/src/redaction.ts` — the canonical detector set,
   versioned by `REDACTION_PATTERN_VERSION` — and fails closed if anything survives.

Redaction is applied to persisted artifacts too: what the UI shows is the redacted
persisted artifact, so a secret that was never written cannot be read back.

## Evidence bounds

`packages/tools/src/bounded-output.ts` caps tool output and records truncation with a
continuation reference rather than silently trimming.
`packages/tools/src/evidence.ts` validates that cited evidence ranges actually exist in the
snapshot, which is what makes `packages/workflow/src/nodes/validate-findings.ts` able to
reject an unsubstantiated finding deterministically, before any model is asked about it.

## What this does not defend against

Stated plainly, because a security document that lists only its strengths is the same class
of dishonesty as a fabricated metric:

- A model provider that returns malicious content is trusted to the extent that its output
  is parsed; the defence is schema validation and evidence-range checking, not attestation.
- Native harness mode is **not implemented**; if it were, the tool loop would run outside
  `packages/harness/src/canonical/adapter.ts` and the guarantees above would need restating
  for that path. See [`harness.md`](harness.md).
- Suppression candidates are an *uncertainty signal*. A determined injection that an
  auditor both read and cited would not raise one.
- The repository snapshot is trusted to be what Git reported. arbitra detects drift; it
  does not verify commit signatures.
