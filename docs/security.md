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
   secret.
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
