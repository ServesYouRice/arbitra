# Remaining work

Updated November 1, 2026, on `main`. This file lists open work only, each item with its next step and its place in
the order below; an item is deleted once it is done, and Git keeps its history. Run records and measurements are in
[real-project runs](docs/qa/real-runs.md), phase status in the [completion plan](docs/completion-plan.md), the design
review in the [design audit](docs/design-audit.md), the research behind the pipeline in [research](docs/research.md),
and how the project's own testing runs, the vendors' terms and how to pick the work up in
[developing arbitra](docs/development.md).

## State

- **Releases:** v0.4.0 (November 1: the Windows exe and the source zip) is the latest: cheaper reading and checking, a
  Codex usage warning, tests left out of an audit until ticked in, and plans no longer ignored by Git. Work continues on
  `main`; [`TESTERS.md`](TESTERS.md) is the testers' guide.
- **nananananana, November 1:** audited on v0.3.2 ([real runs](docs/qa/real-runs.md#the-runs)); its plan is in the owner's
  checkout, and the owner has started carrying it out. New projects come next: the owner would rather not run earlier ones again.
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
7. **Improvements the measurements support** (the rest of "Need design").
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
