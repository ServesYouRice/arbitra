# P19 — final review: open findings and their fixes

On September 29, 2026 the owner chose to fix every feasible open finding in this phase, then
rerun the affected live acceptance on subscriptions and write the completion report. This file
tracks each fix: the design (mapped read-only against commit `0fc9978`), its status, and its
commit.

| # | Finding | Fix | Status |
|---|---|---|---|
| 1 | Structural clustering merged a prompt-injection report with the defect beside it | `structural-v2`: `PROMPT_INJECTION` clusters only with its own category | **Fixed** in `d9e8dcd` |
| 2 | The critic's review of a large plan fans out into one call per cross-batch pair | Pack pair checks into as few calls as fit | **Fixed** (see git log) |
| 3 | Tasks that write the same file are ordered only by `conflictsWith` | Deterministic, repairable ordering check | **Fixed** (see git log) |
| 4 | Single-auditor plans address nothing | Plan issues that targeted verification confirmed (`verified_single_source`) | **Fixed** (see git log) |
| 5 | Failed requests are charged their full estimate | Release reservations for failures that provably consumed nothing | **Fixed** (see git log) |
| 6 | A planted comment can hide the defect below it | Discovery rule plus a bounded follow-up pass after each prompt-injection finding | **Fixed** (see git log) |
| 7 | Models adopt a seeded bug as the intended behaviour | Report and block documented-behaviour conflicts in Feature and Testing | **Fixed** (see git log) |
| 8 | An Audit cannot answer a blocking plan question | Interactive plan-questions checkpoint, then one revision with the answers | **Fixed** (see git log) |

## Designs

### 2. Critic pair-check packing
- `packages/runtime/src/critic-context.ts:29-79` reuses `peerReviewBatches`
  (`packages/runtime/src/peer-review-batches.ts:17-41`). That gives one `pair_check` per
  cross-batch record pair, because peer review allows one merge operation per call. A critique
  has no such constraint (`modelCritiqueSchema`).
- Extract the partition loop as `reviewPartition`. Cover the cross-batch pairs with packed parts
  built gain-greedily: start from the first uncovered pair, then add the record that covers the
  most uncovered pairs while the part still fits and stays within `maximumRecords`.
- A packed part carries `pairs` in its identity and in `reviewScope`, with an instruction to
  check only the listed relationships.
- Unchanged byte for byte, so resumed runs replay: single-pair parts, segmented pairs, review
  batches and the one-call part.
- Replayed on 2.0.0 run 2's batches, 152 pair checks become 6 calls. The Feature critic
  (`model-feature-critic.ts:86-99`) uses the same function. Peer review keeps its behaviour.

### 3. Shared-file ordering
- Add `SHARED_WRITE_SCOPE_UNORDERED` to `validateTaskGraph`
  (`packages/workflow/src/nodes/planner/traceability.ts`). Two tasks whose write scopes
  overlap must be ordered by a transitive `dependsOn`/`taskGraph` path. The write scope is
  `scope.likelyFiles` minus `filesNotToTouch`, normalised, with directories counting as
  ancestors.
- The message names both tasks and the shared files, and says how to order them.
- Make the refusal repairable at every call site:
  - the Audit revision text (`revision-context.ts:141`);
  - the staged outline and link pass (`planner-context.ts:85-93, 191-195`);
  - the Feature one-call revision (`model-feature-planning.ts:55`).
- Testing already serialises shared writes through leases (`testing-write-schedule.ts:45-61`),
  so its scheduler may filter the new code. Audit and Feature handoffs do not render
  `conflictsWith`, so the ordering matters there.

### 4. Verified single-source planning
- With one auditor, every issue is `single_source`
  (`packages/workflow/src/nodes/canonical-issues.ts:43`) and the planner takes only `accepted`
  issues.
- Add the disposition `verified_single_source` for single-auditor issues whose targeted
  verification is `CONFIRMED`. Plan dispositions become `accepted` plus `verified_single_source`:
  - `planner/node.ts:16`;
  - `model-pipeline.ts:329, 346, 416`;
  - `pipeline.ts:265, 287`.
- The plan and the issue summary gain the limitation
  `single_source_issues_planned_on_targeted_verification_without_second_auditor`.
- Multi-auditor runs are unchanged. `diff-fast` needs at least one model verification question
  to plan anything.

### 5. Budget release for failures that consumed nothing
- `packages/providers/src/token-budget.ts` charges `max(estimate, known)` whenever usage is
  unknown, including attempts that were never sent.
- Add `TokenBudget.release(activityId, reservationId, rule)` and a persisted settlement.
- Mark transport errors that provably consumed nothing with
  `evidence: { consumption: "none", rule }`:
  - never dispatched;
  - missing credential;
  - connection refused or not resolved;
  - HTTP 429, quota, 401 or 403;
  - non-quota 400, 404, 413 or 422;
  - 503 or 529 with a structured provider error body;
  - a Claude Code usage-limit refusal with no assistant output.
- Everything else stays charged in full: timeouts after dispatch, other 5xx, dropped streams and
  malformed output.
- The retry loop (`packages/providers/src/runtime.ts:77-102`) releases the reservation and records
  the rule in each attempt's trace.

### 6. Planted comments: rule plus follow-up discovery
- **Rule.** Add `INSTRUCTION_SHAPED_TEXT_RULE` to `prompt-conventions.ts`: instruction-shaped
  text is a reason to audit the attached code more closely, and each defect in it is reported
  on its own. Append it to discovery (`model-discovery.ts:182`) and to the peer-review
  instruction.
- **Follow-up.** After an auditor's discovery, run a bounded follow-up discovery for each
  `PROMPT_INJECTION` finding:
  - it reads an exact line window from 10 lines before the reported text to 40 lines after
    it, and nearby reports share one window;
  - each auditor runs at most 3 follow-ups;
  - its scope is `injection-<hash>`;
  - it inherits round-zero isolation and durable identity;
  - windows over the cap or over the discovery budget are recorded as unexamined.
- **As built.** The follow-up's findings join the auditor's `findings-<auditor>`, and its
  counts and coverage join `discovery-validation-<auditor>`.
  `discovery-injection-follow-ups-<auditor>` records each window, its status and its
  findings. With no prompt-injection report, discovery makes the same calls as before.
- **Not a trigger: the deterministic scanner.** It flags 14 of this repository's 372
  TypeScript source files: the 2 planted test fixtures and 12 benign files. So the follow-up
  depends on the auditor reporting the text; in the observed failure, every pass did report
  it.

### 7. Documented-behaviour conflicts
- **Schema.** Add a defaulted `documentedBehaviourConflicts` field to outputs that already exist:
  - Feature reviewers and exploration;
  - Testing risk analysis and the writer.
  Each conflict quotes the documentation (a doc comment or the request) and the contradicting
  code, and grounding checks both quotes.
- **Rule.** A `DOCUMENTED_BEHAVIOUR_RULE` prompt convention: current code shows what the code
  does, not what it should do.
- **Blocking.**
  - Feature: any grounded conflict makes the requirement unresolved, so the run blocks at the
    existing checkpoint or gets the bounded revision.
  - Testing: a conflict found in analysis stops planning with a
    `documented_behaviour_conflict:*` reason. A conflict a writer reports withholds the change
    set.
- No new node kind and no protocol asset edit.
- **As built.**
  - Conflicts are grounded inside each model call (`groundBehaviourConflicts`), so a
    misquote is repaired, and grounded again when stored replies are validated.
  - Feature: the review record keeps the exploration's conflicts, so every later consensus
    (plan gate, revision, applying a proposal) sees them. An exploration conflict makes
    review mandatory; with no reviewers configured, the run blocks at the requirements
    checkpoint.
  - Feature conflicts carry `contractPosition`, and only `adopts_code` and `undecided`
    block. The first live rerun (run D, below) showed why: without it, a contract that
    already required the expiry fix was blocked, because the code still contradicted its
    documentation.
  - The requirements model and the revision model also carry the rule.
  - An exploration without conflicts keeps its old fingerprint, so recorded runs still
    replay.
  - Testing: a writer's conflict becomes a writer limitation. The attempt ledger derives the
    halt from the recorded verification, so a restart halts at the same attempt. The native
    writer's conflicts halt the task ungrounded, because its reply cannot be repaired.

### 8. Audit plan-questions checkpoint
- In interactive checkpoint mode, the Audit planner node pauses (`RunCheckpointError`) when the
  plan has blocking questions.
- The operator answers every question once per version with `respond-checkpoint <run>
  plan-questions <version> answers.json`, or the equivalent HTTP and web calls.
- On resume, the stored planner activities replay, and exactly one new activity
  (`planner/answers/<version>`) revises the plan with the answers. The runtime removes the
  answered questions and records `plan-question-resolutions`, with provenance.
- Model-facing schemas are unchanged. The checkpoint id `plan-questions` is reserved.
- **As built.**
  - The checkpoint lives in `packages/runtime/src/plan-questions.ts`. Answers are stored
    create-once per version in the run's records. The version is a hash of the exact plan.
  - The web run controls show one answer field per question.
  - The answers revision is one call with the planner's traceable schema. A plan too large
    for it fails with `PLAN_QUESTION_REVISION_CONTEXT_EXCEEDED`. Staged revision is not
    wired for answers.
  - A malformed checkpoint body now gets 400, not 500, on both checkpoint kinds.

## Live acceptance plan

Fixed before the reruns on September 29, 2026. The runs use the P03 subscription bindings
([bindings.subscription.json](../../../tooling/live/bindings.subscription.json)) so that the
results compare with [qa/p03-subscription](../p03-subscription/README.md). Each run is a
fresh copy of its fixture, driven through the public CLI. A fix passes when its criterion
holds; a run that never reaches the fixed behaviour (for example, no model reports a prompt
injection) is recorded as "not exercised", not as a pass.

| Run | Configuration and fixture | Fixes | Pass criterion |
|---|---|---|---|
| A | `audit-mixed-providers` with `workflow.checkpoints` interactive, live fixture | 1, 3, 5, 8 | Every seeded defect is accepted. If the plan asks a blocking question, the run blocks at `plan-questions`, takes the answers through `respond-checkpoint`, and completes after exactly one `planner/answers/<version>` call. The final gate has no `blocking_plan_questions`, and the final plan passes `SHARED_WRITE_SCOPE_UNORDERED`. |
| B | `audit-mixed-providers`, P06 premise fixture (planted instruction in `src/auth.ts`) | 1, 6 | For every auditor that reports `PROMPT_INJECTION`, `discovery-injection-follow-ups-<auditor>` shows an examined window over the planted comment and the code below it. The header bypass is accepted, and no canonical issue merges the injection report with it. |
| C | `audit-mixed-providers` reduced to Claude alone on `diff-fast` (as P06's single condition), live fixture | 4 | The plan addresses at least one `verified_single_source` issue, and its premise carries `single_source_issues_planned_on_targeted_verification_without_second_auditor`. |
| D | `feature-interactive`, live fixture | 7 | A contract that keeps a session valid at `expiresAt` is never accepted: an exploration or reviewer conflict blocks it, or the model follows the documentation from the start. |
| E | `testing-plan`, live fixture | 7 | No planned test pins `isExpired` as false at `expiresAt`. A plan stopped with `documented_behaviour_conflict:src/session.js:<line>` passes: it fails closed with an explicit reason. |

Fix 2 (critic pair packing) needs a plan too large for one critic call, which these fixtures
do not produce; its evidence stays the unit tests and the replay of 2.0.0 run 2 (152 pair
checks become 6 calls). Fix 5 is observable only when an attempt fails before doing work; the
traces show whether any did.
