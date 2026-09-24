# Implementation notes through September 23, 2026

Archived on September 24, 2026. The following is a historical snapshot. Its unchecked
tasks, availability claims, priorities and validation results describe earlier stages
and must not be read as current status or instructions.

See [current project status](../project-status.md) and the
[completion plan](../../WORK-REMAINING.md) for the maintained sources.

---

# Remaining work

The public Testing executor now dispatches preflighted disjoint writer batches up to
the configured concurrency bound. Dependencies, shared paths, declared conflicts and
exclusive tasks remain serialized by the schedule. A batch acquires every lease before
model dispatch and waits for all writer promises to settle before releasing any lease
or starting serial verification. Failed batches preserve reserved attempt/tool history;
restart reuses successful sibling output without repeating writes. Exhausted attempts
stop the batch and prevent dependent dispatch. Whole-workspace final verification remains.

Focused writer/coordinator tests passed (21 scenarios), including a two-writer barrier
and interruption after one sibling had started. Public parallel dispatch is implemented;
automatic repair after final invalidation and live-provider/Docker QA remain open.

Full CI passed (311 runtime tests), production build passed, and whitespace checks passed.
Provider and sandbox results remain injected; no live-provider or Docker execution was
performed for this batch change.

Guarded Testing execution is now opt-in through the shared public runner. Configure
`workflow.testing.mode: "execute"` with strict execution authority and use the
`testing-execute` preset (or let mode select it). The graph runs planning, guarded
execution/finalization and rendering under the existing run lock and resume machinery.
Planning and execution share one durable model budget. The public gate requires actual
execution evidence and a verified completion/handoff; a passed plan alone cannot pass
an execution run. Empty selection remains explicit no-work, with no sandbox calls.

Public tests cover success, failed checks, interrupted writer resume and no-work results.
The source checkout remains unchanged. Parallel writer batches, automatic repair after
final invalidation, richer web execution views and live-provider/Docker acceptance QA
remain open. Configuration and artifact retrieval are documented in `docs/workflows.md`.

Full CI passed (308 runtime tests), production build passed, and all 15 public Testing
scenarios passed after adding the explicit execute-mode no-work case. Affected-file lint
and whitespace checks passed. Provider and sandbox results were injected; the Docker
Linux engine was unavailable at the last readiness check, so live QA remains unverified.

The following implementation notes record earlier milestones; their then-open public
wiring work is superseded by the public composition described above.

Trusted Testing execution options now have a shared strict schema consumed by the
executor. Partition/task identity, partition references, model-role presence, concurrency
and attempt bounds are validated before executor construction. Extra configuration keys
are rejected; portable-path and plan-scope authority still pass through security preflight.
All 18 schema/coordinator scenarios, runtime build, affected-file lint and whitespace
checks passed. The public mode now accepts explicit execute settings as described above.

Testing finalization now commits a durable completion reference before worktree cleanup.
Restart validates configuration, plan and change-set identity, finishes interrupted
cleanup, and returns the original handoff without creating another workspace or issuing
new model/check calls. A lost close acknowledgement is covered by a real-worktree fault
test. All 11 coordinator scenarios, runtime build, affected-file lint and whitespace
checks passed. Finalization is now used by the public execute stage.

Verified Testing changes now have an internal durable handoff. The coordinator rechecks
the workspace journal and final verification before exporting sorted UTF-8 create/replace
payloads with baseline and resulting content hashes. The handoff references final-check
artifacts and the exact plan/workspace fingerprints. It never applies changes to the
source checkout. Consumers must compare the destination bytes with each expected hash.

Failed/incomplete or stale verification, empty changes and unsupported deletion are
rejected. Content requiring secret redaction cannot be exported as if it were the exact
verified bytes; persistence is read back and compared before returning the handoff.
Successful handoffs remain readable after explicit worktree cleanup. Public execution
and handoff wiring, parallel writers, repair after final invalidation and live sandbox
QA remain open.

Full CI passed (303 runtime tests), production build passed and whitespace checks passed.
Handoff tests cover exact replacement bytes, baseline hashes, stale/failed evidence,
redaction, deletion, empty output, replay and retrieval after cleanup. Docker CLI is
installed, but its Linux engine pipe was unavailable during the readiness check; no
live container or provider execution was performed.

An internal whole-plan Testing coordinator now consumes the saved passed planning gate
and requires its fingerprint to match the exact plan. It validates every task's write
authorization, model routing and trusted command/check bindings before creating a
worktree. Execution configuration is pinned across resumes. Tasks currently dispatch
sequentially in dependency order; bounded parallel writer batches remain open.

The coordinator recovers sandbox resources before workspace preparation and stops
dispatch after an exhausted task. After all tasks complete, it verifies every task
against the final whole-workspace snapshot under distinct durable final-check identities.
Later changes that invalidate an earlier test, incomplete checks and exhausted verification
budgets fail the execution gate. Resume preserves completed attempt and final-check
evidence. Final failures currently block the run; automatic reopening of earlier tasks
after later fixture changes remains open, alongside public execution/handoff wiring
and end-to-end sandbox QA.

Full CI passed (296 runtime tests), production build passed and whitespace checks passed.
Nine coordinator scenarios cover dependencies, final invalidation, exhausted budgets,
terminal replay, configuration drift and rejection before worktree/model creation.
These tests use real Git worktrees with injected provider and sandbox results.

Testing now has an internal sequential model task loop. Each attempt pins its original
redacted repository context and prior verification feedback before model dispatch.
Resume reuses those bytes even after tool writes; changed task/model/lease bindings fail
closed. A bundled writer protocol and locked summary/limitations schema drive the
canonical leased tools. Live leases are released before trusted sandbox verification.

The loop recovers pending sandbox resources before writers, reserves durable attempts,
feeds bounded saved check diagnostics into retries, and promotes to frontier after two
deterministic failures. Passing, exhausted and incomplete terminal states replay without
new model calls or checks. Writer limitations prevent passing or promotion even when
commands exit successfully. The subsequent whole-plan coordinator is described above;
public execution/handoff wiring and end-to-end sandbox QA remain open.

Full CI passed (285 runtime tests) and the production build passed. Expanded retry-cap
and limitations scenarios subsequently passed with all 27 focused writer/verification
tests; affected-file lint and whitespace checks passed. Tests use real Git worktrees
with injected provider and sandbox results. No live-provider or Docker run was performed.

The canonical model harness now has a Testing-only writable extension. Its runtime
receives a live trusted lease separately from model arguments, and exposes bounded
current-file reads plus expected-hash file replacement through the workspace journal.
Reads honor configured source scope and paginate long Unicode lines without dropping
characters or separators. Audit, native and discovery contexts cannot enable the extension;
shell and network tools remain unavailable.

Tool-call identity includes activity, turn, position and provider call ID. Arguments and
scope are bound to durable results, so resumed tool turns return the original observation
without repeating writes. First execution returns the persisted/redacted representation.
An injected-provider interruption test exposed a general replay bug in multi-field tool
arguments: canonical serialization reordered schema-opaque argument keys between initial
execution and resume. Model activity outputs now normalize those keys before first use.

Full CI passed (282 runtime tests), and production build passed. Four new tool scenarios
cover recovery, stale leases, source scopes, cancellation, mode restrictions and Unicode
pagination; all passed after an additional native-mode guard. The subsequent internal
writer/task-loop implementation is described above. No live-provider or Docker execution
was performed.

Testing task verification now consumes the fresh journal-validated workspace. Trusted
command bindings select sandbox executable/arguments and expected exit codes; model
policy labels cannot authorize dispatch. Changed package scripts invalidate their prior
authorization. Every changed test path must have a configured check. No-change attempts,
budget exhaustion, interrupted checks, unavailable sandboxes, cleanup failures and writes
during verification produce incomplete evidence, not a passing result or promotion.

Verification reservations now optionally bind a task-attempt identity. The same attempt
replays after restart, while a new attempt can rerun identical source under the shared
durable run budget. Execution evidence records snapshot, invocation and policy fingerprints.
The bounded task-attempt ledger reserves before model dispatch, preserves pending IDs,
validates saved verification and execution provenance, and promotes directly to frontier
after two completed deterministic failures. Infrastructure failures consume the configured
attempt limit without advancing promotion; restart cannot reset or expand that limit.

These remain execution components. Public execution configuration, parallel writer dispatch,
execution handoff and end-to-end sandbox QA remain open.
Full CI passed (277 runtime tests) and production build passed. An existing handoff test
timed out once, then passed both focused execution and the full rerun. A final retention
fix preserves earlier incomplete observations when a workspace returns to identical bytes;
all 23 focused verification/attempt checks, affected-file lint and runtime build passed
after that change. Whitespace checks passed. Sandbox results in these tests are injected;
no live-provider or Docker execution has been performed.

Testing execution now has an owned detached Git worktree and durable workspace journal.
The worktree is seeded from the exact scoped snapshot in a fresh temporary repository;
the source checkout, its Git metadata, credentials, remotes and hooks are not shared.
Ownership is persisted before Git dispatch. File updates require live partition leases,
matching before-hashes and bounded content. Parent junctions, symlinks and hard links are
rejected. Atomic replacement and serialized filesystem updates preserve source files.

The workspace records each write intent before mutation, then its completion. Recovery
compares every worktree byte with baseline plus journal, adopts completed pending writes,
retries unapplied writes and rejects unrecorded changes. Ambiguous publication failures
invalidate in-memory readiness until durable recovery. Close intent precedes cleanup;
ownership markers survive partial child cleanup so recovery can retry safely.

These are execution components, not yet public autonomous execution. The coordinator
must remain the sole host writer; model/native processes cannot receive direct host
worktree write access. Public execution configuration and parallel writer dispatch remain open.
Real-Git and journal fault tests cover scoped writes, source preservation, links,
interruption before/after mutation and failed close. Full CI passed (260 runtime tests),
production build passed, and whitespace checks passed. No live-provider execution occurred.

Guarded Testing execution now has a write-partition scheduling preflight. Trusted
operator partitions are separate from planner proposals; all task grants are validated
before any schedule is returned. Concrete portable paths reject traversal, wildcard,
Windows device/stream aliases and control-plane writes. Live leases reject forged or
stale owners, overlapping paths across partitions, and file/ancestor conflicts.
Disjoint work can run together; shared fixtures, declared conflicts and dependencies
are serialized, with exclusive preparatory tasks and bounded concurrency.

This scheduling boundary is now used by the internal executor described above. Public
autonomous execution and parallel writer dispatch remain unavailable. A replacement
lease guard must not be created before recovering prior in-flight executors. Focused
partition/schedule regressions passed (22 tests); full CI passed (248 runtime tests),
production build passed, and whitespace checks passed. No live-provider execution occurred.

Testing planning now runs through the shared CLI/server runner with a frontier risk
analyst, complete candidate selection, coherent planner and deterministic handoff.
Inventory no longer suppresses a category on every surface merely because an unrelated
test uses that category. Common Python, Go and Ruby test names are recognized; framework
metadata is separated from source. Testing snapshots opt into manifests and configured
command evidence while retaining module/diff scope and binding resume to those bytes.

Risk surfaces require exact source quotes. Unreviewed source/test paths, analysis
limitations and missing repository-derived commands prevent a handoff. Every candidate
must be selected or explicitly rejected. Plans preserve gap/task/validation links and
premise uncertainty, reject production-file write paths and invented commands, and fail
the gate on blocking questions. Zero selected gaps produce an explicit no-work outcome,
not a coverage claim. Shared durable model activities recover from provider failure
without repeating completed stages. Commands remain unexecuted and source stays unchanged.

Focused coverage includes analysis replay, public CLI execution, metadata drift, empty
results, invalid evidence/selection, traceability and unsafe plan rejection. Documentation
and the Testing example now describe the public configuration. Guarded autonomous test
execution, native harnesses, dedicated web controls and expanded subgraph views remain open.
Validation: full CI passed (244 runtime tests), production build passed, and whitespace
checks passed. No live-provider or premise evaluation was performed.

Feature requirements review now supports bounded model-generated revisions through the
public runtime. `maximumRequirementsRevisions` defaults to one and accepts 0–3. Durable
reservations bind the exact checkpoint, model and immutable reviewer feedback; retries
reuse the same reservation rather than resetting the run limit. Revision drafts carry
explicit lineage, additions and a resolution claim for every blocking requirement.
Validation preserves acceptance responsibility, scope exclusions and high-impact
ambiguities. Limited review cannot generate a revision.

Automatic runs apply valid proposals then repeat exploration and independent review.
Interactive runs expose a separate proposal through requirements/status and require
`apply-requirements-revision` or the corresponding HTTP route before changing the draft.
Application revalidates recorded review and clears approvals; new high-impact defaults
require renewed decisions. Re-review receives immutable original feedback and resolution
claims. Continued disagreement stays blocked at the limit, including after restart.
Tests cover lineage/approval bypass failures, automatic and interactive paths, interrupted
generation and re-review, and repeated resume after exhaustion. Dedicated web checkpoints,
expanded Feature visualization, oversized contexts, Testing/native execution and the rest
of the execution queue remain open.
Validation: full CI passed (221 runtime tests), production build passed, and whitespace
checks passed. A subsequent regression confirms fresh review remains mandatory when an
operator edit lowers risk after model revision; all 18 public Feature integration tests
and their lint check passed. No live-provider or premise evaluation was performed.

Public Feature execution now runs through the shared CLI/server runner. Its dynamic
subgraph owns requirements checkpoints, grounded exploration, risk-directed independent
review, planning and the bounded revision/critic loop. Blocking approvals or unresolved
requirements review pause the subgraph; operator edits cause fresh stages for the new
contract while completed matching model calls replay. All stages share one durable
budget and provider scheduler. Successful plans publish a deterministic implementation
tree as an exportable artifact; source files remain unchanged. Limited exploration,
blocking plan questions and blocking/degraded criticism withhold the handoff and fail
the public gate.

Added strict `workflow.feature` settings, CLI requirements/approval/revision commands,
three localhost requirements routes and versioned status checkpoints. Stale approvals
return HTTP 409; edits require a blocked run. Public tests cover simple/high-risk mixed
providers, operator revisions, disputed review renewal, provider failure/resume,
budget suspension, cancellation and failed gates. The HTTP integration exposed and
fixed AJV coercing numeric model settings to strings inside recursive JSON unions;
body types now remain unchanged and trace pagination accepts explicit numeric text.
Model-generated requirements revision proposals, dedicated web checkpoint controls,
expanded Feature subgraph visualization, oversized Feature contexts and Feature-specific
replay remain open. Testing, native harness, advisor and the rest of the queue remain open.
Validation: full CI passed (201 runtime tests), production build passed. A subsequent
checkpoint-read regression keeps status/contracts readable after source changes while
still rejecting edits and resume; all 13 focused Feature runtime/HTTP tests, runtime
build and affected-file lint passed with that fix. Provider behavior remains fixture-backed.

Feature planning now composes the planner, independent critic, one bounded revision
and independent re-review through `modelFeaturePlanning`. Degraded reviews cannot
trigger revisions. Revised plans retain requirement/validation traceability, premise
provenance and existing unresolved questions, with exactly one resolution claim per
blocking item. Re-review receives the original plan, feedback and resolution claims;
an unchanged plan still gets a distinct re-review activity. Original/revised artifacts
remain durable, and restart reuses completed stages after final-review interruption.
Also fixed Feature premise comparison to ignore JSON property order and guarded planner
profile lookup against inherited keys. Public Feature graph/API composition,
model-generated requirements revisions and oversized Feature revision contexts remain open.
Validation: full CI passed (190 runtime tests) and production build passed. All 12
Feature integration scenarios also passed after retaining the original critic activity
identity for existing runs and strengthening the independent re-review instructions.
The tests use an injected provider; no live-model correctness is claimed.

Feature plans now have an independent model-backed critic using the pinned plan-critic
protocol and durable harness. Review is bound to the recorded planner profile, exact
plan and current requirements/exploration. Planner and critic both enforce current
requirements review. Rejected critique mappings, insufficient critic capability,
blocking feedback and blocking plan questions prevent a passing result. Integration
tests cover clean/blocked review, stale plans, independence and replay. Automatic plan
revision/re-review, model-generated requirements revisions and public Feature graph/API
composition remain open.

Requirements checkpoints now accept strict draft revisions against the current artifact
ID, retain parent-linked immutable versions, and clear interactive approvals whenever
the reviewed draft changes. Reverting text cannot revive a stale approval. Feature
exploration, review and planning identities now include contract/source context so a
revised and reapproved contract runs new stages rather than colliding with old durable
requests. Integration tests cover renewal, stale-review rejection and complete replanning.
Model-driven revision proposal generation, final plan criticism and public Feature graph
composition remain open.
Full CI and production build pass for requirements revision and renewed-approval handling.

Feature review now supports up to three bounded rounds. Follow-up reviewers receive
peer decisions without author metadata or their own prior vote, and reconsider them
against the unchanged approved contract. Each round has durable activity identity and
persisted reviewer/consensus artifacts; unresolved or revision-required items remain
blocking at the limit. Focused tests cover early agreement, reconsideration, exhaustion
and provider-backed replay across two rounds. Applying proposed requirements changes,
renewed approval, final plan criticism and public Feature graph wiring remain open.
Full CI and production build pass with bounded review rounds included.

Targeted Feature review now dispatches independent profiles through one shared durable
harness and budget, using a pinned review protocol. Reviewer results and consensus are
persisted. Planning requires matching review inputs when routing calls for review,
recomputes consensus from recorded votes, and rejects stale, disputed or limited review
coverage before model dispatch. The integration covers two reviewers and replay without
repeat calls. Bounded follow-up review/resolution rounds, final plan criticism and full
Feature graph/operator API composition remain open.
Full CI and production build pass for targeted review dispatch and planner gating.

Feature review now has a strict requirements-decision schema and grounded consensus
validator. Every reviewer covers every recorded requirement; evidence must match the
snapshot. At least two distinct reviewer IDs and independence groups are required.
Only unanimous acceptance clears a requirement; differing proposals stay unresolved,
and even agreed revisions remain blocking without mutating approved defaults. Four
focused regressions, runtime typecheck and affected-file lint pass. Model dispatch,
review rounds and Feature graph integration remain open.

Targeted Feature exploration now runs through the durable model harness with its own
pinned protocol. Strict preflight metrics, known requirement IDs, snapshot paths and
exact source quotations are validated before publishing exploration and routing.
Feature planning rejects ungrounded exploration before provider dispatch. Ten negative
and positive grounding regressions pass; the injected-provider integration covers
requirements, approval, exploration, routing, planning and replay in three provider
calls. Targeted multi-model review, criticism and full public Feature graph remain open.
Full CI and production build pass for the exploration integration.

Feature planning now has a model-backed runtime stage using the pinned planner protocol,
bounded repository context and durable canonical harness. It requires resolved approvals,
validates requirement/task/validation coverage, preserves the unmeasured premise report,
and publishes Plan IR only after validation. The injected-provider integration covers
requirements through approval and planning, including replay without repeat provider
calls. Full Feature graph, targeted exploration/review and public API composition remain
open; Feature mode is still unavailable through the public orchestrator.
Full CI and production build pass with the model-backed Feature planning stage included.

The Feature planner node now forwards the recorded requirements contract, refuses to
plan past unresolved high-impact approvals, and validates requirement/task/validation
links in both directions. Every acceptance criterion needs implementation and validation;
unknown requirements and detached validation links fail. Focused Feature planner and
workflow regression suites, workflow typecheck and affected-file lint pass. Model-backed
Feature planning and complete graph composition remain open.

Model-backed Feature requirements now invoke the durable canonical harness with the
pinned feature-requirements protocol, bounded source context, source tools, usage
recording and strict draft parsing. The stage feeds durable operator checkpoints;
an injected-provider integration test verifies restart and approval without a second
provider call. Runtime typecheck and affected-file lint pass. This stage is not yet
wired into a complete Feature graph, and the public runtime still rejects Feature mode.

Feature requirements now have shared strict draft and contract schemas. The requirements
node validates model drafts independently of its injected parser and rejects unknown or
duplicate operator approval IDs before persistence. Accepted defaults must match their
ambiguity, proposed value and decision authority; automatic mode records all defaults.
Eleven focused Feature regressions pass. Full Feature runtime composition and multi-model
requirements consensus remain open.
Full CI and the production build pass with the shared requirements validation included.
The requirements node now resumes interactive checkpoints from a selected saved
contract without regenerating model output. Partial approvals preserve prior decisions
and leave the original artifact unchanged; new approvals require a saved artifact.
Twelve Feature regressions, workflow typecheck and affected-file lint pass. Connecting
this checkpoint to the shared runtime/operator API remains part of Feature composition.
The shared runner now supports a persisted operator checkpoint as BLOCKED and rechecks
it on resume while retaining prior node completions. Also corrected shared budget/rate
suspension errors being misclassified as FAILED by exposing their declared state.
Runner regressions cover repeated blocking, approval resume, and both suspension types.
Runtime requirements checkpoints now retain immutable contract versions with a durable
current-version pointer. Restart loads the saved contract without generation; approvals
against stale versions or changed protocols fail. Approval operations are serialized
within the run's checkpoint instance. An integration regression verifies persisted
history, partial approval, restart and stale concurrent approval. Feature graph and
operator API wiring remain open.
Full CI and production build pass with runtime checkpoint persistence and runner
suspension handling included.
Checkpoint reuse now checks a canonical fingerprint of the unredacted feature request,
repository summary and mode. Changed context fails instead of silently reusing an old
draft; queued inputs and approval IDs are copied. Resume rejects changed modes and
cannot accept approvals through the draft-opening path. Checkpoint regression,
runtime typecheck and affected-file lint pass.

Executed Audit verification now includes a Docker adapter with pinned
images, structured command allowlists, source-only read-only snapshots, no network or
operator credentials, resource/output/time limits, and independent container cleanup.
Optional `verification.execution` is connected to the verification ladder, with durable
reservations, global run limits, cleanup on resume, cached completed checks and redacted
evidence supplied to the verifier. Exit codes never determine claim verdicts directly.
Deferred, interrupted and failed checks remain explicit coverage gaps. Docker-boundary tests use an injected
process port; subprocess limit tests execute real Node processes. Live container
validation is unavailable because the local Docker engine is not running.
Focused regressions cover resource registration before dispatch, recovery with a fresh
adapter, restart reuse, concurrency, zero budget and mixed-provider Audit integration.
Full CI and production build passed for this integration. A subsequent focused
regression also confirms that test exit zero cannot resolve a disputed claim when
model verification is disabled.
Follow-up hardening keeps decoded UTF-8 output within the configured byte cap even
for malformed bytes or truncated multibyte characters. Sixteen sandbox and five
execution-coordinator regressions pass, including failed recovery blocking all new
dispatch and changed source bytes preventing reuse of old evidence. Runtime typecheck
and affected-file lint pass.

Scope confirmed by the user: fix existing bugs and implement the unfinished features
documented in the repository. Support OpenAI, Anthropic, Gemini, and other providers
together; provider selection is configuration, not a project-wide choice.

## Execution queue

- [ ] Compose model execution through the shared CLI/server runtime, including provider
  endpoint bindings, independent discovery, peer review, verification, planning, critic,
  budgets, cancellation, durable replay/resume, and honest usage/provenance.
- [ ] Compose Feature workflows and full multi-model requirements consensus.
- [x] Compose Testing planning through the shared CLI/server runtime.
- [ ] Implement guarded autonomous test execution.
- [ ] Implement native harness adapters.
- [ ] Implement bounded advisor execution.
- [ ] Implement incremental/repeat audits.
- [ ] Implement provider batch execution.
- [ ] Implement workflow canvas editing and validation.
- [x] Implement the trace browser (visual browser QA pending an available browser).
- [ ] Evaluate local embedding clustering against the documented metrics before adopting it.
- [ ] Run real-model premise evaluation when a configured environment is available.
- [ ] Audit existing behavior for defects, add regression coverage, and run full CI/build.
- [ ] Update documentation to match verified behavior and record remaining limitations.

The existing implementation plan records the original 49 tasks as complete; it does not
prove these composition gaps or deferred features are complete. Passing scripted tests
also does not establish real-model correctness or the multi-model premise.

## Baseline evidence

- Worktree clean at `6789c59` before this work.
- GitHub has no open issues.
- `pnpm run ci` and `pnpm build` passed.
- Current scripted detectors reported no findings across 339 files.
- Runtime currently rejects model profiles, Feature/Testing modes, and native harnesses.

## Current work

Provider endpoint binding and invocation composition. Existing codecs cover OpenAI
Responses, OpenAI Chat, Anthropic Messages, and Gemini Native. Compatible endpoints
must be independently addressable even when they use the same wire protocol.

Implemented foundations:

- Endpoint registry for all four codecs, compatible services, and custom protocol factories.
- Model pool using the shared invocation runtime, explicit effort handling, limits,
  capability checks, service-bound continuation state, actual usage, and cancellation.
- Validated `workflow.modelExecution` settings and model/endpoint identity checks.
- Fixed request/trace model mismatch and inherited-key transport/rate-policy lookups.
- Continuation validation now precedes budget reservation.
- Durable token budgets reserve each attempt separately, serialize parallel admissions,
  retain unknown usage charges, and reload the same ledger after restart.
- Durable JSON model activities bind inputs, protocols and profiles to a fingerprint,
  reuse completed output, persist actual usage, and reject changed inputs on resume.
- Shared CLI/server Audit composition now executes configured OpenAI, Anthropic,
  Gemini and compatible services together. Model roles are explicit in
  `workflow.modelExecution.roles`; auditor profile IDs match preset auditor nodes.
- Independent discovery validates source schemas, exposure ranges, namespaces and
  exact evidence quotations. Peer review runs bounded independent rounds; targeted
  verification, Plan IR generation and critic execution use durable model activities.
- Resume/replay, cancellation and budget suspension have injected-HTTP end-to-end tests.
- Fixed inherited-key and invalid numeric line-range handling in finding validation,
  and made the audit-preset test independent of the command's working directory.

The composed model Audit path now integrates the canonical tool harness, pinned trusted
protocols, layered prompt compilation and complete model trace identity. Snapshot tools
are read-only and tool artifacts are isolated by activity. Discovery retains truncation
and coverage limitations. Planner validation rejects orphaned issue/task links,
duplicate IDs, invalid dependencies and cycles. Replay critic overrides change the graph.
Trace writes recover torn tails and serialize concurrent appends; atomic artifact writes
retry transient Windows rename errors. Failed parallel work is settled before stage exit.

The path now allocates discovery and later-stage context but does not yet integrate semantic clustering
escalation, executed verification tests or the complete anonymous peer-review operation
protocol follow-up review (the model path now supports typed operations with anonymous
source views, hidden own findings, policy-driven dispatch, round deltas and vote-flip
checks; contradictory proposals are preserved and deferred with explicit coverage gaps). It reports
degraded security coverage and an unmeasured premise. The broad model-execution queue
item remains open until those composition gaps are resolved.
Feature/Testing modes and native harnesses remain explicitly unavailable in the runtime.

Verification for these foundations: full CI and production build passed; schema tests
also passed after adding model/endpoint cross-reference coverage. Provider wire tests
use injected HTTP clients. No live-provider execution or premise measurement is claimed.

Latest integration verification: full CI passed after the composition edits; 94
runtime/core tests also passed from the workspace root, including mixed-provider full
Audit, failure/resume, replay, budget suspension and cancellation. Subsequently corrected
Anthropic total input accounting to include cache reads/writes: 58 provider and model
orchestrator tests passed (4 live-provider tests skipped), affected-file lint passed,
and the full production build passed. No real-provider key was used.

Latest checkpoint: full CI and production build passed after the protocol, harness,
trace, planner and replay integration. Subsequently fixed ignored verification question
limits and the examples' verification protocol selector; 18 focused workflow/runtime
tests passed, including zero model questions and deterministic checks after exhaustion.
Full CI and the production build also passed with those fixes included.

Peer-review dispatch integration now uses the workflow policy/round implementation.
Model context strips source author IDs, aliases evidence and location references, and
omits candidates with only the reviewer's own findings. Citation aliases are resolved
outside model context. Earlier votes/objections survive delta omission, actual changes
drive subsequent rounds, and dispatch provenance is recorded. Added focused isolation,
repeatability, own-source exclusion, conformity and all-three-policy integration tests.
Full CI and the production build passed after this peer-review integration.

Board mutation groundwork: merge/split now retain supporting and counter-evidence,
source provenance and remediation/verification supplements. Votes stay on their original
claim and do not silently approve transformed claims. Retired candidates cannot be
reactivated or merged again. Identical inherited evidence is deduplicated; conflicting
evidence identities fail validation. Added a strict schema for every canonical board
operation and wired it into validation before persistence. The controller owns copies
of queued/initial operations, and projected evidence is deeply frozen. Ten reducer tests
pass, including lineage context, retirement, malformed payloads and caller mutation.
These changes prepare the remaining model-operation composition; they do not enable it.
The round validator now accepts merge/split/new-finding targets with valid provenance,
rejects hidden or retired merge sources and colliding targets, and rejects unknown or
duplicate operations. Verification metadata is explicitly validated by the strict board
schema. Focused reducer, handoff and peer-review/runtime regression suites pass.
Full CI and the production build passed with these board and round-validator changes.

Typed model operations are now composed: validated local IDs are rebound to reviewer
provenance; added evidence is grounded against snapshot paths, ranges and quotations.
The append-only board applies mutations, retains lineage and routes only active claims
to consensus/verification/planning. Counter-evidence and supplements reach canonical
issues; new source records and compatible UI operation envelopes are published. Added
translator regressions and a mixed-provider full-audit test that adds counter-evidence,
supplements verification and splits a claim. Structural edit conflicts still fail
validation rather than undergoing adjudication; this is remaining work. Further tighten
source/evidence identity constraints and test conflicting model proposals before closing
the complete peer-review integration item.
Verification: full CI and production build passed after typed-operation composition,
including 63 runtime tests and the new structural-edit end-to-end regression.

Conflict handling now groups overlapping structural edits transitively, defers every
proposal in a conflict, and preserves nonconflicting evidence/votes. Contradictory severity
and blocker changes are also deferred. The original claims stay active and are escalated
to verification; conflict records reach planning and canonical coverage, so verification
cannot silently erase structural uncertainty. Tests cover order independence, transitive
overlap and a complete mixed-provider run with competing split proposals. Discovery
evidence/location IDs are namespaced by source finding before board assembly, preventing
reused IDs from collapsing unrelated evidence on merge. New missing findings must own
their cited locations and match their attached evidence. Remaining peer-review work:
present anonymous conflict deltas to reviewers and allow explicit evidence-backed conflict
resolution across rounds, rather than carrying all conflicts to planning unresolved.
Full CI and production build passed after conflict handling and evidence namespacing.

Discovery context now uses module-first allocation through the import-topology library.
It measures compiled prompts including tools/schema/framing/output reserve, uses a
configurable maximumDiscoveryTokens budget and respects the model's known context limit.
Scope-specific tools are restricted to assigned files, and scope/harness identities are
bound to durable activity fingerprints. Oversized modules split at file boundaries;
oversized files and lost joint module context are explicitly unexamined. Aggregate findings
retain unique scoped IDs, coverage and validation across independent calls. Initial full
CI passed; 28 focused tests passed after the final budget/coverage refinements.
The production build also passed with those refinements included.

Later-stage context allocation now prioritizes cited source and import neighbors, falls
back to line-numbered excerpts, and records full/excerpted/omitted paths. Required issues,
evidence, conflicts and plan data remain intact; mandatory inputs that cannot fit fail
explicitly. The maximumContextTokens policy applies across canonical model turns. Tool
history compaction archives whole exchanges into activity-local readable artifacts,
preserving the initial prompt and call/result pairing. Added a full mixed-provider run
with a large unrelated file plus context, history and archive-isolation regressions;
21 focused tests passed. Very large mandatory candidate/plan sets still need batching
or hierarchical composition rather than dropping required records.
Full CI and production build passed. A subsequent harness regression also passed,
confirming overflowing history is archived and identical turns are reused after restart;
affected-file lint passed with that test included.

Next integration work: executed verification where permitted and remaining individually
oversized model contexts. Continue the remaining Feature/Testing, native
harness, advisor, incremental audit, batch, canvas and trace-browser queue above.

Semantic clustering now runs through the durable model harness after validation, using
the verifier profile and a bounded maximumClusteringPairs policy (default 20; zero
disables). Anonymous pair inputs retain source locations, model rationales are persisted,
and unclassified pairs remain separate. Aggregate unknown usage/cost stays null while
provider turn traces remain authoritative. Regression coverage exercises zero/one/three
pair budgets and restart after downstream failure. Real-model clustering quality and
embedding evaluation remain unmeasured.
Validation: full CI, production build, and diff whitespace check passed; 84 runtime tests include bounded semantic escalation and restart reuse.

Peer conflict follow-up is now composed before later review rounds. Each configured
auditor sees anonymous proposal content and source evidence through a pinned protocol
and durable calls. Applying one proposal or retaining originals requires unanimous
evidence-backed agreement plus configured quorum and independence. Changed selections
require newly cited evidence. Missing reviewers, disagreement and stale claims remain
unresolved. Resolved proposals and votes are retained separately, followed by ordinary
review of active claims. Added agreement, disagreement, identity, citation, conformity
and restart regressions.
Validation: full CI passed with the resolution path; after adding the pinned resolution protocol and restart regression, 19 focused tests, affected-file lint, and production build passed.

Oversized peer-review candidate sets now partition against compiled context estimates.
Every candidate gets one full review, with namespaced local output IDs per batch. All
pairs separated by the partition receive merge-only follow-ups; their additional work
shares durable token/rate budgets rather than silently dropping global merge coverage.
Batch manifests and activity identities replay deterministically. Single candidates or
pairs that cannot fit fail explicitly. Added complete candidate/pair coverage, oversized
context, collision prevention, and downstream-failure restart regressions. Large
mandatory planner/critic payloads and individually oversized candidates remain open.
Validation: full CI (94 runtime tests), production build, and diff whitespace check passed after peer context batching.

Critic context batching now reviews complete task/issue/validation records and every
cross-batch pair while retaining global dependency, traceability, routing and scope
metadata. Partial context is labelled, feedback IDs are scoped per batch, and actual
critic batch counts are persisted. A composed regression resumes after the second batch
fails without repeating the first, and confirms all feedback survives aggregation.
Rejected mappings and duplicate critic item IDs now degrade coverage rather than allowing
a silently clean review. Global metadata and individually oversized records still fail
explicitly; large planner composition remains open.
Validation: full CI passed for critic batching and degraded coverage; subsequent restart/feedback regressions passed (4 runtime and 18 workflow focused tests), affected-file lint and production build passed.

The model audit runtime now performs at most one planner revision after a complete,
non-degraded critic review reports blocking findings. The same planner profile returns
a full Plan IR and an explicit resolution for every blocking item. Traceability, exact
accepted issue coverage, audit mode and premise provenance are checked before a second
independent critic review. That review receives the original feedback and proposed
resolutions as untrusted claims. Remaining blocking feedback still fails the gate.
Original plan/critique, revision output and final review remain durable; restart reuses
completed work. Oversized revision inputs still need hierarchical planner composition.
Validation: full CI (102 runtime tests), production build, and whitespace check passed. Revision regressions cover independent re-review, persistent blockers, invalid traceability, missing resolutions, and restart after a failed final review.

Fixed the evaluation API placeholder that reported no provider activity for model runs.
Metrics now read authoritative traces, using the same identity aggregation guard as
SQLite queries. Model/harness/protocol segments remain separate in the UI. Counts,
latency, known token/cost totals and weighted cache rates are operational measurements;
ground-truth quality remains unavailable. Comparisons now load exact protocol/run
selections, reject cross-protocol comparison and distinguish absent matching activity.
Verification resolution includes deferred items. Added a composed mixed-provider
metrics/comparison regression. The full trace browser remains open.
Validation: full CI (103 runtime tests), production build, and diff whitespace check passed for trace-backed operational evaluation and protocol comparison.

The trace browser now exposes recorded attempts through the shared runtime and three
schema-validated localhost routes. Lists filter by node, model, protocol, outcome and
activity substring, with bounded pagination and stable append-log IDs. The new Traces
tab (`?run=<id>&view=traces`) shows complete identity, requested/resolved effort, usage,
refusals/errors and immutable input/output artifacts. Artifact lookup is limited to
references on the selected trace, verifies the content hash, and uses the HTTP secret
guard. Replacing a named artifact cannot change historical trace inputs. Unknown
measurements remain unavailable; content renders as untrusted text. Run changes discard
stale requests and selections, and run events or manual refresh reload the list.
Trace reads also reject records belonging to a different run.

Validation: full CI and production build passed; 31 focused runtime/server/web tests
passed, including a mixed-provider run loaded through a fresh orchestrator, plus seven
persistence trace regressions passed after adding the run-identity check. Visual browser
QA remains pending: the browser runtime reported no connected browsers. The server still
reads the full trace log for each paginated query; a persistent index for very large logs
is a future optimization. The other execution-queue items remain open.

Oversized initial planner inputs now use one selected planner across complete issue
reading batches, a single global validation/task outline, and task expansion against
the original assigned canonical records. The outline owns decomposition, scope, routing
and the dependency graph; expansions cannot silently change those decisions. Missing or
duplicate issue briefs, dropped questions, invalid traceability and changed task outlines
fail validation. Newly raised blocking questions survive assembly and now fail the run
gate independently of critic feedback, fixing the gate's previous omission. Logical
planner request counts are recorded separately from provider attempts and spend.

A mixed-provider regression exceeds the planner's context budget, fails the second task
expansion, restarts, reuses completed briefs/outline/expansion, and completes all four
tasks with global dependencies intact. Complete canonical records reach both reading
and expansion. Individually oversized records/task assignments, oversized global
metadata, and oversized planner revision inputs remain open; the broader execution
queue is unchanged.

Validation: full CI passed (118 runtime tests and 104 workflow tests), production build
passed, and the diff whitespace check passed after staged planning and the plan-question
gate fix. No live-provider behavior or premise measurement is claimed.

Oversized planner revisions now use atomic patches within the same single revision
pass. Each blocking critique receives complete selected task bodies, direct dependency/
conflict neighbors and relevant canonical issues. Every patch validates the full global
plan, leaves unselected task bodies unchanged, preserves unresolved questions, and
records task lineage so subsequent critiques follow replacements or reintroduced work.
Re-review batches keep every original critique paired with its resolution claim and
cover all current task/issue/validation relationships. Original summary text is retained.
Fixed a provenance comparison that incorrectly rejected persisted reports solely because
JSON field order changed. Complete-plan revisions remain the path when their input fits.

Regression coverage includes an interrupted second patch, restart reuse, full independent
re-review with resolved and persistent blockers, task replacement with reciprocal
dependencies, retirement/reintroduction, altered scope, lost questions, invalid lineage
and unchanged-task preservation. Individual critique contexts, global metadata and
required re-review pairs that still cannot fit remain explicit limits.

Validation: full CI passed with 135 runtime tests, and production build passed. After
adding negative resolution-mapping cases, all seven critic-context tests and their lint
check passed. Resume and persistent-blocker regressions use injected mixed-provider HTTP
responses; no live-provider correctness or premise measurement is claimed.
