# Remaining work

Scope confirmed by the user: fix existing bugs and implement the unfinished features
documented in the repository. Support OpenAI, Anthropic, Gemini, and other providers
together; provider selection is configuration, not a project-wide choice.

## Execution queue

- [ ] Compose model execution through the shared CLI/server runtime, including provider
  endpoint bindings, independent discovery, peer review, verification, planning, critic,
  budgets, cancellation, durable replay/resume, and honest usage/provenance.
- [ ] Compose Feature workflows and full multi-model requirements consensus.
- [ ] Compose Testing planning and guarded autonomous test execution.
- [ ] Implement native harness adapters.
- [ ] Implement bounded advisor execution.
- [ ] Implement incremental/repeat audits.
- [ ] Implement provider batch execution.
- [ ] Implement workflow canvas editing and validation.
- [ ] Implement the trace browser.
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

Next integration work: large mandatory-context batching;
executed verification where permitted. Continue the remaining Feature/Testing, native
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
