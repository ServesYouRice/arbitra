# Remaining work

Updated November 1, 2026, on `main`. This file lists open work only, each item with its next step and its place in
the order below; an item is deleted once it is done, and Git keeps its history. Run records and measurements are in
[real-project runs](docs/qa/real-runs.md), phase status in the [completion plan](docs/completion-plan.md), the design
review in the [design audit](docs/design-audit.md), the research behind the pipeline in [research](docs/research.md),
and how the project's own testing runs, the vendors' terms and how to pick the work up in
[developing arbitra](docs/development.md).

## State

- **Releases:** v0.4.0 (November 1, 301aa45: the Windows exe and the source zip) is the latest: cheaper reading and checking, a
  Codex usage warning, tests left out of an audit until ticked in, and plans no longer ignored by Git. Work continues on
  `main`; [`TESTERS.md`](TESTERS.md) is the testers' guide.
- **nananananana, November 1:** audited on v0.3.2 ([real runs](docs/qa/real-runs.md#the-runs)); its plan is in the owner's
  checkout, and the owner has started carrying it out. New projects come next: the owner would rather not run earlier ones again.
- **memoria, November 10, in progress** (`run-bcd4fc1e`, 567 files, 88,659 lines, tests left out): Opus 5.5 xhigh
  through the owner's **Anthropic API key** (finder, checker, planner; $200 of credit to use up), Sol through Codex,
  Gemini 3.8 Flash high through Antigravity. Found while running, fixed on `main`:
  - The Anthropic API route had never run against a current model: every call was refused (effort sent as
    `thinking.effort`), nothing was cached, and thinking blocks were not replayed (664e9fa). With the fix Opus's
    discovery made 755 calls without an error, 96 units, 601 findings, about $115 (cache writes and output dominate).
  - Antigravity 1.5.4 follows Gemini's reply with "improperly formatted function call" and retries by itself: 6 of
    Gemini's first 10 units failed and three in a row ended its discovery. A whole reply is now kept (1906cfd), and the
    failure no longer counts towards the row (5d4b08b).
  - **Open:** the automatic resume after a usage limit lives only in the server process; a restart drops it, so the run
    had to be resumed by hand. New run should also check the API key route before Start, and offer a dollar cap.
  - Sol's ChatGPT Plus window ran out twice (18:49 and 22:27); a project this size takes more than one window.
  - November 11: Antigravity's Gemini allowance ran out for 72 hours after 5 units. A resume can now leave a finder out
    (`leaveOut`, f3f0971): its unanswered 99 units are gaps, and it reviews nothing.
  - Consensus put all 684 issues to Opus at about $0.25 each, low ones too; a resume can now skip those below the plan's
    scope (`skipBelowPlanScope`, a10f773), which left 305. **Cost finding:** cache writes were $65 of verification's
    ~$80 (13.0M written, 32.0M read): each question writes its own ~11k-token start, read back only ~2.5 times.
  - **State at 10:30Z:** paused on Sol's Codex window (second opinions) until 12:17Z, server timer set (build
    `main-a10f773`, port 4181). 306 issues asked; the API credit is nearly spent (~$82 since 08:18Z), so the plan may
    need more credit.
- **Default lineup:** New run starts on Claude Code and Codex (`subscription-audit`: two finders at depth deep, no
  peer-review round, plan critic off); balanced and cheap depths, a third finder and the critic are separate
  choices in New run (October 25). Gemini is only ever the opt-in third finder, labelled with Google's terms. The Feature templates still use Antigravity as
  their second reviewer behind the same warning.
- **Evidence:** nine real projects audited; nextra's plan carried out on its `dev` branch: all 126 confirmed issues
  were real, 118 shown by a failing test, and 14 more defects were found while fixing. P20 is closed on its pilot
  (October 19); its held-out set stays unrun by design.
- **Research review, October 25:** every step checked against other labs, products and our own runs
  ([research](docs/research.md#12-the-review-of-october-25)). Its ideas are placed below.
- **veritra, October 25:** audited (`run-e5546c4c`, 416 files, 103,575 lines of which about 40,000 are tests;
  generated files left out): 256 of 929 confirmed (36 high, 220 medium), a plan of 227 tasks, 70.0M tokens. It ran on
  45ed1d2, finished on that build plus the critic and revision fixes it showed were needed
  ([real runs](docs/qa/real-runs.md#the-runs)). The 400-file snapshot limit refused it and is now 1,000. The builds
  marked *before veritra* were not in it, so this run is their baseline.

## Order of work

1. **Testers' reports:** a defect is shown by a failing test, fixed on `main` and released as a patch; a
   request goes into the lists below. Next: a cheap run on the MacBook that lets it sleep once (keeping
   awake, the sleep seen, its calls sent again and the two-minute wait were only faked in tests; Linux's
   `systemd-inhibit` too). Left by the October 27 fixes: the CLI has no command for a new audit that
   reuses a stopped run (its refusal names `run <config> --incremental <id>`); native-harness and batch-lane calls get
   no sleep handling; stage and run times on the run page still count time asleep; the P20 premise driver does not keep
   the computer awake.
2. **veritra's plan,** after the reset on October 31: re-export run `run-e5546c4c` on the current build, carry its 227
   tasks out on veritra's `dev` branch (never `main`), count what the prompts did not cover, and take the export,
   premise-check and write-scope measurements under "Measure on the next runs".
3. **Measure first** (no model calls, or one cheap run): they decide what to cut before anything is built.
4. **Small builds before the next real runs** ("Need design", marked *before veritra*).
5. **The next real runs:** projects not audited yet (game, memoria, spectra), from the week of November 2, on the
   current build, with "Measure on the next runs". The owner would rather not run earlier projects again.
6. **UI phase**: built on the `ui` branch, merged into `main` and released in 0.3.0; the owner's review and the
   testers' reports go on.
7. **Improvements the measurements support** (the rest of "Need design"). The run helper's steps 1 and 2 can be built
   alongside, since they spend no model calls; steps 3 and 4 wait for its measurements.
8. **P21**, the completion report and the docs reconciled with the final build, then a release.

## To test next week

On the projects not audited yet, one change at a time; each decides a default. The research is in the session's report
of November 1 (its sources are named in [real runs](docs/qa/real-runs.md#what-the-reading-costs-november-1)).

- **Unit sizes:** Opus's units are smaller than Sol's only because sizing reserves each model's whole output ceiling
  (84 units against 49 on nananananana). Even them out and compare confirmed issues and tokens.
- **Effort across whole units:** about 15 units at xhigh against high and medium on both vendors, counting confirmed
  issues and quota. Effort cannot change inside a tool loop. No study measures effort on finding bugs.
- **A scout for the reading:** Sonnet or Haiku writes a read list for about 15 units; compare it with the files the
  confirmed issues cite. Go on only at 95% or more, stop under 90%, then run the analysis on the prefetched content.
  No measured study shows a cheaper model can choose the reading without losing findings.
- **The cited files in a question:** send the lines around a location instead of a whole file over about 16 KB, and
  compare verdicts. This is the largest lever on checking, and it removes what the checker can see.
- **Balanced and cheap:** neither has a measured run on a real project. A run of each sets their estimates, and tests
  turn limits of 6 and 5, which would have touched at most 9 and 17 of nananananana's 175 confirmed issues.
- **Cheap's wide pass, then a deep pass,** or the union of repeated cheap runs, for cheap only.
- **Luna as the second finder at deep or balanced:** it costs 1/20 of Sol's Codex credits and Codex's window is the limit.
- **The index in the system prompt:** about 2.6% of Opus's discovery cost, but it gives repository text the authority of
  a system prompt: the owner's call.

## Measure first

From the research review; each decides a cut or a build.

- **Test the rejections by running code, once:** an agent tries to write a failing test for nextra's 13 severe and 10
  random medium rejections (about 2.8M tokens). None real: drop the second opinion before rejecting a severe issue (it
  agreed 20 of 22 times). Two or more real: build the execution rung.
- **What the severity bar throws away:** match the 14 defects found while fixing nextra against its 223 never-verified
  low candidates, then verify a random 25 (about 2M tokens).
- **A proof-replay script in each plan folder:** the proofs, checked (115 of 124 behavioural, 9 not; cited ranges
  ran in 11 of 14 re-run), showed `results.json` needs the fix commit, the proving test files and the failure's class
  (assertion, exception, hang, missing export, source text) for a script to rerun each proof on the fix's parent and
  on the fix. A prototype and the measurements are kept outside the repository, in the experiments folder's
  `measure-2026-10-25`.
- **A recall estimate in every run report:** capture–recapture over the auditors' confirmed issues (Opus and Sol
  together find about 82 to 87% of what the pipeline could confirm, an upper bound), with the survival ledger designed
  on October 14.

## Measure on the next runs

- **Discovery reading beyond its unit** (production-audit 2.0.0, cheaper from 2.1.0): on nananananana (November 1,
  [real runs](docs/qa/real-runs.md#the-runs)) every unit read beyond itself (about 12 files, against 7 to 12 in the
  unit), 151 of 175 confirmed issues cite a file beyond their unit, and it doubled the tokens a line, with 70
  limitations where the budget ran out and half of Opus's units at their last turn. It stays. Built November 1:
  `repo_symbol`, search context, asking for all lookups in one reply, the turns left in the last result of a turn,
  tool-turn limits by depth (deep 8, balanced 6, cheap 5). On the next runs: `toolUseOfUnits` (turns, calls by tool,
  names looked up), whether the citations hold, tokens a line against 1,330, and whether New run's estimate and
  `PLAN_WINDOWS` need new figures.
- **Test files packed with their source:** whether claims about production code that cite only tests go away, and
  what the 9% more discovery units cost.
- **The new export:** how many workarounds the executing agents still need, against nextra's stale lines, wrong
  premises and false waits; and how often a prompt's `<write_scope>` was too narrow.
- **The premise check** (built October 25, `premise-check.ts`): whether agents run `check-premises.mjs` before each
  task, act on `<not_found>` (16 of 2,132 on nextra, most of them library names), and need fewer workarounds for
  moved lines (201 moved over nextra's fixes).
- **The variant search** (built October 25, `workflow.variantSearch`, off at every depth): replay it on the six
  finished runs (beachflag, rokavatar, raquelsblog, commentanywhere, nextra, rokbot) with
  `tooling/variant-replay/replay.mjs`, Sonnet 5.5 · high searching (`--searcher-copy` from a Claude Code profile),
  Gemini 3.8 Flash high where the run had three finders. How many variants it proposes, how many survive validation
  and the duplicate check, how many verification confirms and how many of those are real (nextra's 14 defects found
  while fixing are a check), and what the search and the checking of its proposals cost in tokens and minutes. That
  decides whether a depth turns it on, and the batch size (`VARIANT_SEARCH_SEEDS_PER_BATCH`, six for now).
- **Discovery units split at the time limit** (built October 25, `timeLimitSplits`): how many units split, whether a
  part ran past the limit again (it is then sent again whole), and the minutes and tokens against veritra's 8 calls
  sent again whole.
- **Gemini with the tools preamble** (#5, built October 27): replayed, Gemini asked for code 4 times of 4 instead of
  0 of 3, twice through agy's own tools first, each a retry. On the next run with Gemini: how many of its discovery
  calls use the snapshot tools, how many try agy's own (each costs an attempt; if often, answer them with a short
  corrective turn in the same conversation instead), and whether reading changes what it confirms. On the MacBook
  run it confirmed 19 issues no other finder found, as many as Opus, with no tool call at all.
- **GPT-6.1 Sol's discovery at xhigh** (#3): awake, its turns took 5 to 12 minutes at 1 to 3 output tokens a second,
  most of the 15-minute limit, where its first turns took 25 to 60 seconds; on nananananana, with reads in small turns,
  37 seconds at the median and 359 at most. Compare a run's Sol turns at xhigh and
  at high before the limit or the default effort changes.
- **Codex's system skills:** every Codex call installs its system skills under `~/.codex` (on October 26, calls side
  by side printed "failed to install system skills" to stderr). Check whether skills instructions reach the prompt,
  and whether a setting turns them off.
- **The verifier's required reason:** how often an answer leaves it out and costs a repair.
- **A Sonnet second look at medium reports Opus leaves unsettled:** build it as an option, off by default; it decided
  6 of 7 rightly on nextra, at about 28K tokens a question.
- **Eight discovery units at a time** instead of four: the audit runs in two waves (14 minutes of a 28-minute run).
- **Claude Code's cache on first calls:** 72 first calls in one run wrote 1.18M tokens and read none.
- **Whether the critic still lacks its source** (`critic-result.citedSourceLeftOut`), if it stays: on veritra's
  227-task plan its 12 batches carried none of the 254 files the plan cites.
- **What a verification question costs:** 159K tokens on nananananana (197 questions, 31.4M, 3 calls a question), 116K
  on veritra, 75K to 86K before that. About 70% of a question's cost is its first call, which writes the whole cited
  files to the cache (48 KB on average, each file sent 5.3 times), and a later turn is mostly cheap cache reads. Built
  November 1 (targeted-verification 1.1.0): related source up front (2.8 KB a question), questions in the order of the
  files they cite, the locked layer in Claude Code's system prompt. The run report's `verification questions` shows
  what it does; the estimate is about 10% fewer tool calls and no net change in tokens.
- **What the injection scanner's hits hold**, before sending them to model follow-ups.
- **Four measurements from October 11 to 13:** prompts sized at one byte a token outside the stages that set
  `estimatedBytesPerToken`, discovery source as one JSON object a line, Gemini's output nearly all thinking, a pinned
  copy of each CLI per protocol. Re-read them from the new runs' traces, or drop them.

## UI phase

Audit every screen, control and term; research how people want this kind of setup and result shown; design around a
person's work (pick a project, choose how thorough with measured cost, start, watch, read the issues, take the plan,
see its results); one word per idea and models named by model and effort (`Opus 5.5 · xhigh`); mockups the owner
chooses from before code; then build on a `ui` branch with the browser tests. Done when the owner signs off and the
browser suite passes in Linux. Step one is done (October 25): an inventory of every screen with 70 screenshots and a
research report, kept outside the repository in the experiments folder's `ui-2026-10-25`, and the mockups the owner
chooses from ("arbitra UI Mockups": start, watch, issues, plan and results, and the words). The owner chose A for
every screen (October 25), with Watch's stages drawn as a graph whose lines into the running stage move, saving the
plan as the Summary's first action, and the Lighter lineup at medium and low effort. It was built on the `ui` branch
and merged into `main` on October 25: the run page first, then Issues, Plan and Results, then New run. Issues, Plan and Results
were built on October 25: the issues grouped by verdict (confirmed, unsettled, rejected, not checked), most severe
first, each with its place, who found it and who checked it by model and effort (the checker read from the run's model
attempts, so balanced's Sonnet checks show as Sonnet), "variant of" when an issue carries `variantOf`, and its
evidence, the check's reason, a second opinion and dissent one click down; the plan in its saved folder's order of work
(questions first, tasks with their model, "after" and "same files as", the unsure reports after the tasks, from a
read-only outline route that shares the export's rules), with the Summary's save card and, once saved, how much of what
the prompts name the premise check did not find; and each issue's result from `results.json`, the tasks' issues apart
from the reports checked after them. Fixed by that build: an absent run answered `RUN_API_500` (now 404); saving the
plan twice wrote a second folder (the Plan tab had its own save button); Issues scrolled sideways on a phone; a
whole-repository audit's records showed "Diff scope" and a "Disagreement" loop with no review rounds; and the Summary
said the plan checks unsettled issues first, when the saved plan checks them after its tasks. The report's copy button
was already named for the report. New run was built the same day as one page: the project, a card per depth with what each step runs and what a run
will use, the steps with their switches (the variant search among them), what to read, what goes into the plan, and
this computer, checked as it is filled in. Fixed by it: the check said "ready to start" above a refused snapshot; the
repository field started on the server's own folder; and depth meant effort, against spec §16.4. The inventory's last
defects, fixed the same evening: Workflows opened on an `UNAUTHORIZED_CHANGE` refusal (a preset's template kept the
shipped ID; it now opens as `<preset>-copy`); a failed run offered a resume that could not help (the recorded reason now
decides: start again, fix this computer and resume, resume now, or update arbitra and then resume, as veritra's four
stops needed); and the run page did not say whether the plan was reviewed (How it ran, on the Summary too, now says it,
also when Review the plan was off). Overview no longer scrolls sideways on a phone: on the rebuilt pages the three
real runs' Summary and every other place measured 0 px at 390 px. It owns:

- **New run, left for later:** what a run will use as a share of each vendor's five-hour and weekly windows (the app
  does not know the person's plan; today it shows tokens per vendor and a time range from the measured runs); a
  switch for checking each issue, which the runtime does not have; estimates for balanced and cheap, which say "not
  measured yet" until a run of each is measured; and a run through API keys, or with a model named on an
  OpenAI-compatible endpoint (Kimi through Moonshot, OpenRouter, a local server), which New run now writes but no run
  has made: the effort words it sends through the APIs follow the CLIs' and are unverified there (the paid-API
  bundle is parked).

## Need design

- **Depths and steps (owner's design, October 25; presets, effort words and the critic switch built the same day):** Gemini, when chosen, runs at
  high at every depth, since many people have it at little cost and unused while Opus and Sol must be used
  sparingly, but only on optional work (the third finder, the variant search), never a core role: the owner does not
  trust it with checking, merging or planning. Balanced and cheap send medium issues to Sonnet 5.5 · high and keep
  Opus 5.5 · high for critical and high ones (owner, October 25). Deep, balanced and cheap differ only in models
  and efforts: deep has frontier models (Opus 5.5, GPT-6.1 Sol) at xhigh and high, balanced the same models at low and
  medium, cheap mid-tier models (Sonnet 5.5, OpenAI's mid tier) at about medium. Two or three finding models is a
  separate choice. Every step from finding issues to the planner is available at every depth and can be switched off;
  a step is recommended off only where the runs showed its value is weak (the plan critic). Examples: deep with Opus
  and Sol only, balanced with all three models and every step. The defaults are then set from measured runs on a
  project smaller than veritra, with strong models at low and medium effort among them (this also answers the
  cheaper-checks item below). Replaces today's depth-as-effort, against spec §16.4. Researched October 25 (kept in
  the experiments folder's `depth-2026-10-25`): today's default is already deep; nothing lower has run on a real
  project. Effort is the lever where output dominates (finding, planning); checking is 99% input, so there only the
  model's tier saves (lowering its effort saves about 2%). OpenAI's mid tier today is GPT-6 Luna (Terra is the older
  GPT-5.6), at 1/20 of Sol's Codex credits. Built: effort words low to max for every Claude and
  OpenAI model, an effort for finding on its own, `workflow.critic` (off by default) in place of the depth rule,
  `roles.mediumVerifier` and `roles.merger`, depth presets in New run that write models and efforts, finder
  presets named by count, and the variant search (`workflow.variantSearch`, off; Gemini searches when it is a
  finder, else Sonnet 5.5 · high). Left: the measured runs that set the defaults; the renamed presets' browser tests
  have not run.
- **Which read tools finders get** (owner's proposal, issue #7, October 27; the symbol lookup and limits by depth were
  built November 1, without raising deep's limit). Next, in order: Git history behind a switch, off by default
  (`repo.gitLog`, `repo.gitDiff`, blame, pinned to the snapshot's commit; emails redacted; `docs/privacy.md` says that
  messages and authors go to the vendors); then linters, type checkers and an offline advisory lookup run once by
  arbitra in the isolated execution, their output a readable artifact; regex search last (17 of 334 distinct
  queries had regex-like characters, all literal call text). Claude Code's own `Read`, `Grep` and `Glob` over a
  redacted copy only as an opt-in, and only if a side-by-side run shows more confirmed issues (results `native:`, not
  pooled). Stay refused: a shell for any vendor, Antigravity's own tools, web search and fetch, writes, MCP servers,
  subagents, skills and the operator's own CLI configuration.
- **Compare the right pairs for duplicates** (*before veritra*): cross-auditor pairs first, same-answer pairs last (1
  merge in 332), a higher ceiling when batched, and TF-IDF neighbours in other files (the export's version found 4 of
  nextra's 5 overlaps).
- **Re-audit only what changed:** a later run on the same project audits the diff since the last run and the files
  that import it, and carries forward the issues still present. Builds on "Memory across runs". Owner: wanted, later.
- **Boundary units from a channel map:** socket events, routes and fetch paths, WHIP/WHEP and environment keys found
  without a model; one unit per channel with both sides' handlers. First check, free: does the map join the files of
  nextra's four client–server misses.
- **Severity from stated preconditions** (reachability, the login or action needed, the impact), mapped by code and
  answered again by the verifier, so the plan's scope uses a verified level. Severity is the weakest step today.
- **Review each fix from another vendor** (owner: yes, later, as "Check the fixes"): root cause or guard, a variant the test misses, a new defect.
- **Memory across runs:** stable issue fingerprints, disproved claims as prior evidence, fixed issues found again
  marked reopened.
- **Docs and standards as an oracle:** README, docs, `.env.example` and configuration as untrusted claims to check.
- **The execution rung,** only if the rejection test above shows it is needed (design in the research review).
- **Duplicates across discovery units,** **partial stages told the rest of the repository exists** and **a critic
  batched by task** are covered by the items above.
- **Cheap verification steps answer "inconclusive":** keep them as context for the verifier, not as verdicts.
- **Profile settings that change nothing:** `promptStyle`, `fewShotPolicy`, `documentPlacement`, `historyPolicy` and
  the sampling defaults are set by the templates and ignored. Build them or remove them.
- **A critique with degraded coverage blocks revision of all its items**; the spec suggests revising the accepted ones.
- **Questions are not merged** on the `outlineInSections` path, nor across revision rounds.
- **A pair check that stops at the output ceiling** is re-sent as segments up to 16 times.
- **A descendant that holds no pipe and whose parents have exited** is out of reach on POSIX; it needs a Job Object or
  a cgroup.

## Run helper (owner's proposal, November 4)

An AI helper that lives in arbitra, outside the runs: it watches runs, resumes the ones a resume can help, and
writes Feature requests by asking the owner questions. Built in four steps, each usable on its own; the next step
starts only once the one before it has worked on real runs. It never changes the project's code or arbitra's own code
(that stays the operator's job), and it never decides what the owner has not.

**An orchestrator of the orchestrator (owner, November 4):** the helper is code first. Watching, sorting a stop,
waiting, resuming, counting tries and recording are plain functions and runners, with no model call. A model is
called only where code cannot decide: the interview's questions and the request it writes, a stop no rule names, and
a repair proposal. Its model is a frontier one by default (Opus 5.5), chosen by the user in settings
(`helper.model`, any profile the lineup could use), and each call gets only the facts the code gathered (the reason,
the run's status, the report's lines that matter), never the whole run. Today arbitra already sends a failed model
call again (up to 3 attempts) and after the computer slept, and a run paused on a usage limit whose reset time is
known resumes by itself a minute after it (`#wakeups` in `orchestrator.ts`, kept only in memory while arbitra is open).
Every other stop, a time-out or a provider failure among them, stays stopped until the person presses Resume; step 2
adds those, and moves the usage-limit wakeup into the helper so there is one place that resumes.

```text
 owner ──► interview ──► Feature request ──► run starts
                                               │
              run stops ◄──────────────────────┘
                 │  read the reason (failureWords)
     ┌───────────┼──────────────┬────────────────────┐
  resume now   fix computer   start again       inside arbitra
  (wait, then  (tell owner,   (tell owner,      (tell owner, attach the
   resume)      wait)          no resume)        report, no resume)
```

1. **Move the failure reading out of the web app.** `failureWords` and `resumeRefusalWords` live in
   `apps/web/src/app/words.ts`; the helper runs on the server, so the rules that sort a reason into the four kinds
   move to `packages/runtime` (for example `failure-kinds.ts`) and return a kind (`resume-now`, `fix-computer`,
   `start-again`, `inside-arbitra`) plus the facts the words need (the CLI, the variable, the sleep times). The web
   words are then built from that kind, so the page and the helper can never disagree. Its tests are today's word
   tests, moved, plus one per kind. No model calls.
2. **Auto-resume, no model.** A `RunHelper` in `packages/runtime`, started by the server (`apps/server/src/serve.ts`),
   follows each run through `orchestrator.events(id)`. When a run fails:
   - `resume-now`: a usage limit waits until its reset, as the orchestrator's `#wakeups` does today, and when no
     reset time was given, until `usage-windows.ts` says the window has room (today such a run waits for the person);
     a time-out or provider failure waits a few minutes; then it calls `orchestrator.resume(id)`.
   - Any other kind: no resume; it records why and shows the owner the same words the run page shows.
   - Limits: at most 2 automatic resumes per run and none for a reason that already came back after one; a run the
     owner cancelled is never resumed; on by default (owner, November 4), with a switch per run
     (`workflow.autoResume`) and a global one in settings to turn it off. It only ever resumes `resume-now` stops, so
     on by default cannot repeat a stop that a resume would only repeat.
   - A stop no rule names (today's `inside-arbitra` fallback) goes to the helper's model once, with the reason and the
     report's last lines, which answers one of the four kinds or "unknown"; "unknown" is never resumed.
   - Every action is a record in the run's store (`helper-actions`: time, reason read, action, result) and an event
     on the run's stream, so the run page shows "resumed by the helper at 14:02, because …".
   - Tests with an injected orchestrator and clock: each kind, the retry limit, a cancel during the wait, a server
     restart during the wait (the wait is stored, not only in memory).
   Measure on the next real runs: how many stops it resumed, and how many of those then finished.
3. **The interview for Feature requests.** A model step before Feature mode's own requirements step
   (`model-requirements.ts`): from the owner's first sentence and the project's snapshot it asks at most about 5
   questions at a time, in plain words, each with a proposed answer, over at most 3 rounds; then it writes the
   `feature.request` and shows it to the owner, who edits or approves it before anything else is spent. It reuses
   the checkpoint pattern (`plan-questions`, `RequirementsCheckpoint`: versioned, durable, the same in CLI, HTTP and
   web) as a new `feature-interview` checkpoint, and a protocol of its own (`feature-interview`) so its prompt is
   versioned like the others. It runs on the helper's model (`helper.model`, frontier by default). Tokens are saved
   by code, not a smaller model: the repository context is the snapshot's file list and the symbol lookup's names,
   not file contents, unless the model asks to read a named file; answered questions are kept as short records, not
   the whole chat. Web: a chat-like panel in New run, Feature tab. CLI: `interview <config>`, then
   `respond-checkpoint`. The approved request and every question and answer are artifacts of the run. Test first on
   two Features of a project already audited, against requests the owner writes by hand: are fewer requirements left
   ambiguous.
   **For Audit too, optional and short** (decided November 4): a "Help me set it up" button in New run asks at most 3
   questions (which folders matter, what the project does, what worries the owner) and fills in the folders and a
   focus note for the finders. Skipping it starts the audit as today. Built after the Feature interview, from the same
   checkpoint.
4. **Limited repair, last and only if step 2's measurements show stops it could not help.** A model reads an
   `inside-arbitra` or `fix-computer` failure with the run's report and proposes one change from a fixed list:
   raise the run's token ceiling (the resume body already takes one), lower a stage's batch size, switch a failed
   optional step (third finder, variant search, critic) off, or name the command the owner should run on this
   computer. The owner approves each proposal; nothing is applied on its own. It never edits files, never changes the
   lineup's core roles, and never hides a failure: an `inside-arbitra` stop is always also reported as a defect for
   "Testers' reports". Spending cap per run, counted in the run's tokens.

Decided November 4: auto-resume is on by default for `resume-now` stops; the interview is offered for Audit as an
optional short setup; the helper's model is the user's choice, frontier by default, and the helper spends tokens only
where its code cannot decide.

## Less work for the user (owner, November 4)

Seven features so the person only starts a run and approves results. The research behind them, with what other tools
do and how far their numbers can be trusted, is in [what other tools do](docs/research-other-tools.md) (November 4,
mostly read from search snippets). Its main lesson: the tools that save the most work act on their own in a copy of
the code, check their own result with the same check that found the problem, and leave the last click to the person.
Order: 2, 4 and 3 first (cheap), 7 alongside, then 1, then 6 and 5. Each uses the run helper's model where a model
is needed, and code everywhere else.

1. **Fix it for me.** A button on the run's Summary that carries out the plan instead of exporting prompts only.
   - Where: one Git worktree per task on a new branch `arbitra/fix-<run>`, built on the Testing mode's
     `testing-worktree.ts`, `testing-task-runner.ts`, `testing-repair.ts` and `testing-task-verifier.ts`. The
     person's checkout is never touched; the result is a branch and a diff they apply with one click (or a PR they
     open). The model's network is off while it edits; running the project's own tests is an opt-in on the first use.
   - What: only confirmed issues, one task per diff, in the plan's order; a diff touching files outside the task's
     write scope is flagged (this builds the parked "Enforcing the write scope").
   - Proof: the task's test runs on the unchanged code (must fail) and on the fixed code (must pass), run by arbitra,
     not by the agent; the project's existing tests must still pass. Then the finder that reported the issue and one
     model of another vendor are asked whether it is gone and whether the diff adds a new defect.
   - Tampering: agents edit or delete tests to pass (ImpossibleBench: 92% on impossible tasks, 1% with a strict
     prompt). Edits to existing tests, test configs, CI files and skip markers are refused; the agent must stop and
     say why instead.
   - Honesty: a task whose test could not run is marked "unverified", never "fixed"; `results.json` gets the same
     record as today, plus applied as-is / applied with edits / thrown away, counted per model.
   - The prompt export stays for design-level tasks and for anyone who prefers it. Expect far less than vendor
     numbers: agent pull requests are merged 35–65% of the time against about 78% for people's (AIDev, 456K PRs).
   - First: run it on nextra's already-fixed issues, from the commit before the fixes, and compare with the owner's
     fixes.
2. **Just go.** New run opens with one button that needs only the project folder.
   - Code picks everything: depth from the project's size and what `usage-windows.ts` says is left of each plan
     (deep when the estimate fits, else balanced, else cheap, with the reason shown); the lineup from the CLIs
     `preflight.ts` finds signed in; folders as today's defaults (`generated-files.ts`, tests out).
   - New: read the project's own `AGENTS.md`, `CLAUDE.md`, `.cursorrules` and Copilot instruction files, matching
     names in any case, as untrusted context for the finders (CodeRabbit misses `claude.md` by matching exact case).
   - The estimate and what was chosen are shown before Start, each changeable; nothing is hidden. No model call.
3. **Suggested answers to the plan's questions.** Each blocking question in `plan-questions.ts` gets a proposed
   answer with its reason, the recommended option first, and an "Other" box (Spec Kit's `/speckit.clarify` shape:
   at most 5 questions, answers saved with the plan). "Accept all suggested" covers only questions where the
   planner and the other vendor's model proposed the same answer; a question they disagree on, or whose blast radius
   is high, must be answered one by one, since people shown a wrong suggestion follow it (one study: 14 points of
   accuracy lost). The record says which answers were taken as suggested.
4. **Short summary.** The Summary opens with at most 3 issues to worry about, each in two plain sentences (what can
   go wrong, who can trigger it) with its evidence one click down. Ranking is code: severity, then the verifier's
   verdict, then how many vendors found it; one of the 3 places is kept for a confirmed critical or high issue only
   one model found, since ranking by agreement buries those. One model call writes the sentences from the issue
   records. Every other issue stays one click away; nothing filtered is hidden.
5. **Ask your run.** A chat on the run's page, and on each issue, answered only from the run's records (the
   issue, its verification, the snapshot's code at `file:line@commit`, the plan task); an answer that goes beyond
   them says so. It reads by tool calls over the run store, not by loading the run into the prompt. Its answers about
   rejected issues are checked separately: Semgrep's agreement was 96% on real issues but 41% on false alarms.
6. **Auto re-check.** After commits (a Git hook or a watch on the folder, the person chooses) or on a schedule, a run
   of "Re-audit only what changed" (above, in "Need design") reads the changed files and what imports them; a full
   audit runs weekly or monthly, since changed-files runs miss what spans files. Needs "Memory across runs"
   first: issue IDs from category, file and the code's text, not line numbers (line numbers make every issue below
   an edit look new). An issue is closed only when the re-check read its place and the code there changed;
   "fixed" (code changed) is kept apart from "dropped" (arbitra or its settings changed). Starts only while arbitra
   is open, within a spending cap.
7. **Auto bug report.** When a run stops `inside-arbitra`, the helper drafts the issue: what happened in plain words,
   version, system, the error and the stage, from `SendReport.tsx`'s report. No code, prompts or paths by default; a
   local secret scan must pass before the draft is shown (5,881 real secrets were found in public GitHub issues); the
   same stop seen before (a signature from error and stage) links the earlier issue instead of a new one. The person
   reads it and sends it through the pre-filled `issues/new` link, as today. Nothing is sent by itself.

## Parked

Out of the plan until the named event happens.

- **Engineering restructuring** (shared admission across runs, per-stage envelopes, clustering by representatives, one
  staged-call port for every mode, README and spec files as untrusted evidence; sizes in the
  [design audit](docs/design-audit.md#engineering-review-of-october-14)): when a defect traces to one of them.
- **Edge contracts of saved graphs**, stored but not applied: when the graph editor is used for real.
- **Feature and Testing output repairs not resized:** when those modes get real use.
- **Experiments 12, 13, 15 and 17** ([design audit](docs/design-audit.md#what-changes): lower efforts, a second
  varied discovery pass, another vendor verifying a sample, a static analyser): when a run shows defects being missed.
- **The paid-API bundle** ([completion plan](docs/completion-plan.md#deferred-the-paid-api-bundle)): with funded API
  accounts. P21 lists it as deferred.
- **A resumed Claude turn returned its tool-call markup as text once:** if it happens again.
- **Injection follow-ups from the scanner's hits:** once the measurement above shows what they hold.
- **Enforcing the write scope** (today it is advice in the prompt): when plans are carried out by agents arbitra
  starts itself.
- **An operator's cancel releases the call's slot at once**, before its CLI stops: if it ever overlaps a new run.
- **The plan critic's other spec triggers** (migration, deployment, auth redesign, cross-service, large task graph) have
  no data source in audit mode: if the critic stays.
- **The other six run plans** (beachflag, rokavatar, raquelsblog, commentanywhere, rokbot, nananananana; its 7 open questions wait for the owner): when the owner wants
  those projects fixed. Re-export each first so it gets the current export.
