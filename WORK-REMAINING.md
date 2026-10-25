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
- **Default lineup:** New run starts on Claude Code and Codex (`subscription-audit`, audit-balanced at depth deep, no
  peer-review round, Sol as plan critic and Opus checking its critique); Gemini is the opt-in
  `subscription-audit-gemini` template, labelled with Google's terms. The Feature templates still use Antigravity as
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

- **The plan critic, scored ([real-project runs](docs/qa/real-runs.md#the-plan-critic-scored-october-25)):** 18 of 20
  items real, 1 of 21 plan errors execution met, and the revision wrote errors of its own, for 11.5 to 17% of a run.
  Decided (owner, October 25): off by default and an option at every depth, built with "Depths and steps" below,
  although the spec makes the critic mandatory for deep audits and critical or high security issues (§3.7, §20.6).
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

- **Test files packed with their source:** whether claims about production code that cite only tests go away, and
  what the 9% more discovery units cost.
- **The new export:** how many workarounds the executing agents still need, against nextra's stale lines, wrong
  premises and false waits; and how often a prompt's `<write_scope>` was too narrow.
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
plan as the Summary's first action, and the Lighter lineup at medium and low effort. The build has started on the
`ui` branch: the run page first, then Issues, Plan and Results, then New run once the depths are settled. Defects the inventory
found, fixed in the rebuild: an absent run answers `RUN_API_500`; Workflows opens on an `UNAUTHORIZED_CHANGE` refusal;
the report's copy button is announced as "copy run id"; saving the plan twice writes a second folder; Overview and
Issues scroll sideways on a phone; the check says "ready to start" above a refused snapshot; a failed run offers a
resume that cannot help; a whole-repository audit's graph shows "Diff scope" and a "Disagreement" loop with no review
rounds; the repository field starts on the server's own folder; and depth means effort, against spec §16.4. It owns:

- "Balanced" and "deep" name two settings: the workflow (two or three auditors) and the audit depth (effort).
- The owner's drag-and-drop "slots" idea for settings, audited against a preset with a lineup card and a plain role
  list, not assumed.
- How models are found and chosen, which the setup barely says.
- Whether a run's critic ran or was "not required", which the run page does not show.
- **What a run will use, before it starts:** an estimate in each vendor's five-hour and weekly windows from the
  measured 600 to 700 tokens a line, with its basis, and the lines and share of the estimate per folder, each folder
  one tick to leave out. Today the check says "not known before the run" and "no pricing is configured".
- **Suggested leave-outs:** generated, vendored and minified files ticked with their reason, each one untickable
  (veritra: 20,000 lines left out by hand, 16% of what would be read). The detection is built (12bbaf6) and today's check lists them with one "leave them out".
- **Tests: audit them or leave them out,** with this project's test lines and their share of the estimate. Default on:
  on four runs 6 to 15% of confirmed issues cited only tests (all medium, mostly tests that cannot catch the defect
  they are named for), for about 4 to 7% of a run's tokens in units holding only tests.
- **What goes into the plan:** critical and high only, or medium too (`planScope.minimumSeverity`). Medium issues
  are 77 to 91% of verification questions, and verification about 55% of a run.

## Need design

- **Depths and steps (owner's design, October 25; the first changes are building):** Gemini, when chosen, runs at
  high at every depth and takes work that would otherwise spend Opus or Sol: the owner says many people have it at
  little cost and unused, while Opus and Sol must be used sparingly. Deep, balanced and cheap differ only in models
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
  GPT-5.6), at 1/20 of Sol's Codex credits. Needed first: effort words for Sonnet, Haiku and Luna (they run at the
  CLI's default today), an effort for finding on its own, an explicit critic switch in place of the depth rule
  (`model-pipeline.ts:920`), depth presets that write models and efforts, and finder presets named by count (not
  `audit-balanced` and `audit-deep`).
- **Let discovery read across its unit** (owner: go; building October 25): tools may read the whole snapshot, every unit gets a file
  and symbol index, and the prompt says to read the caller, callee or other side. Only 8 of nextra's 97 discovery calls
  used a tool; 52 limitations say a caller was "not supplied".
- **Compare the right pairs for duplicates** (*before veritra*): cross-auditor pairs first, same-answer pairs last (1
  merge in 332), a higher ceiling when batched, and TF-IDF neighbours in other files (the export's version found 4 of
  nextra's 5 overlaps).
- **A variant sweep after verification** (owner: yes, an optional step; after the depths lane, on Gemini when chosen): check each confirmed defect's siblings (same callee,
  handler family or flag). It runs after verification, so the six finished runs can test it first.
- **Check each prompt's premises at export** (owner: yes; building October 25, with a script in the plan folder): resolve every path, symbol and quote a task names, and
  mark the ones that do not resolve.
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
