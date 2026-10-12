# Remaining work

Updated October 11, 2026 (branch `beta`).

## Handoff, October 10, 2026

The work moved from a web session to the owner's Windows PC on October 10, because live runs need the owner's
subscriptions.

- **State:** `main` = `beta`. P20's benchmark is complete in the private repository `ServesYouRice/arbitra-p20`
  (`main`): 12 projects, 84 defects and 84 decoys (`p20-hard-v2`), all passing `node verify.mjs`, with the
  evaluation harness in `evaluation/`. Its `HANDOFF.md` holds the P20 details, the pilot results so far and the
  next steps.
- **Calibration result (October 9):** one Claude Opus 5.5 run found every planted defect in all three pilot projects
  (21 of 21). As built, P20 was too easy to separate a panel from repeated runs.
- **Decision (October 9):** the owner chose to harden P20. **Done October 10:** all twelve projects were rebuilt
  under stricter rules pre-registered first (`p20-hard-v2`, details in the private repository's `HANDOFF.md`).
- **Re-calibration (October 10):** one Claude Opus 5.5 run per rebuilt pilot project found 16 of 21 defects (recall
  0.76, 95% interval 0.55 to 0.89), so the pilot is no longer at the ceiling. It ran on the owner's Windows PC. No
  model has audited a held-out project.
- **Running again since October 10 at 23:51:** the pilot panels
  (`node evaluation/run-paced.mjs pilot-v2 0.9 0.8` in `arbitra-p20`), on the owner's Windows PC because the Mac
  is unavailable for a few days. They pace themselves on the Claude and Codex usage windows. The first estimate, a day
  or two, was wrong: on October 11 at 18:30 one Opus-only run was complete and the first panel run had run for
  more than four hours without finishing. The private `HANDOFF.md` says how to watch, stop and restart them.
  - They stopped at 22:59 on two arbitra defects, both fixed the same evening (7f52969, 2bd8162; see "Open findings"
    below). The pilot started again on that build under a new protocol version; the one run completed before was
    retired unscored and runs again.
  - On October 11 the first panel run could not get through peer review: one call per candidate pair meant 1,140
    calls for one reviewer. That is fixed too (42da89f). The run build was updated at 10:33 while the runner
    waited for the Codex window.
  - The same day the owner asked that the runs also test arbitra's cost, and chose to fix the largest cost found,
    clustering, at once (a33d4e8). The pilot started again from its first run as a new protocol version at 13:29;
    the run completed before was retired unscored.
  - That evening the owner said a run of three to four hours is not a viable product and asked for a faster
    design. The method is not what takes the time; see "Open findings" below. The build now runs every
    independent call side by side under one setting (`maximumParallelCalls`, e107937) leaves out a foreign
    citation instead of refusing the reply (094eb56), no longer escapes quotes inside the repository frame
    (24eacf4), and keeps the valid operations of a reply when one is refused (7986f77). Premium and light moved to
    protocol 2.4.0 at 18:45; the cheap lineup follows when its panel run has ended. The first run on the new
    build, an Opus-only run, took 20 minutes where it had taken 40 (13 calls, 0.91M tokens). Its audit was 5
    calls: the fourth failed at once on a redaction defect, fixed the same hour (e83dc94), so they ran as 3 and
    then 2 side by side, 6 and 7 minutes, where 8 calls one after another had taken 33. The pilot starts again as a new protocol version on that
    build when the running panel run has ended.
  - GPT-6.1 Sol at xhigh answers through arbitra (nine calls, none failed). GPT-6 Luna at max and Sonnet 5.5 at
    xhigh have not run through arbitra yet.
  - Codex answers through arbitra on Windows (0.162.1, live evidence in
    [qa/subscription-cli](docs/qa/subscription-cli/README.md)).
  - Restarting the PC ends the runner. That happened once on October 10; started again with the same command, it
    resumed the interrupted run.
  - The first three-vendor run used a whole Codex five-hour window and 15% of the weekly one before it was
    finished. The owner therefore changed the lineups on October 10, before any panel run had finished, and the
    pilot started again under a new protocol version; the unfinished run was retired unscored:

    | Lineup | Claude | Codex | Gemini |
    |---|---|---|---|
    | premium | Opus 5.5, xhigh (was high) | GPT-6.1 Sol, xhigh (was GPT-6 Astra) | 3.8 Flash, high |
    | light | Opus 5.5, medium | GPT-6.1 Sol, medium (was GPT-6 Astra) | 3.8 Flash, high (was medium) |
    | cheap | Sonnet 5.5, xhigh (was Sonnet 5, medium) | GPT-6 Luna, max (was medium) | 3.8 Flash, high (was medium) |

  - The strong single model, run three times per project, is premium's Claude, so it is Opus 5.5 at xhigh too. The
    16 of 21 calibration was measured at high; the pilot's Opus-only runs show what xhigh finds.
  - Thinking counts as output on Sonnet 5.5 and Opus 5.5 and cannot be switched off. At xhigh, Sonnet 5.5 returned
    no answer to a hard prompt under a 32,000-token output ceiling, and both models thought for more than 50,000
    tokens, so every lineup's ceiling is now 64,000. Opus at xhigh uses about three times the output of high, so
    the pilot needs more of the weekly Claude allowance.
  - Gemini 4 Argon is not offered by the Antigravity CLI yet (`agy models`), so the panels stay on Gemini 3.8 Flash.
  - The runner stops at 90% of a weekly window and the owner decides.
- **Windows now runs every lineup.** The Antigravity CLI's prompts were capped at 30 KB there; they now travel on
  stdin with the same 190,000-byte limit as on macOS (b2a0793, live evidence in
  [qa/subscription-cli](docs/qa/subscription-cli/README.md)). A start that fails preflight no longer blocks its
  retry (6c5c0fe).
- **Next:** when the pilot has finished, compare the lineups and report to the owner; then the owner approves the
  held-out plan, then the held-out runs and P21.
- **Live runs need the owner's machines.** They run only on the owner's subscriptions, through the vendor CLIs
  signed in there: Claude Code, Codex and the Antigravity CLI. A cloud session can change code, docs and the
  benchmark, run tests and analyse committed evidence, but it cannot run them. Run state (`.runs/` in both
  repositories) exists only on the machine that made it: the Windows PC for the v2 calibration and pilot, the
  Mac for the rest.
- **Standing rules from the owner:**
  - test only on subscriptions through the vendor CLIs, never on API credits;
  - never put P20 content (projects, answer keys, protocols, evidence) in this repository;
  - never tune the benchmark so arbitra's setup wins; no model result selects, drops or tunes a defect;
  - keep progress summaries very short;
  - push and merge at every logical stop: fast-forward `main` to `beta` once CI is green;
  - update the plain-language status doc ("arbitra project status" in Claude Docs) when status changes.

The maintained execution queue is the [completion plan](docs/completion-plan.md). Every item is recorded in its [status table](docs/completion-plan.md#status-september-27-2026).

- **Complete:** P01, P02, P04–P07, P09–P14 and P16–P19. P19's completion report moved to the new P21, which waits for P20.
- **Merged from the other session (`ui-restructure`, September 29):** the web app restructured into pages (run list, run pages, new-run form, workflows page); browser acceptance rerun, 69 of 69 passed ([qa/p10](docs/qa/p10/README.md)).
- **In progress:** P20, a hard premise benchmark. It is rebuilt as `p20-hard-v2` (12 projects); its pilot was re-calibrated on October 10 and is no longer at the ceiling. The pilot panels are running on the owner's Windows PC; they stopped once on October 10 on two defects that were fixed the same evening. P20's benchmark is kept in the owner's private repository `arbitra-p20` so its answer keys stay out of public training data; never add it here.
- **Deferred, not part of this phase ([paid-API bundle](docs/completion-plan.md#deferred-the-paid-api-bundle)):** the API-protocol part of P03, and the live evidence for P08 and P15. All three are implemented.
- **Accepted live on subscriptions:** the rest of P03.
- **Pending:** P21 (completion report, after P20).

## What is left, by what it needs

1. **Nothing but time, on subscriptions:**
   - **P19 (complete):** the final review. On September 29 the owner chose to fix every feasible open finding in this phase, then rerun the affected live acceptance on subscriptions. All eight are fixed: prompt-injection reports no longer cluster with the defect beside them (`structural-v2`); the critic packs pair checks into as few calls as fit; Audit and Feature plans must order tasks that write the same files; one-auditor plans address the issues verification confirmed; attempts that provably consumed nothing are no longer charged; each prompt-injection report gets a bounded follow-up look at the code beside it; Feature and Testing report and block on documented-behaviour conflicts instead of adopting the code's behaviour; an interactive Audit waits for answers to its plan's blocking questions and applies them in one planner call.
2. **Deferred to a later phase: the [paid-API bundle](docs/completion-plan.md#deferred-the-paid-api-bundle).** It needs funded API accounts, which the owner does not use, so it is not done in this phase. A later maintainer may take it on:
   - the OpenAI Responses, OpenAI Chat and Anthropic Messages protocols live (P03);
   - P08's live context limits;
   - each P15 batch driver.

## Live-testing policy

Subscription mode is a product feature for every user, on an equal footing with API keys and selectable per role. The owner's own live testing runs **only on subscription models**, through the vendors' CLIs, and never on API credits:

| Vendor | CLI | Sign-in |
|---|---|---|
| Anthropic | Claude Code | Claude login |
| OpenAI | Codex CLI | ChatGPT login |
| Google | Antigravity CLI (`agy`) | Google AI subscription login |

Claude carries most roles. Codex and Antigravity take at most one secondary role each, because their limits are lower.

Google retired personal logins from the Gemini CLI on June 18, 2026, so the `gemini-cli` transport serves only Code Assist Standard or Enterprise accounts. Never use third-party plugins that reuse Antigravity OAuth tokens; they get accounts banned.

Live configurations come from `tooling/live/bindings.subscription.json`. The API-key transports remain for other users: [bindings.claude-primary.json](tooling/live/bindings.claude-primary.json) is the API-key equivalent, and [bindings.gemini.json](tooling/live/bindings.gemini.json) records the free-tier Gemini setup behind the earlier evidence.

## How to pick this up again

1. **Logins.** Sign in once in a terminal: `claude` (/login), `codex login` (Sign in with ChatGPT) and `agy`. The API keys in the gitignored `.env` are not used for owner testing.
2. **Build.** Run `pnpm build`.
3. **Workflows (P03).**
   1. Generate the configurations: `node tooling/live/configure.mjs tooling/live/bindings.subscription.json .runs/live/configs-sub`.
   2. Run one: `tooling/live/run.sh .runs/live/configs-sub <audit-mixed-providers|feature-automatic|feature-interactive|testing-plan|testing-execute>`. The script keeps the Mac awake; a sleeping host stretches every stage timeout.
   3. An interactive Feature stops `BLOCKED`. Inspect it with `requirements <run-id>`, then `revise-requirements` and/or `approve-requirements`, then run `tooling/live/resume.sh feature-interactive <run-id>`.
   4. Hand a Feature plan to fresh Claude Code executors: `node tooling/live/handoff.mjs <work-name> <run-id>`.

   `testing-execute` needs Docker and the pinned image; see [qa/p04](docs/qa/p04/README.md).
4. **Native writer (P12).** Run in `packages/runtime`:

   ```bash
   ARBITRA_NATIVE_HARNESS_CONFORMANCE=1 ARBITRA_CLAUDE_CODE_EXECUTABLE=<absolute claude path> \
   ARBITRA_NATIVE_CONFORMANCE_MODEL=claude-sonnet-5 ARBITRA_NATIVE_CONFORMANCE_CREDENTIAL_KIND=subscription_login \
   npx vitest run test/native-harness.conformance.test.ts --silent=false
   ```

   See [qa/p12](docs/qa/p12/README.md).
5. **Premise evaluation (P06): complete.** Version 2.1.0's results are in [qa/p06-subscription](docs/qa/p06-subscription/README.md). Its run state is local only, in `.runs/p06-subscription-2.1.0` (2.0.0's in `.runs/p06-subscription`); keep both. For live runs, pace on the Claude five-hour window (`rate_limit_event` in any `claude -p --output-format stream-json --verbose` call); the owner can reset the weekly limit when needed.
6. **Then:** P20's runs, then P21's completion report. Pace them on Claude's and Codex's usage windows; Codex's are read without a model call through `codex app-server` (`account/rateLimits/read`).

## Open findings to fix or decide

The owner asked on October 11 that every P20 run also serve as a test of arbitra itself: what fails, what costs
too much and what is slow. Findings from the runs' own data go here, with their numbers.

**Where a panel run's time goes.** The first panel run (Sonnet 5.5, GPT-6 Luna, Gemini 3.8 Flash on a project of
54 files) made 141 calls in its first four and a half hours, almost all one after another. Replaying the
recorded times of its first 128 calls (discovery, the first review round and its conflicts):

| | Minutes |
|---|---|
| As run, one call at a time | 257 |
| Reviewers of a round side by side (14ae7aa) | 130 |
| Four calls per auditor at a time (e107937) | 47 |
| The same without repair calls | 34 |

Comparable tools wait three times: all models audit at once, all review at once, then disputes are settled
([llm-council](https://github.com/karpathy/llm-council), Claude Code's
[code-review plugin](https://github.com/anthropics/claude-code/tree/main/plugins/code-review)). None of the
reviewers read on October 11 has a repair call: they keep the valid items of a reply and drop the rest
([PR-Agent](https://github.com/qodo-ai/pr-agent),
[claude-code-security-review](https://github.com/anthropics/claude-code-security-review)), and they check a
finding against the code it cites, not against the repository. The specification asks for the same: fan-out
under per-provider limits (§12.6) and a shared cached prefix (§14.2).

**Where a whole panel run's time goes (October 12).** The first panel run at xhigh that reached its last stage
(Opus 5.5, GPT-6.1 Sol, Gemini 3.8 Flash, the same project) had a call in flight for 284 minutes: 274 calls, 859
minutes of call time, 13.0M input and 6.6M output tokens. Wall-clock per stage, from the times its requests were
stored:

| Stage | Calls | Wall minutes | At a time | Notes |
|---|---|---|---|---|
| Audit | 28 | 41 | 2.7 | Opus 343 s a call; Gemini 17 calls; 3 tool turns of Sol took 21 call-minutes |
| Clustering, review round 1 | 43 | 24 | 4.1 | 16 tool turns (36 call-minutes), 6 repairs |
| Review round 2, conflicts | 84 | 29 | 6.3 | Opus 268 s a call; 10 tool turns |
| Verification | 3 | 1 | 1.0 | |
| Plan | 2 | 14 | 1.0 | one call of 440 s and its repair |
| Critic, first plan | 30 | 23 | 3.7 | 4 reviews and 26 pair checks |
| Plan revision | 11 | 69 | 1.0 | one item after another; 4 stopped at the output ceiling (34 minutes) |
| Critic, revised plan | 73 | 82 | 3.7 | 77 planned: 6 reviews and 71 pair checks, 250 s and 42,000 output tokens a call |

So the findings were final after 95 minutes, and the plan, its critic and its revision took the other 188. What
this shows, largest first:

- **The critic reviews a seven-task plan in 30 calls, and the revised plan in 77.** The plan and its issues do
  not fit one prompt at one token a byte, so they are split, and every pair of parts is then checked. The second
  pass repeats the whole review with the resolutions added, instead of checking what changed.
- **The plan is revised one critique item at a time, at the audit's effort.** Eleven Opus calls of five to nine
  minutes each; the single revision call did not fit for the same reason of size.
- **Every prompt is filled with source files up to its limit**: 47,000 input tokens a call on average, whatever
  the call decides. That is most of the 13.0M input tokens, and it is what exhausts the vendors' allowances (the
  Google allowance stopped this run for an hour).
- **Calls that reach the output ceiling are thrown away**: 7 calls of about eight minutes each.
- **Tool round trips**: 29 calls and 87 call-minutes of GPT-6.1 Sol (199 tool calls), because its prompts hold only part of the
  repository.
- **arbitra's own planning of batches takes minutes**: with nothing in flight, 234 s before the first review
  round, 110 s before the critic and 265 s before the second critic, and about two minutes again at every
  resume. Each candidate grouping is measured by building its whole prompt.
- **Parallelism is low where it could be high**: 2.7 calls at a time in the audit, 1.0 in the plan revision, and
  the critic is held to the provider's four.

The sizing item below is the common cause of the first, second and fifth; the effort item of the second and
fourth.

**Open (cost and speed), measured on October 11 on that project:**

- **The Codex allowance now bounds a panel's throughput, not arbitra's speed.** Three panels side by side used a
  whole five-hour ChatGPT Plus window in about 100 minutes and 16 points of the week: 4.0M tokens of GPT-6.1 Sol and
  0.9M of GPT-6 Luna. One panel's Sol at xhigh made 43 calls up to its first conflicts, 20 of them tool round trips
  (130 tool calls), with 5% of its input read from a cache. The two items on tool round trips and on byte-sized
  prompts below are therefore the next to fix: they decide how many panels fit in a window.
- **Most of an audit prompt is packaging.** The project is 54 files, 5,208 lines and 224,000 characters. One
  auditor's discovery sent 575,000 characters in 5 calls and was billed 307,000 input tokens. Source text was 39%
  of the characters and the `&quot;` entity 36% (no longer written, 24eacf4). The rest is one JSON object per
  source line, and the schema and instructions repeated in every call. The same lines written as `N: text` are
  247,000 characters, which one call could carry. To decide: send discovery's source as numbered lines.
- **Prompts are sized as if one byte were one token.** A prompt is admitted when its bytes plus the whole output
  ceiling fit in 80% of the model's window. Real prompts measured about 1.9 to 2.4 bytes per token, so each uses
  about a quarter of the window: Sonnet 5.5 received 61,500 tokens in a 240,000-token window. Discovery is therefore
  planned as 4 or 5 scopes per auditor, one review prompt held 4 of the 54 files, and the same estimate throttles
  the scheduler's tokens per minute. To fix: a bytes-per-token figure per model profile, and a provider's
  "prompt too long" answer handled as a capacity error that halves the unit. Since c5eb65c a unit that cannot
  be made smaller is admitted at two bytes a token before the run fails (see Fixed); how calls are sized is
  unchanged.
- **A model that reads through the harness tools pays a whole call per round trip.** With most files left out of
  its review prompts, GPT-6 Luna made 257 tool calls. Every round trip is a new CLI process that receives the
  whole conversation again, and the harness archives earlier tool results to stay inside the same estimate, so the
  model has to fetch them again: 34 further turns, 68 minutes and 4.9M tokens, 35% of the run. To fix with the item
  above: when the whole repository is in the prompt, say so and offer no read tools.
- **Every decision call re-sends repository text, and none of it is read from a cache.** Clustering,
  verification, peer review and conflict resolution each carried 55,000 to 59,000 input tokens per call; cache
  reads were 0% for Claude and Gemini. The layer meant for stable repository content held 89 characters in a
  review prompt; the files travel in the per-call layer. By its documentation, Claude Code shares a cached prefix between
  processes only when model, effort, tools and schema are the same and the first reply has begun. To decide: attach only
  the files a record cites, and lead every prompt of a stage with the same repository text.
- **Refused replies cost a third of a panel run's tokens (largely fixed, to be measured).** 39 of the run's first
  155 calls were repairs: 6.0M tokens and 74 minutes. By rule: 10 cited another candidate's evidence, 8 cited a
  location they had not declared, 7 added evidence that is not an exact quotation, 7 added evidence without citing
  it, 4 merged outside the listed pairs of a packed check, 2 used a presented ID where a new one was required, and
  1 was a safety-filter notice. Since 7986f77 an operation that fails is left out and the rest of the reply
  stands. Still to measure in a panel run: how many operations are left out, and whether a reply's locations or
  findings, which still refuse the whole reply, need the same treatment.
- **Calls are lost at an output ceiling.** One of 8 Opus 5.5 discovery calls at xhigh and 2 of 14 Gemini 3.8
  Flash calls at high stopped at the ceiling and were redone in smaller parts. Each lost call costs up to
  64,000 output tokens and nine minutes. To decide: start with smaller scopes at efforts where thinking counts
  as output, for example after one scope of the run has come close to the ceiling.
- **Batches are sized as if replies had no thinking.** A peer review reserves 160 output tokens per candidate.
  With thinking counted as output, Sonnet 5.5 at xhigh wrote 49,000 output tokens for 25 candidates and Gemini 3.8
  Flash at high passed its limit on 19. To decide: size batches from the output a model actually used earlier
  in the run, so the first call does not have to fail.
- **Planning the packed pair checks takes minutes of processor time.** Each fit test compiles a whole prompt; one
  reviewer's plan took about three and a half minutes before its first call. To fix: estimate from record sizes
  and compile only the chosen batches.
- **Gemini's output is almost all thinking, and its CLI adds an agent's instructions.** Measured on the first
  complete panel run (answer size from the stored replies):

  | Model, effort | Stage | Output tokens per call | Of which answer | Minutes per call |
  |---|---|---|---|---|
  | Gemini 3.8 Flash, high | discovery | 36,700 | about 2,000 | 3.7 |
  | Gemini 3.8 Flash, high | review and conflicts | 21,100 | about 1,500 | 2.1 |
  | Gemini 3.8 Flash, high | critic | 27,100 | about 400 | 2.7 |
  | Opus 5.5, medium | discovery | 9,700 | about 4,400 | 1.5 |
  | GPT-6.1 Sol, medium | discovery | 1,600 | all of it | 0.7 |

  So 93% to 98% of Gemini's output is thinking; it is fast per token (165 a second) and slow per call. Thinking
  counts toward its 65,536 limit, which is why 3 of 16 discovery calls passed it, and one panel's Gemini calls
  wrote 1.2M output tokens, enough to exhaust the Google plan's allowance for the window. Smaller units do not
  help: the thinking does not shrink with the input. Separately, the Antigravity CLI wraps every call in its own
  coding-agent prompt (tools, IDE feedback), which it offers no flag to replace; arbitra's preamble tells the model
  the opposite, and about 7% of Gemini's stored thinking is spent on that conflict, with an occasional tool
  attempt. The halves of a redone unit now run side by side (b1a2785). A lower thinking level
  is not a usable speed control (the CLI offers medium and low as separate models; two stored discovery requests
  were sent again on October 12, counting time, tokens and the shape of the reply): at medium one request took
  4.8 minutes and 44,100 output tokens against 6.6 minutes and 61,400 at high, and the other came back as a
  request for a tool after 2,400 tokens; at low, five calls gave two answers of about 1,500 output tokens in 18
  seconds, one empty finding list after 82 tokens and two requests for a tool. So medium saves about a quarter,
  and low is fast but does not answer reliably.
- **The pipeline confirms almost nothing.** In the same run, peer review cut 86 findings to 50 candidates not
  rejected and lost no planted defect, but only 5 issues were accepted, and none of them was a planted defect: 5 of
  the 7 planted defects stayed among the candidates not rejected. Verification was decisive on 1 of 46 items (the
  pilot allows two model questions a round) and the plan addressed the 5 accepted issues. The Opus-only run looks
  the same: verification decisive on 2 of 48 items. To decide: what a run's accepted list is for when nearly
  everything ends unconfirmed, how much verification a run may spend, and whether the full policy's acceptance
  rule is reachable in practice.
- **Every stage thinks at the audit's effort.** A vote on a few candidates took Gemini 3.8 Flash at high 25,000
  output tokens and two and a half minutes. To decide, by the owner because it changes what a lineup is: a
  lower effort for votes and conflict choices than for discovery.

**Antigravity on a consumer plan (decided for the pilot on October 11).** Google's
[Antigravity FAQ](https://antigravity.google/docs/faq), read on October 11, says headless `agy -p` "is intended
for direct scripting and CI workflows" and that wrapping `agy` inside third-party coding agents or applications
"is not supported under consumer plans". arbitra starts the official CLI and never touches its login, but it is an
application around `agy`. The owner was told and left the choice to the session with speed as the aim, so the
pilot runs four Antigravity calls at a time at a low per-minute rate, and two lineups side by side. Still open for
the product: the terms of each vendor's subscription CLI need a check before arbitra recommends subscriptions.

**Fixed.** The P20 pilot found two defects on October 10, twelve on October 11 and three on October 12; all seventeen are fixed and
verified on Linux, and the second was also checked live on the owner's Windows PC
([qa/subscription-cli](docs/qa/subscription-cli/README.md)):

- **Discovery could not pass a call that reached the output ceiling (fixed in 7f52969).** An Opus 5.5 discovery
  call at xhigh stopped at the 64,000-token ceiling. The run failed, and every resume failed again without a new
  call. Discovery now replaces such a unit with smaller ones over the same source: scopes of at most half the
  bytes, then halves of one file by lines ([harness](docs/harness.md#context-and-output-capacity)).
- **The Antigravity transport reported the CLI's error step as tool use (fixed in 2bd8162).** The step is the
  CLI's answer to a reply cut at the model's own output limit; Gemini 3.8 Flash at high reached it in three pilot
  calls. The reader now takes the reason from the CLI's conversation database and returns `OUTPUT_LIMIT`, so
  discovery splits that scope too. Thinking is no longer counted twice in Gemini's output.
- **Peer review checked one candidate pair per call (fixed in 42da89f).** When a reviewer's candidates need two
  review batches, every pair across them is checked for a merge. With 38 and 30 candidates that was 1,140 calls
  of about 59,000 tokens for one reviewer, more than a week of a ChatGPT Plus allowance. Pairs are now packed as
  the critic packs its own, and those 1,140 pairs take four calls
  ([harness](docs/harness.md#context-and-output-capacity)). What follows peer review (a second round, conflict
  resolution, verification) has not yet run at this size.
- **Clustering made one call per pair with the whole repository attached (fixed in a33d4e8).** In a
  single-auditor audit, 20 clustering calls took 1.13M input tokens, 57% of the run's tokens, to return about
  1,500 tokens each. The pairs now share one call, and each decision is still recorded per pair. In its first
  real run the same audit took 10 calls and 0.86M tokens, where it had taken 33 calls and 2.04M.
- **One reply that used the CLI's own tool failed the whole run (fixed in 3e2bbc7).** A Gemini peer-review reply
  ran `run_command`. The attempt still fails and nothing it did is used, but the call is now tried again in a
  fresh process within `maximumRetries`.
- **A peer review whose repair stopped at the output ceiling could not go on (fixed in 4290af2).** A Gemini review
  of 19 candidates was refused once, and its repair then passed the output limit. Only the repair was marked, so
  every resume replayed the refused reply and failed at the same repair. The harness now marks the activity
  itself, and peer review goes on in batches of half the size, kept durably so a resumed run plans the same
  batches.
- **Independent calls ran one after another (fixed in 14ae7aa and e107937).** The reviewers of a round, the batches
  of one review, the scopes of a discovery and the auditors of a conflict each waited for the one before. They
  now run side by side: reviewers of a round and auditors of a conflict always, the rest up to
  `maximumParallelCalls` per auditor (default 1), which since b1a2785 includes the halves that replace a
  discovery unit stopped at its output ceiling and since cf50a96 the parts of a critic review (seven parts one
  after another were 21 minutes of a panel run). Replies are applied in a fixed order, and a conflict that
  shares a candidate with an earlier one waits for it, so the outcome does not depend on which call returns first
  ([provider model](docs/provider-model.md)).
- **Three bookkeeping slips each cost a whole repair call (fixed in 14ae7aa and 094eb56).** Added evidence that
  does not cite itself is completed, a packed pair check may merge any candidates it presents, and a citation of
  another candidate's evidence is left out when the operation also cites its own. Together they were 21 of 28
  repair calls in one run.
- **The frame around repository content escaped quotes (fixed in 24eacf4).** `&quot;` was 36% of the characters
  of an audit's discovery prompts, 18% of a review prompt and 9% of a conflict prompt, and models copied the
  entity into the evidence they quoted. Text inside the frame can leave it only through markup, so it now escapes
  `&`, `<` and `>` and leaves quotes as written (frame version 2, [security](docs/security.md)).
- **One bad operation refused a whole reply (fixed in 7986f77).** A reply of about 20 operations was repeated
  over one or two of them, and a reply still invalid after its repairs lost all of them. Each operation is now
  checked on its own: one that fails is left out and recorded, evidence it would have added is withdrawn from
  the others' citations, and a changed vote without new evidence is left out so the earlier vote stands. A reply
  is refused only when it is invalid as a whole or would lose more than half of its operations
  ([provider model](docs/provider-model.md)).
- **A stored prompt stopped parsing after redaction (fixed in e83dc94).** A source line ending in an assignment
  (`apiKey: config.gateway.apiKey,`) sat before an escaped quote in a stored prompt. The redactor took its own
  marker and that backslash for a secret again, the escape was lost, and the artifact was no longer JSON: the
  first run on the new frame failed after its three discovery calls, and so did its resume. Before the frame
  change the same rule ran on through the `&quot;` entities: in the stored compiled prompt, the source line
  after such an assignment was folded into it and lost its line number. An assigned secret no longer ends in a
  backslash, and artifacts are redacted value by value (redaction pattern version 3).
- **One provider's content filter failed the whole audit (fixed in f22dcc8).** Gemini answered one discovery unit
  three times with "This request was blocked by Gemini's filters". As plain text it was repaired as invalid JSON,
  the run failed after its repairs, and every resume failed again. The CLI transports now report the notice as a
  refusal, the harness records it durably, and discovery tries the unit once more in smaller parts and leaves what
  is declined again unexamined for that auditor: when the failed run was resumed on a copy, 79 lines of one file,
  for Gemini only. A declined
  review batch counts as rejected output and a declined conflict vote is not cast
  ([provider model](docs/provider-model.md)).
- **A provider's passing outage failed the run (fixed in 32f46ff).** One Antigravity call ended with "Eligibility
  check failed: ... UNAVAILABLE (code 503): The service is currently unavailable." The text was not recognised as
  an upstream error, so the call was not retried within `maximumRetries` and the run failed; its resume went on.
  A status of that kind is now retried like any other unreachable service.
- **An empty SUCCESS from the Antigravity CLI failed the run (fixed in 9f22652).** The CLI reported SUCCESS with no
  answer in the last critic call of a panel run, 117 minutes in. It was not retried, so the run failed there. An
  empty SUCCESS is now tried again in a fresh process within `maximumRetries`.
- **Every verification question carried all of the run's unresolved peer operations (fixed in 295b939 and 568d10b).** Two
  panel runs failed in verification on October 12, after both review rounds: one had 22 unresolved operations
  (190,000 characters), more than the verifier's context, so no question could be asked; the other had 15
  (99,000), and its second question no longer fit. Every resume failed the same way. A question now carries the
  operations that involve its own candidate, and one that still cannot fit is not asked: the candidate stays
  unverified and the run records it. The planner had the same input and would have failed next: the plan now
  reads the operations that involve accepted issues, each reading stage those of its own issues and the outline
  only which issues each one ties together ([provider model](docs/provider-model.md)). The run that had already
  asked one question then stopped on resume with `MODEL_ACTIVITY_INPUT_CHANGED`, because that question's input
  had changed under the same activity name; the activity is now named after its input, so such a run asks again
  (568d10b). On the fixed builds both runs passed verification: two questions each, about 54,000 input tokens a
  question in the first. The size limit that made this fatal counts one byte as one token, which is still open
  above.
- **A unit a few percent over the byte estimate failed the run (fixed in a19a2dc and c5eb65c).** After the
  verification fix both panels failed again within the hour, each on a unit that cannot be made smaller: one
  planner task with its issue's two unresolved peer operations (29,000 characters), and one plan revision item
  that names all seven tasks of a 77,000-character plan. Each was a few percent over 128,000 bytes, which the
  estimate reads as the whole window although the provider counts about half. Such a unit is now tried as
  required input before the stage gives up: with unresolved peer operations in outline, then with no optional
  source at two bytes a token, under the same margin and output reserve; the harness and the provider pool
  count it at the same rate ([harness](docs/harness.md#remaining-explicit-limits)). Grouping still uses the
  byte estimate, so calls that fit are sized as before. The commit message of c5eb65c says the estimate
  overstates prompts "about three times"; the measured figure is about twice. On the fixed build the revision
  item was sent: about 150,000 bytes, which the model counted as 60,140 tokens.
- **A revision item that stopped at the output ceiling failed the run (fixed in 8c60fcb).** The third of ten
  revision items thought for nine minutes at xhigh and stopped at 64,000 output tokens; the first two had used
  19,500 and 32,900. One critique item cannot be asked for in smaller parts, so the run failed after three
  hours, and its resume too. The plan now keeps its tasks for such an item, its resolution says it was not
  revised, and a blocking question names it ([harness](docs/harness.md#remaining-explicit-limits)). In that run 4 of the
  10 items ended this way, each after about eight minutes, and 6 were worked in. A planner task expansion is
  handled the same way since 45f66ef: it is asked for once more in its scoped form, and if that stops at the ceiling
  too the task keeps its outline and a blocking question names it. That models think up to the ceiling in these
  stages is the item above on effort, and still open.

All eight findings in [qa/p19](docs/qa/p19/README.md) are fixed, and the affected live acceptance passed on subscriptions on September 30 (runs A–E there). The reruns found four more defects; all are fixed. The completion report is P21, after P20.

See [project status](docs/project-status.md) for implemented capabilities and measured evidence. Evidence per item is in [docs/qa](docs/qa/); the subscription runs are in [qa/p03-subscription](docs/qa/p03-subscription/README.md). Update task status only in the completion plan.
