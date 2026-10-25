# Remaining work

Updated October 25, 2026, on `main`. This file lists open work only, each item with its next step and its place in
the order below; an item is deleted once it is done, and Git keeps its history. Run records and measurements are in
[real-project runs](docs/qa/real-runs.md), phase status in the [completion plan](docs/completion-plan.md), the design
review in the [design audit](docs/design-audit.md), the research behind the pipeline in [research](docs/research.md),
and how the project's own testing runs, the vendors' terms and how to pick the work up in
[developing arbitra](docs/development.md).

## State

- **Releases:** v0.2.2 and `checkpoint-2` (October 24, 847878b) are the latest. Work continues on `main`;
  [`TESTERS.md`](TESTERS.md) is the testers' guide.
- **Default lineup:** New run starts on Claude Code and Codex (`subscription-audit`: two finders at depth deep, no
  peer-review round, plan critic off); balanced and cheap depths, a third finder and the critic are separate
  choices in New run (October 25). Gemini is only ever the opt-in third finder, labelled with Google's terms. The Feature templates still use Antigravity as
  their second reviewer behind the same warning.
- **Evidence:** six real projects audited; nextra's plan carried out on its `dev` branch: all 126 confirmed issues
  were real, 118 shown by a failing test, and 14 more defects were found while fixing. P20 is closed on its pilot
  (October 19); its held-out set stays unrun by design.
- **Clear now, October 25:** the dependency advisories, the self-audit's open defects and the small items, in 16
  lanes, each defect shown by a failing test first (afb494f to 26af136). Two were product defects found on the way:
  arbitra could not start an npm-installed Claude Code (`claude.cmd`) as the native Testing writer on Windows, and a
  quoted secret in source carried as JSON reached the model unmasked. The full check now passes on Windows, the
  native-harness suites included.
- **Research review, October 25:** every step checked against other labs, products and our own runs
  ([research](docs/research.md#12-the-review-of-october-25)). Its ideas are placed below.
- **veritra, October 25:** audit running on 45ed1d2 (`run-e5546c4c`, 416 files, 103,575 lines of which about 40,000
  are tests; generated files left out). The 400-file snapshot limit refused it and is now 1,000. The builds marked
  *before veritra* were not in it, so this run is their baseline.

## Order of work

1. **Measure first** (no model calls, or one cheap run): they decide what to cut before anything is built.
2. **Small builds before the next real runs** ("Need design", marked *before veritra*).
3. **The next real runs:** veritra and nananananana, once their current development settles. Audit both on the current
   build, carry out one plan with the new export, and take the measurements under "Measure on the next runs".
4. **UI phase**, on its own branch, alongside the veritra audit; the owner reviews it.
5. **Improvements the measurements support** (the rest of "Need design").
6. **P21**, the completion report and the docs reconciled with the final build, then a release.

## Clear now

Small defects the October 25 lanes found and did not fix, each to be shown by a failing test first.

- **A symbolic link pointing outside the root in a `working_tree` diff fails the whole snapshot**; the repository walk
  skips such links silently.
- **An event whose sync failed after a full write is kept**, so a retry records it twice.
- **After the operator answers a question the critic's revision could not settle**, the gate still reports
  `blocking_critic_feedback`.
- **Discovery calls run past the 15-minute call limit and start again from nothing:** 7 of veritra's first 36 (4 of
  22 Opus, 3 of 14 Sol), none in the six earlier runs; Opus wrote 33K tokens a call against nextra's 23K. Each costs
  a slot for 15 minutes and the tokens already spent. Take the durations from the finished run, then size the limit
  or the units from them, or split a unit that times out as one that stops at the output ceiling.
- **The planner's `audit_mode_is_read_only` constraint makes sections ask whether they may write** (two questions in
  each nextra plan): reword it.
- **`filesNotToTouch` globs do not subtract from `likelyFiles` globs**, and a bare `.` in `likelyFiles` covers nothing.

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

- **Discovery reading beyond its unit** (production-audit 2.0.0): audit nextra again from
  `arbitra-experiments\checkouts\nextra` with run ccd3ccea's lineup, after a cheap shakedown of the reads. Does it
  find the client that never sends the operator token, and the other client–server misses; how many calls read
  beyond their unit (8 of 97 before) and how many limitations say "not supplied" (52); what the index costs in
  units and tokens (13 KB a unit on nextra) and how much of it the cache serves.
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
- **The verifier's required reason:** how often an answer leaves it out and costs a repair.
- **A Sonnet second look at medium reports Opus leaves unsettled:** build it as an option, off by default; it decided
  6 of 7 rightly on nextra, at about 28K tokens a question.
- **Eight discovery units at a time** instead of four: the audit runs in two waves (14 minutes of a 28-minute run).
- **Claude Code's cache on first calls:** 72 first calls in one run wrote 1.18M tokens and read none.
- **Whether the critic still lacks its source** (`critic-result.citedSourceLeftOut`), if it stays.
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
plan as the Summary's first action, and the Lighter lineup at medium and low effort. The build is on the `ui` branch:
the run page first, then Issues, Plan and Results, then New run. Issues, Plan and Results
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
repository field started on the server's own folder; and depth meant effort, against spec §16.4. Still open from the
inventory: Workflows opens on an `UNAUTHORIZED_CHANGE` refusal; Overview scrolls sideways on a phone; and a failed
run offers a resume that cannot help. It owns:

- Whether a run's critic ran or was "not required", which the run page does not show.
- **New run, left for later:** what a run will use as a share of each vendor's five-hour and weekly windows (the app
  does not know the person's plan; today it shows tokens per vendor and a time range from the measured runs); a
  switch for checking each issue, which the runtime does not have; the variant search as one entry in the steps list
  once `workflow.variantSearch` lands; and estimates for balanced and cheap, which say "not measured yet" until a run
  of each is measured.

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
  finder, else Sonnet 5.5 · high). Left: the measured runs that set the defaults; `arbitra replay` still turns the critic on;
  the renamed presets' browser tests have not run.
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
- **Hand the verifier its context:** callers, definitions and imports up front, file reads reused across questions on
  one file (a question costs about 74K input tokens for under 1K of output). Owner: measure it later on a project
  smaller than veritra.
- **Review each fix from another vendor** (owner: yes, later, as "Check the fixes"): root cause or guard, a variant the test misses, a new defect.
- **Memory across runs:** stable issue fingerprints, disproved claims as prior evidence, fixed issues found again
  marked reopened.
- **Docs and standards as an oracle:** README, docs, `.env.example` and configuration as untrusted claims to check.
- **Cache layout:** the stable part of each verification prompt in the CLI's system-prompt file, questions ordered by
  the file they cite, the first call sent before the rest.
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
- **The other five run plans** (beachflag, rokavatar, raquelsblog, commentanywhere, rokbot): when the owner wants
  those projects fixed. Re-export each first so it gets the current export.
