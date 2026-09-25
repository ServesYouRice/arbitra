# Completion plan

Updated September 25, 2026 against commit 64f887e (branch `beta`). Original baseline: 77149ef.
See [status](#status-september-25-2026) for each item.

This plan covers every unfinished implementation, validation and usability step identified
in the project review and the previous execution queue. The
[project status](project-status.md) records implemented behavior and measured evidence.
Earlier notes are [archived](history/implementation-log-through-2026-09-23.md).
The original 49-task completion count is not reused for this plan.

## Completion rules

- Each item needs its described behavior, relevant regression coverage, and retained
  verification evidence before its checkbox is completed. A schema, interface, fixture
  or successful build alone does not complete a runtime feature.
- Mark work requiring actual provider, Docker or browser behavior complete only after
  that environment has been exercised. Record commit, platform, configuration/protocol/
  model/harness identity, commands, results and redacted artifact/run references.
- Distinguish passed, failed, unavailable and unsupported cases. Unknown usage/cost stays
  unknown. A negative premise result or decision not to adopt embeddings is a valid result.
- Keep the shared orchestrator, six node kinds, durable identities, bounded budgets,
  discovery independence and operator-controlled write authority. New features must
  preserve these contracts rather than introduce a second workflow engine.
- Dependencies below are required for final acceptance. Fixture-based implementation
  and other independent work can proceed while an external validation environment is
  unavailable; its outstanding acceptance evidence must remain explicit.

This is an execution order, not a calendar estimate. P01–P06 establish reliable live
evidence; P07–P11 finish recovery, scale and operator workflows; P12–P18 complete the
previously deferred extensions and evaluation; P19 closes the whole queue.

## Queue and dependencies

| ID | Deliverable | Acceptance dependencies |
|---|---|---|
| P01 | Test discovery and platform reliability | None |
| P02 | Reproducible model/workflow setup and runnable examples | P01 |
| P03 | Live-provider conformance and public workflow acceptance | P02 |
| P04 | Real Docker verification and Testing execution acceptance | P02 |
| P05 | Persistent evaluation corpora and evidence provenance | P01 |
| P06 | Real-model premise evaluation | P03, P05 |
| P07 | Repair after final Testing invalidation | P04 |
| P08 | Remaining oversized-context composition | P03 |
| P09 | Authoritative gates and generic durable checkpoints | P01 |
| P10 | Feature/Testing web controls, subgraphs and browser QA | P02, P07, P09 |
| P11 | Feature/Testing replay semantics | P07, P09 |
| P12 | Native harness adapters | P03, P04, P07 |
| P13 | Bounded advisor runtime | P03, P09 |
| P14 | Incremental/repeat audits | P03, P05, P08 |
| P15 | Provider batch execution | P03 |
| P16 | Workflow canvas editing and runtime dispatch | P09, P10 |
| P17 | Persistent trace query index | P01 |
| P18 | Local embedding clustering evaluation and adoption decision | P05, P06 |
| P19 | Final defect review and completion evidence | P01–P18 |

## Status, September 25, 2026

Measured on macOS 26 (arm64), Node 22.23.2, pnpm 10.24.0, commit 64f887e: `pnpm run ci`
and `pnpm build` exit 0 (runtime 441 passed / 2 skipped, providers 79 / 7 skipped, harness
28, web 81, CLI 54, server 37, all other suites passing). No provider credentials, Docker
engine or native harness binary were available, so every live check below is outstanding.

| ID | Status | Evidence here | Outstanding before the checkbox |
|---|---|---|---|
| P01 | Implemented | Zero-discovery now fails; testing suites run (5 files, 22 tests at the fix); measured runtime/web limits; macOS CI green | Linux CI run of the same commit |
| P02 | **Complete** | Six model-backed templates over all four protocols; `docs/setup.md`; preflight diagnostics; credential-free smoke run of every template | — |
| P03 | Pending | — | Credentials and bounded spend for every protocol |
| P04 | Pending | Sandbox preflight checks `docker info`/image inspection | A local Linux Docker engine and pinned image |
| P05 | **Complete** | Durable corpus journal/artifacts; restart, idempotent import, torn tails, conflicts, denominators, incomparable aggregation, redacted reconstruction | — (no driver feeds it until P06) |
| P06 | Pending | — | P03 plus a prespecified live evaluation |
| P07 | Implemented | Bounded durable repair; 10 regression tests with the injected sandbox | Critical cases repeated with the real sandbox (P04) |
| P08 | Implemented | Nine size failures replaced by staged composition; output-limit detection on all transports; inventory in `docs/harness.md` | Global planner outline, Feature requirements/exploration and Testing risk analysis still fail explicitly; live context limits (P03) |
| P09 | **Complete** | Generic gate/human checkpoints, persisted versioned decisions, CLI/HTTP/graph agreement, restart and double-response tests | — |
| P10 | Implemented | Feature/Testing views; 14 Playwright scenarios passing on Chromium, Firefox and WebKit (42 runs) ([`qa/p10`](qa/p10/README.md)) | Browser runs on a non-macOS platform |
| P11 | Implemented | Mode-specific replay contracts; CLI/HTTP parity; source immutability | Changed protocol/scope exercised end to end (currently contract-level) |
| P12 | Implemented | Claude Code adapter for the Testing writer, `declared_unverified`; stand-in process tests; opt-in conformance test | Conformance against a real `claude` binary (assumptions A1–A8 in `translation.ts`) |
| P13 | Implemented | Durable, capped advisors for Testing writers; injected-transport tests | One live-provider path (P03) |
| P14 | **Complete** | Opt-in incremental Audit; identical rerun 0 calls; full vs incremental fixture 25 → 21 calls with identical issues | — (live measurement belongs to P03/P06) |
| P15 | Implemented | Opt-in batch lane; OpenAI/Anthropic/Gemini drivers against injected HTTP, all `declared_unverified` | Live validation of each driver; operator CLI/HTTP for uncertain submissions |
| P16 | **Complete** | Versioned saved graphs, server validation, runtime dispatch/resume of the saved version, editor with undo/redo and dirty guard; 3 editor scenarios × 3 browsers plus the P10 suite, 51/51 runs ([`qa/p16`](qa/p16/README.md)) | — (Audit mode only; documented) |
| P17 | **Complete** | Persistent per-run trace index; differential tests; 100k-trace benchmark (warm p95 2–19 ms vs ≈1 s full scan) | — |
| P18 | Pending | — | P06 data; no adoption without it |
| P19 | Pending | Cross-cutting fixes found during this work (artifact-store publish race, silently ignored `budgets`) | Final review after live acceptance |

## P01 — Repair test discovery and platform reliability

- [ ] Complete P01.

**Implementation.** Quote the fixture exclusion in [packages/testing/package.json](../packages/testing/package.json)
and make zero discovered tests fail for packages with required suites. Correct the
macOS canonical-path expectation in [orchestrator.test.ts](../packages/runtime/test/orchestrator.test.ts).
Investigate runtime timeout sensitivity, filesystem contention and cleanup after timeout;
use measured per-suite limits and deterministic teardown rather than blanket retries.

**Acceptance.** The normal CI command discovers the five currently skipped testing
files and their 22 tests, and passes on Linux and macOS without ad hoc command overrides.
The HTTP integration runs in an environment permitting localhost listeners. Full CI
and build pass; a missing-suite negative control fails. Record the resulting test counts.

## P02 — Make model and workflow setup reproducible

- [x] Complete P02.

**Implementation.** Provide validated, runnable configuration templates for model Audit,
interactive/automatic Feature, Testing plan and Testing execute. Cover all four existing
wire protocols and a mixed-provider configuration without hard-coded model catalogs or
credentials. Document endpoint/role binding, capability provenance, budget limits,
source scope, native-mode rejection, Docker prerequisites and handoff consumption.
Coordinate additions with [example validation](../examples/validate.test.ts).

**Acceptance.** A fresh checkout can follow the documented setup, validate each
configuration and run credential-free fixture smoke checks through the public runtime.
Missing roles, credentials, images, capabilities and authority produce actionable
preflight errors. Model-backed examples are distinguished from schema-only examples.
The setup does not enable live spend or write authority implicitly.

## P03 — Build and run live-provider acceptance

- [ ] Complete P03.

**Implementation.** Add an opt-in runner using the production provider registry and
orchestrator. The existing [conformance test](../packages/providers/test/conformance/real-provider.conformance.test.ts)
only checks supplied report booleans; replace that as the evidence source with
provenance-bearing results from actual invocations. Add a credentialed manual/scheduled
CI workflow with explicit token/time limits and redacted evidence retention.

**Acceptance.** Exercise OpenAI Responses, OpenAI Chat, Anthropic Messages, Gemini
Native and a compatible endpoint, including a mixed-provider run. Cover declared
structured output, tools, usage/cache accounting, refusals, context limits, cancellation,
timeouts, retries and continuation where supported. Record unsupported capabilities;
separate simulated failure cases from live observations.

Run public Audit, interactive/high-risk Feature and Testing planning through CLI/server,
then reload from a fresh process and inspect artifacts/traces. Prove budgets, blocking
decisions and resume behavior. Hand an exported Audit/Feature plan to a fresh executor
in a fixture checkout and verify its contract; the existing scripted-plan
[handoff runner](../packages/testing/scripts/run-real-handoff.ts) is not sufficient evidence
of live Audit. Findings and plans receive human/fixture-grounded correctness review.

## P04 — Validate the actual Docker boundary

- [ ] Complete P04.

**Implementation.** Establish a reproducible local Linux Docker engine and digest-pinned
test image with dependencies already installed. Exercise [test-sandbox.ts](../packages/runtime/src/test-sandbox.ts)
and the public Testing executor using real containers and model writers.

**Acceptance.** Cover successful/failed checks, command-binding drift, unavailable images,
budgets, timeout/cancellation, process interruption, restart cleanup and parallel writers.
Verify read-only check mounts, absent network/credentials, resource/output limits and
source-checkout preservation. Inspect the exported hashes/bytes and apply them to a
separate matching fixture; stale destination hashes must reject application.
Actual container runs and injected process-port tests are reported separately.

## P05 — Persist evaluation data and its provenance

- [x] Complete P05.

**Implementation.** Implement durable stores behind [the corpus interfaces](../packages/core/src/eval/corpora.ts)
for real-world outcomes and independence observations. Persist versioned ground truth,
run/snapshot/protocol/model/harness identity, adjudication and nullable measurements.
Reuse the journal/artifact/index conventions in packages/persistence.

**Acceptance.** Observations survive restart, imports are idempotent, partial writes recover,
and conflicting identities fail. Queries retain denominators and refuse incomparable
aggregation. Exported reports can be reconstructed from saved artifacts without exposing
credentials or changing historical judgments silently.

## P06 — Measure the real-model premise

- [ ] Complete P06.

**Implementation.** Connect the public runtime to an evaluation driver and the existing
[premise scorer](../packages/testing/src/metrics/premise.ts). Use multiple repositories
with independently reviewed defects and decoys, keeping answers out of model context.
Compare a strong single-model baseline, repeated isolated runs of that same model,
heterogeneous auditors, and the full reconciliation/verification pipeline. Preserve
real independence-group identities; repeated calls are not additional model families.

**Acceptance.** Prespecify budgets, fixture selection, repetitions and scoring criteria.
Report precision/recall, false positives, unique/marginal contribution, evidence/severity
and plan correctness, verification accuracy, cost and latency with denominators and
uncertainty. Retain adverse and null results. Produce a reproducible decision about
when extra auditors are worthwhile; success does not require a positive result.
Keep the existing smoke-test interpretation truthful and identify any broader experiment
separately. Do not treat the current environment flag as a live evaluation implementation.

## P07 — Repair tasks invalidated by final verification

- [ ] Complete P07.

**Implementation.** Extend [the Testing coordinator](../packages/runtime/src/testing-plan-executor.ts)
to reopen an earlier task when later fixture/test changes invalidate it. Determine the
affected dependency/conflict closure, invalidate stale verification and handoff evidence,
and schedule bounded repair through the existing writer/lease/check machinery.
Persist repair lineage, attempts and shared run limits across restart.

**Acceptance.** A later task breaks an earlier passing check, a bounded repair restores
the final workspace, and only exact final verified bytes are exported. Cover interrupted
repair, shared fixtures, exhausted budgets, oscillation, cancellation and unrecoverable
failure. No new write scope, duplicate completed write or stale completion is accepted.
Repeat the critical success/failure cases with the real sandbox.

## P08 — Finish oversized-context handling

- [ ] Complete P08.

**Implementation.** Inventory every remaining explicit size failure across discovery,
Audit records/global indexes/re-review pairs, Feature requirements/exploration/revision,
and Testing analysis/selection/planning. Extend bounded chunking, staged composition and
artifact-backed retrieval while preserving exact evidence, cross-record coverage and
global traceability. Add output-capacity handling as well as input accounting.

**Acceptance.** Representative repositories and mandatory payloads that currently cannot
fit complete through the new paths under known context/output budgets. No required
finding, requirement, gap, dependency or critique is silently omitted. Interrupted
stages resume without repeating completed model work. Document irreducible limits and
explicit failures; retaining the current size error alone does not complete this item.

## P09 — Unify gates and generic durable checkpoints

- [x] Complete P09.

**Implementation.** Preserve working Feature requirements checkpoints while connecting
generic human/gate nodes to persisted decisions and the authoritative run policy.
The current Audit graph's fallback gate/human callbacks return success/acknowledgment,
and the server's generic registry is in-memory. Shipped Audit graphs do not currently
dispatch those node kinds; they must not become implicit approvals for editable graphs.

**Acceptance.** Unknown/unconfigured policies fail explicitly. Graph state, CLI status,
HTTP responses and the public quality gate agree. Generic checkpoints survive process
restart, require current versioned decisions and reject stale/double responses.
Automatic versus interactive behavior is explicit; no human node auto-acknowledges
an unresolved decision. Existing Feature approval/revision regressions remain intact.

## P10 — Finish the operator interface and browser QA

- [ ] Complete P10.

**Implementation.** Add Feature contract inspection, approval, draft revision, proposal
application and explicit resume using the existing requirements API. Add Testing
configuration/authority review, plan-versus-execution state, task attempts, check results,
repair status and verified change download. Expand Feature/Testing subgraphs from
recorded stages while retaining the shared six-kind vocabulary and design language.

**Acceptance.** Browser scenarios cover blocked/stale approvals, reload/resume, failed
checks, repair, cancellation, no-work results and handoff retrieval. Perform visual and
keyboard QA on the graph, issues, plan, evaluation and existing trace browser; test
filters/pagination, historical artifacts, untrusted text and unknown measurements.
Record screenshots/results on supported browser/platform combinations.

## P11 — Define and implement Feature/Testing replay

- [ ] Complete P11.

**Implementation.** Add mode-specific replay contracts rather than treating Audit policy
overrides as Feature/Testing semantics. New runs retain source lineage and immutable
contracts; changed requirements, scope, authorization or verification invalidate affected
stages. Keep same-run crash resume distinct from replay.

**Acceptance.** Compatible saved stages are reused and incompatible ones regenerate
with correct budget/provenance. The source run stays unchanged. Planning replay cannot
dispatch writers or checks. An execution replay is a new explicitly authorized execution
with its own worktree and fresh evidence. Cover stale contracts, missing artifacts,
changed models/protocols and CLI/server parity.

## P12 — Implement native harness adapters

- [ ] Complete P12.

**Implementation.** Implement the [HarnessAdapter port](../packages/harness/src/adapter.ts)
with an explicit supported harness/version/mode matrix, starting with a concrete native
Testing adapter. Translate structured events, tools, usage, cancellation and failure into
the shared runtime. Add further adapters for each harness declared supported.
Do not nest another orchestration engine.

**Acceptance.** Run conformance against the actual native process. Enforce isolation,
lease-mediated writes and recorded harness identity; refuse modes/policies the adapter
cannot enforce. Canonical independent discovery retains its strict baseline; native
results are never silently pooled with canonical premise measurements. Verify crash
recovery, unknown usage, tool limits and cleanup under real execution.

## P13 — Implement bounded advisors

- [ ] Complete P13.

**Implementation.** Consume Task IR advisor routing and maximum-use fields through durable
activities, with explicit context, capability, token and use limits. Record advisor
identity and measured usage separately. Advice is input to the authorized executor;
it cannot grant tools, writes or policy exemptions.

**Acceptance.** Restart cannot reset use limits or duplicate completed advice. Cover
exhaustion, failure, cancellation, conflicting advice and unknown usage. Advisor calls
remain disabled in round-zero discovery and cannot expose peer findings there.
Exercise one supported live-provider path.

## P14 — Implement incremental and repeat audits

- [x] Complete P14.

**Implementation.** Use snapshot identities, Git changes, dependency/inspection footprints,
hotspots and persisted outcomes to select reusable work and affected surfaces. Bind reuse
to exact source, scope, protocol, model/harness and policy identities; fall back to a full
audit where safe reuse cannot be established.

**Acceptance.** Repeated identical runs avoid eligible model work. Changes to cited
lines, imports, manifests, exclusions or policy invalidate the required findings/stages.
Compare full and incremental results on fixtures with moved, fixed and recurring defects;
report saved work and any coverage degradation. Test restart and partially reusable runs.

## P15 — Add provider batch execution

- [ ] Complete P15.

**Implementation.** Add an explicit batch lane and provider-specific drivers behind the
registry for services whose verified capabilities support batching. Persist submission
identity, provider job IDs, per-item results, polling/cancellation and budget accounting.
Keep interactive tasks on their existing path.

**Acceptance.** Out-of-order/partial/failed results preserve item and trace identity.
Lost acknowledgments or restart cannot blindly resubmit billable work; handle provider
idempotency and uncertain submissions explicitly. Test cancelled and late results,
unknown spend and unsupported endpoints. Validate each declared batch driver live.

## P16 — Implement workflow canvas editing and execution

- [x] Complete P16.

**Implementation.** Add editing, validation, save/versioning and execution for operator-authored
graphs. The current runtime dispatches registered presets; extend validated runtime
dispatch together with the editor. Reuse graph schemas, edge/context contracts, six
node kinds and the gate/checkpoint behavior from P09.

**Acceptance.** A saved edited graph is the graph that executes and resumes. Reject invalid
edges, unbounded loops, missing model roles and unauthorized control-plane/write changes.
Implement undo/redo, dirty-state handling and keyboard interaction with browser tests.
Model-generated dynamic workflows remain outside the product scope.

## P17 — Index large trace histories

- [x] Complete P17.

**Implementation.** Replace full-log reads on each trace query with a persistent,
rebuildable index while keeping the committed trace journal authoritative. Preserve
stable IDs, filters, pagination, redaction and immutable artifact lookup.

**Acceptance.** Indexed and journal queries agree after append, restart, torn-tail recovery
and rebuild. Establish a representative history-size target and measured latency/memory
budget; demonstrate query cost no longer requires scanning the entire log on every page.
The trace browser retains its current identity and artifact guarantees.

## P18 — Evaluate local embedding clustering

- [ ] Complete P18.

**Implementation.** Compare deterministic clustering and bounded semantic escalation
with a locally evaluated embedding candidate on the versioned corpus from P05/P06.
Measure merge/split errors, downstream finding quality, latency, resource use and cost.
Keep source/protocol/model identities and evaluation settings reproducible.

**Acceptance.** Record an adoption or rejection decision against prespecified criteria.
If adopted, implement the bounded adapter, identity/versioning, fallback and regression
coverage before closing the item. If it provides no defensible benefit, retain the
existing clustering and document the measured reason; adoption is conditional.

## P19 — Close the implementation and validation queue

- [ ] Complete P19.

**Implementation.** Review the completed paths for defects in source/authority boundaries,
failure handling, budgets, independence, traceability, persistence and concurrency.
Resolve findings with focused regressions. Reconcile all public docs, runnable examples,
support matrices and this checklist with the final implementation.

**Acceptance.** Full CI/build pass on the supported platform matrix; required suites
cannot silently disappear. Repeat affected live-provider, Docker, native/batch and
browser acceptance after their final changes. Retain a completion report with evidence
for P01–P18, experimental conclusions, residual limits and unsupported combinations.
No item is marked complete solely because its interface exists or a prerequisite ran.

## Mapping from the previous execution queue

| Previous item | Current disposition / completion item |
|---|---|
| Model invocation and full Audit composition | Implemented; P03 validates live operation, P08/P09 finish scale and generic controls |
| Feature workflow and requirements consensus | Implemented with bounded revisions; P03/P08/P09/P10/P11 cover remaining validation, scale and operator/replay work |
| Testing planning | Implemented; P02/P03/P08/P10/P11 |
| Guarded autonomous Testing | Implemented; P04/P07/P10/P11/P12 |
| Native harnesses | P12 |
| Advisor runtime | P13 |
| Incremental/repeat audits | P14 |
| Provider batches | P15 |
| Workflow editor | P16 |
| Trace browser | Implemented; P10 browser acceptance and P17 indexing |
| Embedding evaluation | P18; adoption is conditional on results |
| Real-model premise | P05/P06 |
| Defect review, regressions, CI/build | P01, each feature's acceptance, and P19 |
| Documentation reconciliation | Current status/plan established; maintained with each item and closed at P19 |

## Environment requirements and scope

Live acceptance needs explicitly configured provider identities/credentials and bounded
spend; Docker acceptance needs a running Linux engine and local pinned images; browser
QA needs an available browser; native/batch acceptance needs the declared external
capabilities. Record unavailable environments as outstanding evidence rather than
inventing results. Implementation work that does not depend on them can continue.

All previously listed extensions are included in this completion queue. SaaS/accounts,
teams/billing, PR creation, automated deployment, generalized Audit/Feature production-code
implementation, learned routing, public benchmark UI, a marketplace/plugin ecosystem,
model-generated workflows and collaborative editing remain outside the documented
product scope. A completion percentage or deadline is not inferred from task count.
