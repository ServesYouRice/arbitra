# Remaining work

Updated October 14, 2026 (branch `beta`).

## State on October 14

- **No P20 runner is alive.** The 2.6.0 panel run failed in plan revision on October 14 at 02:40 (see "Open
  findings"). Claude's week stood at 84% that afternoon (the runner stops at 90%; reset Saturday, October 17,
  04:00), so the runs wait for the reset, and the week went to the rebuild the owner asked for ("The rebuild of
  October 14" below). Protocol 2.7.0 is ready on build de060b6; the private `HANDOFF.md` holds the P20 state and
  how to start it.

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

**The owner's targets (October 12).** A panel run may take about 1.5 times the time of three Opus-only runs and
about 1.7 times their tokens, with quality kept ("if 3 opus runs take 1h, we are allowed to ourselves like 1.5h
instead, or if 3 opus runs take 3m tokens, we are allowed 5m"; guiding lights, not fixed numbers). Measured that
day on one project: one Opus-only run 20 minutes and 0.9M tokens, the panel at xhigh 301 minutes and 20.3M. So
the targets there are about 90 minutes and 4.5M tokens. Changes that alter what the pipeline is are to be checked
against Anthropic's current prompting and orchestration guidance before they are built (the owner's condition).
Three Opus-only runs together then measured 51 minutes and 3.0M tokens, so the aim for that panel is about 77
minutes and 5.0M tokens.

**The speed build (October 12, evening): one pass per review stage.** Checked against Anthropic's guidance first
(quotes read on the pages). The guides do not discuss review rounds, votes on conflicts or pair checks; their own
review tools find in parallel, check each finding once against the code in a sub-task of its own, then filter
("for each vulnerability ... create a new sub-task to filter out false-positives. Launch these sub-tasks as
parallel sub-tasks"), and a loop that cannot settle is to "escalate to a human, return the best attempt with
caveats". On effort: "Reserve `xhigh` and `max` for work where you've measured a quality gain." On critics: "A
reviewer prompted to find gaps will usually report some, even when the work is sound." What the build changes
(`docs/provider-model.md`, "One pass per review stage"):

- The examples review once (`maxConsensusRounds` 1). What the round leaves undecided goes to verification, so
  conflicting proposals are no longer voted on; a second round is still a setting.
- Verification asks about every undecided candidate (the bound was 4 by default and 2 in the pilot), side by
  side, each question with the source its candidate cites and their modules instead of all the source that fits.
  An unanswered question leaves its candidate open instead of failing the run.
- A review batch must carry the source its candidates cite. Cross-batch merge checks, critic pair checks and the
  critic's second reading of a revised plan are off unless `review` asks for them.
- The critic reads the accepted issues, not every issue (it was given 71 for a plan of 6).
- `stageEffort` sets the effort of each stage after discovery; `estimatedBytesPerToken` sizes those calls (the
  examples use 2). Discovery units are unchanged on purpose: a larger unit is a different audit.
- Sizing adds up what each file costs (3 or 4 prompt builds a call instead of one per file), and planner briefs
  and task expansions run side by side.

Not built: a run without a plan (only an authored graph can leave the planner out); source first in the prompt
for provider caches (few calls share a prefix once the stages read once); a plan too large for one revision call
is still revised item by item, one after another. To measure on the same project: time, tokens, planted defects
found, and what the accepted list holds.

**Second timed run of the speed build (October 13): the same Opus-only audit, a question reading only the files
it cites.** It had a call in flight for 63 minutes and used 8.8M tokens. Verification did what the change meant:
58 questions in 6 minutes and 2.8M tokens (169 calls; 53 questions asked for more source, three calls a question
on average). The plan took the rest, 45 minutes and 5.9M tokens for 52 issues. What the run showed, each fixed in
the commit after it unless it says open:

- The plan for 52 issues in one call stopped at the 64,000-token output ceiling after nine minutes, and all of it
  was discarded. The run now counts the issues against what one answer is expected to hold and goes straight to
  the notes, the outline and one call a task (`expectedRecordCapacity`). The reserve for the reading notes was 400
  tokens an issue against 870 measured: a batch of more than about 70 issues would have stopped at the ceiling
  and been asked for again one issue shorter each time. It is 900 now.
- Each of the 31 calls that write a task out read 213,000 characters, 105,000 of them the whole outline and 23,000
  the locations of all 52 issues, and source up to the size limit. Such a call now reads its task's neighbourhood
  of the outline with an index of every task, and the files and locations of its own task and issues (estimated
  on the same plan: 89,000 characters).
- Eight replies were sent back as "not JSON", one of them twice: seven were complete documents with one closing
  bracket too many, one restarted in a second fenced block. The repairs read 1.0M tokens in nine minutes. Both
  slips are now read past (`parsePromptJson`).
- A source tool result was cut at 8 KB in the middle of a line while its summary named the whole range; 8 of 22
  cut results were followed by a second call for the same file, each resending the whole prompt. A result now
  holds 32 KB, ends on a whole line and says where to read on.
- Structural clustering merged 19 findings into 7 clusters, every merge joining two findings of the auditor's one
  answer. One cluster held a planted high-severity defect under the title of a low-severity finding; verification
  rejected that title and the defect was lost (6 of 7 planted defects in the raw findings, 5 of 7 after the
  pipeline). The rule is in every earlier build and cost nothing while few clusters were verified.
  `structural-v3` keeps the findings of one answer apart; on the labelled corpora it takes false merges from 14 to
  2 and adds no false split (`docs/qa/p18/README.md`).
- Open: the size of the plan. With every undecided candidate verified, a plan covers about 50 issues where it
  covered one or two, and written out task by task it is about 630,000 characters, 12,000 output tokens a task,
  five times what one call can hold. After the fixes above the plan stage of this run would be about 2.7M tokens
  (not measured: 31 calls of 42,000 tokens in and 12,000 out, the notes and the outline as they were, and 15
  follow-up calls assumed), still the largest stage of a one-auditor run. Whether every accepted issue gets a
  task written out in full, or only those above a severity, is the owner's decision.
- A follow-up call (a tool turn) was a new call that resent the whole exchange as one message: 111 of the 169
  verification calls of this run. On Claude Code a tool turn now continues the CLI's own session with the tool
  results alone (October 14: 91% of a continued turn's prompt came from the cache, 19% when sent whole). Open: the
  same for Codex (`exec resume`) and the Antigravity CLI (`--conversation`), done on October 14 (66c7b17): a
  continued Codex turn read 16,768 of 17,092 prompt tokens from the cache.
- The run's single output ceiling had to fit the smallest model of a lineup (Gemini 3.8 Flash, 65,536), so Opus 5.5
  (128,000) was held to 64,000. Each call now asks for its own model's ceiling.

**The 2.6.0 panel run (October 13 and 14) failed in plan revision.** Its plan, written task by task (31 tasks of
about 20,000 characters), left one critique item whose revision context did not fit
(`PLANNER_REVISION_ITEM_CONTEXT_LIMIT_EXCEEDED`), after a wait of four hours for the Claude window. The critic had
raised 108 blocking items on 30 tasks, and each item was revised in a call of its own that read and wrote the
whole plan header (302 open questions, 138,000 characters) with every neighbouring task in full: the first item
came to over 300,000 characters. What it had decided before it failed, scored afterwards: its accepted list of
53 issues held all 7 planted defects (the 2.4.0 panel's list of 6 held 2), with 13 issues rejected after 38
verification questions; 37 of the 53 accepted reports are outside the answer key, so the list is long. Fixed on
October 14 (ba8e1a9): a call answers the items that name the same tasks,
reads those tasks and what belongs to them, writes only what it changes, and calls on disjoint tasks run side by
side in rounds. Replayed on that run's stored plan and critique: 28 calls in 5 rounds, the largest reading 252,000
characters. A plan in one call where the ceiling allows (91 issues at 128,000 output tokens) came with the
per-model ceiling (cd04742).

**A review of the runs and the code (October 14, evening).** Fixed the same evening, before any 2.7.0 run:

- **Codex never received arbitra's instructions (fixed in 1e000da).** Codex 0.162 ignores `base_instructions` and
  says so only as an error item. Every Codex call of the pilot (GPT-6.1 Sol, GPT-6 Luna) ran without the stage's
  instruction, its protocol and the schema prose; a live check with a secret word confirmed it. They now travel
  in `model_instructions_file`, which also replaces Codex's own agent prompt (a minimal call: 4,849 input tokens
  where it read 14,532), and an ignored setting fails the call. Every panel result so far measured Sol and Luna
  without instructions.
- **A quarter of the critic's blocking items objected to edges the run adds itself (fixed in 7a8212f).** In the
  2.6.0 panel, 27 of 108 blocking items named an edge between two tasks that edit the same file, mostly as
  spurious; such edges are added by the run to order the edits. The waiting task now says why, and the critic is
  told.
- **A revision call could not be joined when an earlier call of its round had retired a task it named (fixed in
  44ccc10).**
- **One hard question left a whole group of verification questions unanswered (fixed in bdb2f34):** the group is
  asked again one question at a time.

Open, measured on the stored 2.6.0 runs:

- **The audit is the smallest stage.** In the 2.6.0 panel (13.7M tokens before it failed) the plan took 37% of the
  tokens, the critic 27%, verification 15%, discovery 11%, peer review 10%; in the Opus-only run the plan took 64%
  and verification 31%. The owner's shape has the audit as the longest part.
- **The critic multiplies the plan's cost.** With tasks of 20,000 characters it reviewed one task a call (37
  calls, Gemini, 1.3M output tokens) and raised 238 items, 108 blocking; each blocking item is revision work. To
  decide: a cap on blocking items, items that must name the defect they would cause, or a critic only for what
  the run cannot check itself (coverage, order and traceability already are).
- **The accepted list is long and repetitive.** 53 accepted issues in the 2.6.0 panel, 40 pairs of them citing
  overlapping lines (31 issues), 20 of low severity; 30 found by one auditor only. Candidate: merge accepted
  issues that cite the same lines before the plan, and rank the list (severity, corroboration).
- **Sections of a plan do not see each other.** In the sections' plan of the comparison, 34 of the 47 files its
  tasks edit are edited by tasks of more than one section, joined only by the run's ordering edges. Candidate: a
  join check over the tasks that share a file, or sections formed by the files tasks write.
- **Token counts include cache reads.** Since sessions continue, most of a follow-up's input is a cache read, which
  subscriptions count for less; reports should show cache reads apart from new input.
- **CLIs update themselves.** The Antigravity CLI went from 1.3.3 to 1.3.5 during the pilot, and the Codex change
  above shows what an update can do. Each run records the versions; pin a copy of each CLI for a protocol, as is
  done for Claude Code.

**Approved on October 14, after the check against the labs' guidance ([research](docs/research.md#1-the-october-14-check)).**
The owner approved six of the seven proposals above on condition that Anthropic's guidance supports them. To build,
in this order:

1. Stable repository text first in every prompt, the per-call item last, effort and schema the same across a stage
   (supported by every lab with caching guidance; Anthropic and Google also report better answers with the question
   last).
2. Merge accepted issues that cite the same lines **and** describe the same defect, and rank the list by severity,
   then by how many models found an issue (Anthropic's Code Review and Codex's review rubric work this way).
3. The critic: each blocking item names the failure it would cause; the critic is asked only what the run cannot
   check itself; non-blocking items are capped, blocking ones are not; a critic's claim is checked before it forces
   a revision.
4. Plan sections formed by the files their tasks edit, with a join check over tasks that still share a file.
5. A plan for the ranked issues above a severity bar, the rest listed without tasks (needs 2; partly supported: the
   sources say measure what the plan adds).

Not built: accepting a finding without a verification question when several vendors' models found it. Every
Anthropic review tool verifies each finding, and papers show models of different vendors share their errors
("models agree 60% of the time when both models err"); agreement ranks an issue instead (item 2).

**The rebuild of October 14 (before protocol 2.7.0).** The owner asked for a rebuild while the runs wait for the
Claude week (plan quality must not regress; any change to calls and follow-ups; no single 64,000 ceiling). Built:

- each call held to its own model's output ceiling, and a tool turn continuing the CLI's own session on Claude
  Code (cd04742), Codex and the Antigravity CLI (66c7b17). The Antigravity CLI kept every call's conversation in
  the operator's home (1.2 GB after the pilot); each is now removed when its call ends, and its `input_tokens`,
  which leaves out cache reads, is counted with them;
- plan revision in parts (ba8e1a9, above);
- verification questions whose claims cite the same files may share a call (`verification.maxQuestionsPerCall`,
  9f20f6d). Replayed on 58 stored questions, three to a call made 25 calls and cut the source read first from
  656,000 to 428,000 characters. Default one a call: Anthropic's guidance favours one consideration per call, so
  the verdicts are to be compared on a timed run before it becomes the default;
- a plan written in sections of related issues side by side (`modelExecution.planSections`, 99b3a17), compared
  first with the planner as it was on the same 52 stored issues (`tooling/planner-compare`, Opus 5.5 at the
  2.7.0 limits): one call 10.3 minutes, 0.18M tokens, 25 tasks; four sections 7.4 minutes, 0.39M tokens, 49
  tasks. A blind judge (GPT-6.1 Sol, issue by issue) preferred the sections' plan for 41 issues, the one call's
  for 10, one tie, and scored it higher on all five criteria (verification 4.21 against 3.50 of 5); the side a
  plan was shown on made no difference. It stays off by default in arbitra; the pilot uses it from 2.7.0.
  Open: the sections' plan is 2.4 times as long, and the critic and the revision grow with the plan. Measure
  them on the first 2.7.0 runs (2.6.0's critic raised 238 items, 108 blocking, on a plan of 30 tasks).

**First timed run of the speed build (October 13): one Opus-only audit.** It had a call in flight for 27 minutes
(17 for the same audit before the build) and used 6.9M tokens (1.0M before). Verification worked as meant: 51
questions, about ten seconds each and four at a time, 45 confirmed and 6 rejected, and no known defect among the
rejected. Two things cost the time and the tokens, and both are fixed in the commit after it:

- Each question read 47 of the project's 57 files, 105,000 tokens. "The files of the cited files' modules" is
  nearly the whole project, because one chain of imports joins most files. A question now reads only the files its
  candidate cites (on the same 51 questions: two files, about 11,500 tokens), and its instruction says to read
  whatever else the answer depends on with the source tools.
- The plan for 45 issues was one call of 55,000 output tokens, eight minutes. It was refused because pairs of tasks
  wrote the same files without an order, and the repair wrote the whole plan again, eight more minutes and 60,000
  tokens, to add the edges the refusal had spelled out. The run now adds those edges itself
  (`withSharedWritesOrdered`, `docs/task-ir.md`).

Still open from that run: a plan for 45 issues is one serial call, the longest after the audit, and it ended at
60,000 of the 64,000 output tokens a call may write. A larger plan falls back to briefs, an outline and one
expansion per task, and each of those calls carries source up to the size limit. Candidate fix: plan sections of
the accepted issues side by side, as whole plans, and join them (the order of shared writes no longer needs a
model).

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

**What the stages between the audit and the plan decided in that run.** The three audits reported 222 findings.

| Stage | Calls | Result |
|---|---|---|
| Clustering and review round 1 | 43 | 63 candidates: 2 accepted, 61 need verification |
| Review round 2 | 51 | 71 candidates: 4 accepted, 55 need verification, 12 without consensus; 6 of the 63 changed outcome |
| Conflict votes | 33 | no conflict resolved; unresolved ones went from 13 to 22 |
| Verification | 3 | 50 items: 2 asked of a model and confirmed, 48 "still needs verification" from a check that cannot answer |

After 163 calls and 95 minutes, 6 issues were accepted and 62 of 71 were still open; none was rejected. Scored
afterwards against the project's 7 planted defects: all 7 were among the 222 findings and all 7 among the 71
issues not rejected, but the 6 accepted issues covered only 2. So review lost nothing and settled nothing: the
list a user would act on holds 2 of the 7, and the 5 others sit among 62 open items. Of the 63
review batches, 43 were pair checks for merges. The plan, its two critic passes and its revision then spent 188
minutes on a plan for those 6 issues. To decide with the owner (it changes what the pipeline is): one review
round unless reviewers split, no conflict votes while they resolve nothing, a verification that asks about every
disputed candidate with a small prompt, and the plan as an optional step after the findings.

**A plan can grow past what its critic can read at all.** In a second panel run (Sonnet 5.5 at xhigh as planner)
the plan for 19 accepted issues came to 460,000 characters: 19 tasks of about 19,000 each and a shared part of
92,000 with 145 open questions. The critic reviews records in pairs with that shared part in every prompt, so not
even two tasks fit one prompt, in whole or in 16 segments (`PEER_PAIR_CONTEXT_LIMIT_EXCEEDED`), and 38 records
mean 703 pairs. The run was stopped there: completing it would have cost hundreds of calls for a stage that
changes no finding. This belongs to the critic's redesign, not to a larger limit.

**The batching overhead, measured.** One "does this prompt fit" measurement builds the whole prompt (redaction,
framing, serialising): about 4 ms for 139 KB before the prompt compiler's share. A stage asks it once for every
source file it tries to add, for every grouping it tries, growing groups one record at a time; the 10 minutes
above are tens of thousands of such measurements. Sizes add up, so each piece can be measured once.

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
- **Prompts are sized as if one byte were one token** (since October 12 a run can set `estimatedBytesPerToken`
  for the stages after discovery; one figure for the run, not per profile). A prompt is admitted when its bytes plus the whole output
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
