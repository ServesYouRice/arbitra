# P03 on subscriptions: public workflows through vendor CLIs

Recorded September 27, 2026 on branch `beta`, from commit 3bc3263 to b560162. Host: macOS (arm64), Node 22.23.2, Docker Desktop 29.8.0.

Every model call went through the owner's own subscription logins, via the subscription CLI transports ([evidence for the transports themselves](../subscription-cli/README.md)). No API key or API credit was used.

- **Bindings:** [bindings.subscription.json](../../../tooling/live/bindings.subscription.json), which assigns:
  - analysts, planners, writers and the main auditor to Claude Sonnet 5;
  - lighter roles, such as one Feature reviewer and the Feature critic, to Claude Haiku 4.5;
  - one secondary role each to Codex (`gpt-5.6-luna`) and the Antigravity CLI (`gemini-3.8-flash-low`).
- **Harness:** each configuration was generated with `tooling/live/configure.mjs`. It was run through the public CLI with `tooling/live/run.sh` and `resume.sh`, each time on a fresh copy of [the fixture](../../../tooling/live/fixture-repo), whose three seeded defects are listed in [the ground truth](../../../tooling/live/fixture-ground-truth.json).
- **Handoffs:** plan handoffs to a fresh executor used [handoff.mjs](../../../tooling/live/handoff.mjs).

| Workflow | Final result | Evidence below |
|---|---|---|
| Testing plan | **passed** gate | [Testing](#testing) |
| Testing execute, as an execute replay of that plan | **passed** gate; handoff applied, 23/23 tests pass | [Testing](#testing) |
| Feature, automatic | **passed** gate | [Handoffs](#handoff-to-a-fresh-executor) |
| Feature, interactive | **passed** gate after an operator revision, resumed from a fresh process | [Interactive Feature](#interactive-feature) |
| Audit, three auditors (audit-deep) | completed; all three seeded defects accepted, nothing else reported; gate `failed` on genuine open decisions | [Audit](#audit) |
| Feature plan to a fresh executor, twice | **accepted** both times | [Handoffs](#handoff-to-a-fresh-executor) |

The native Claude Code writer (P12) also passed its conformance run on the same subscription login; see [qa/p12](../p12/README.md).

## Testing

- **Plan and grant:** the plan had 4 tasks, each creating one new test file under `tests/session/`, and all 4 task IDs were granted.
- **Reuse:** the execute replay reused analysis and planning from the plan run: 6 activities, no model calls.
- **Writers:** the Claude Code writers ran in the canonical tool loop; one task needed a second attempt.
- **Checks:** checks ran in the pinned Docker image.
- **Handoff:** `apply-changes` wrote the 4 files into a separate matching checkout, whose `node --test` then passed 23/23.
- **Usage:** 11 activities, about 90k input and 5.8k output tokens.

## Audit

Three auditors took part: Claude Sonnet 5, Codex and Antigravity. The table shows three runs, one per stage of fixes.

| Run | Code | Result |
|---|---|---|
| `run-2dfd2f87` | before 6bb27e2 | **Failed** at peer-review round 2 with `CONFORMITY_VOTE_FLIP_WITHOUT_NEW_EVIDENCE` (defect 6), after 60 minutes of wall-clock. The Mac slept through most of it (see the environment note). All three Codex findings were refused (defect 7). |
| `run-5ea73fe7` | 6bb27e2 | Completed in 7 min: 24 activities, 385k input and 35.5k output tokens. All three seeded defects accepted. Defects 8–10 showed up here. |
| `run-859b8a6a` | 67d4b47 | Completed in 4 min: 13 activities, 257k input and 23.7k output tokens, no output repairs. |

**Findings in the final run:**

- All three seeded defects were accepted by consensus, and nothing else was reported. The decoy (the correct `subtotal`) was not reported.
- Every auditor found the quantity and session-boundary defects. Only Codex found the discount-range defect, and the other two auditors accepted it in peer review.

**The gate is `failed`, for three reasons:**

- **`degraded_coverage`.** Only the design limitation remains: a source-only audit has no runtime or deployment security evidence ([setup](../../setup.md)).
- **`blocking_plan_questions`.** The planner left two blocking questions: should an invalid quantity or an out-of-range discount throw or clamp? These are genuine product decisions.
- **`blocking_critic_feedback`.** The critic flagged the same two questions.

The earlier run's blocking question about callers "outside the bounded context" became a low, non-blocking question once complete context was marked complete (defect 10).

## Interactive Feature

The request asked that refresh extend only live sessions, that expiry be enforced exactly at `expiresAt`, and that the plan decide how clock skew is handled.

**First run (`run-a1c3fe9d`):**

1. **Draft.** The requirements model (Sonnet 5) adopted the seeded bug as the contract: a session "is still valid at `now === expiresAt`".
2. **Review.** Both reviewers, Haiku and Codex, accepted that draft. They blocked only on clock-skew trust, so the run stopped `BLOCKED` at the requirements checkpoint.
3. **Operator revision.** The requirements were revised through the CLI (`requirements`, `revise-requirements`, `approve-requirements AM1…AM4`):
   - the boundary is expired at `expiresAt`;
   - the time source is the caller's responsibility, and the module reads no clock;
   - acceptance criteria AC2–AC5 were rewritten to match.
4. **Resume.** The run resumed from a fresh process (`resume.sh`). The reviewers accepted the revision, the plan was correct and the critic passed.
5. **Gate.** The gate then failed on a spurious exploration limitation, "no test file exists" (defect 11), so no handoff was rendered.

**Second run (`run-4fa662b3`, after the fix for defect 11):**

1. **Draft.** The requirements model again adopted the bug.
2. **Review.** This time the Codex reviewer caught it. It voted `revise` on A1, AM2 and AC2–AC4, citing the doc comment and the request. The Haiku reviewer accepted, and the run blocked.
3. **Operator revision.** The same revision was approved through the CLI.
4. **Resume.** After resuming from a fresh process, the reviewers accepted the revision.
5. **Plan.** The plan has one task: change `isExpired` to `>=` and add boundary tests in a new `test/session.test.js`. The critic passed it with three non-blocking items.
6. **Gate:** **passed**, with 10 activities, 95.7k input and 27.2k output tokens.

## Handoff to a fresh executor

`tooling/live/handoff.mjs` works in five steps:

1. It exports the run through the public CLI.
2. It renders the handoff per task with an explicit operator grant: the task's proposed files, less `filesNotToTouch`, plus its verification commands.
3. It gives each task to a new Claude Code process, Sonnet 5 on the subscription login, in a clean fixture checkout with the handoff in `./implementation`. That process has no run state, and the host's settings, memory, skills, plugins, hooks and MCP are off.
4. The script runs the approved verification itself.
5. It checks that the contract files are unchanged and that every edit stays inside the grant.

| Plan | Tasks | Result |
|---|---|---|
| Feature automatic `run-4accf4af` (add `removeLine`) | TASK-001 `src/cart.js`, TASK-002 `test/cart.test.js` | **Accepted.** Both tasks stayed inside their grants and preserved the contract; `node --test` passed 6/6. Human review: `removeLine` is a non-mutating strict-equality filter, and the tests cover AC1–AC5. |
| Feature interactive `run-4fa662b3` (session expiry) | TASK-001 `src/session.js`, `test/session.test.js` | **Accepted.** The fresh agent changed `now > session.expiresAt` to `now >= session.expiresAt`, which fixes the seeded defect. It added six boundary tests (at E−1, E and E+1, for both `isExpired` and `refresh`); `node --test` passed. |

The handoff harness's first layout put the handoff beside the checkout, and a fresh agent then wrote its progress file into the checkout (defect 12).

## Defects these runs found (all fixed on beta, with regressions)

1. **A granted plan was re-planned, so the grant no longer matched.** Writing the grant into the configuration changed the Testing settings, so analysis and planning ran again and produced different tasks. Analysis and planning now never see execution settings.
2. **One shared check could not verify several tasks.** A single `npm run test` check covering several tasks' new files failed on the first task, because the other files did not exist yet. Granted files that no task has created yet are now left out of that verification, and the attempt ledger checks the narrowed sources.
3. **A slow Docker engine cost the whole run its handoff.** The engine now gets 15 s to answer `docker info`, and an infrastructure-only incomplete final check is rerun up to twice.
4. **Invalid task IDs were caught only at rendering.** Planner replies are now refused, and so repaired, when task IDs are not `TASK-001` style.
5. **Haiku 4.5 invented a tool result and outgrew the output ceiling.** The first emulated tool request now wins. Subscription templates allow 32k output tokens, and planning roles use Sonnet 5.
6. **A changed peer vote failed the whole run.** The Antigravity reviewer rejected a candidate in round 1 and accepted it in round 2 on the same evidence. It was never shown its earlier vote, and the anti-conformity check threw. The fix has three parts:
   - later rounds now show each reviewer its own earlier votes and the rule;
   - a changed vote with no new evidence is refused at the model boundary and repaired;
   - if repair fails, the reply is set aside as degraded review coverage (6bb27e2).
7. **All Codex findings were refused.** Codex quoted each function's doc comment one line above its cited range. A cited location now widens to the single exact occurrence of its quotation near the cited lines, and the widening is recorded (6bb27e2).
8. **An output repair was reported as a prompt injection.** The validator's refusal was framed as untrusted repository content, and Sonnet 5 filed a `PROMPT_INJECTION` finding about it. A fixed, trusted instruction now says what the repair artifact is, and the model-derived text stays framed as data (67d4b47).
9. **The sole author of a candidate counted as a missing reviewer.** Peer review never shows an auditor its own findings, so every multi-auditor run with a unique finding reported degraded coverage (67d4b47).
10. **Complete context was not marked complete.** Models are told context "may be excerpted; consult contextCoverage", but nothing was sent when everything fitted. The planner then asked a blocking question about callers outside a snapshot that held the whole repository (67d4b47).
11. **A file to be created became an exploration limitation.** The feature needed a new test file. The model gave it a surface with no paths, was refused, and on repair recorded "no test file exists" as a limitation, which withheld the handoff. The instruction and both refusals now route such files to the summary for the planner (364762d).
12. **The handoff harness used the wrong layout.** The rendered handoff's paths assume `./implementation` inside the checkout; `handoff.mjs` now uses that layout (364762d).

**Environment note:** the host slept during the first Audit run. Stage timeouts count only awake time, so a 10-minute timeout took 27 minutes of wall-clock. This is not an arbitra defect, and `run.sh` and `resume.sh` now keep the Mac awake with `caffeinate`.

## Quality findings from human review

- **Models adopt a seeded bug as the intended behaviour.** A generated Testing test asserts `isExpired` is false *at* `expiresAt`. The Feature requirements model wrote the same wrong contract twice. Haiku reviewers accepted it both times; the Codex reviewer caught it once. Independent review and the operator checkpoint are what stopped it; final verification only proves tests pass on the current code.
- **Audit has no operator path for a blocking plan question.** The Audit plan correctly leaves "throw or clamp?" open, and the gate fails. Unlike Feature, an Audit run cannot be answered and resumed, so it must be rerun with guidance.
- **The planner ordered shared-file tasks only loosely.** In `run-5ea73fe7`, two tasks edited the same files with only `conflictsWith` between them. The critic called it non-blocking at first and blocking after the revision, which by then could not fix it. A deterministic check could require an order.
- **Subscription calls are slow.**
  - Claude Code takes 12–75 s per stage call.
  - Codex takes 8–45 s, with one feature review at 173 s.
  - Antigravity takes 9–17 s, plus about 24k tokens of agent prompt overhead per call.
  - Single runs take 2–13 minutes.

## Not covered here

- The OpenAI Responses, OpenAI Chat and Anthropic Messages API protocols, live. They need API credit, which the owner does not use for testing. Gemini native and the OpenAI-compatible endpoint were covered earlier in [qa/p03](../p03/README.md).
- A deliberate subscription usage-limit hit. Classification is covered by stand-in tests and the recorded CLI messages.
