# Remaining work

Updated October 25, 2026, on `main`. This file lists open work only, each item with its next step and its place in
the order below; an item is deleted once it is done, and Git keeps its history. Run records and measurements are in
[real-project runs](docs/qa/real-runs.md), phase status in the [completion plan](docs/completion-plan.md), the design
review in the [design audit](docs/design-audit.md), and how the project's own testing runs, the vendors' terms and how
to pick the work up in [developing arbitra](docs/development.md).

## State

- **Releases:** v0.2.2 and `checkpoint-2` (October 24, 847878b) are the latest. Work continues on `main`;
  [`TESTERS.md`](TESTERS.md) is the testers' guide.
- **Default lineup:** New run starts on Claude Code and Codex (`subscription-audit`, audit-balanced, no peer-review
  round, Sol as plan critic and Opus checking its critique); Gemini is the opt-in `subscription-audit-gemini`
  template, labelled with Google's terms. The Feature templates still use Antigravity as their second reviewer behind
  the same warning.
- **Evidence:** six real projects audited; nextra's plan carried out on its `dev` branch: all 126 confirmed issues
  were real, 118 shown by a failing test, and 14 more defects were found while fixing. P20 is closed on its pilot
  (October 19); its held-out set stays unrun by design.
- **Research review** of every step against other labs and products, asked for on October 25: in progress. Its ideas
  join "Need design" or "Parked" below.

## Order of work

1. **Clear now** (October 25, in progress).
2. **The next real runs:** veritra and nananananana, once their current development settles. Audit both on the current
   build, carry out one plan with the new export, and take the measurements under "Measure".
3. **UI phase**, on its own branch, alongside the veritra audit; the owner reviews it.
4. **Improvements the measurements support** ("Need design").
5. **P21**, the completion report and the docs reconciled with the final build, then a release.

## Clear now

Each defect is proven by a failing test before its fix.

- Dependency advisories: zod 4.6.6 (high), fastify 5.12.6, fast-uri, vitest 4.1.12. Done in afb494f; `pnpm audit`
  finds none.
- Cap the verifier's output: one Sonnet question ran to the 128K-token limit.
- Merge plan questions across plan sections (nextra asked one question in three sections).
- Give "cannot tell" and "rejected" verdicts a one-sentence reason, shown where they reach a person.
- Stop labelling candidates "no consensus" in a run with no review.
- Read `.webmanifest` files in the snapshot.
- `arbitra audit --preset` builds a configuration with no models.
- The critic's risk triggers receive a hard-coded `deepMode: true`.
- Stop offering models the Git tools that always fail on a snapshot.
- Re-ask a rejected merged issue place by place only across files, by default (10 to 16% of a panel's tokens bought 7
  of 50 confirmations, none a planted defect).
- Stop ranking issues by the model's stated confidence (0.70 to 0.86 for right and wrong verdicts alike).
- Make the full check pass on Windows: 35 native-harness tests fail here because their stand-ins need a Unix system,
  and `treeTerminated` is assumed after the leader exits. Check whether a real Claude Code installed as `claude.cmd`
  starts at all.
- Wire the derived write envelope (`packages/security/src/envelope.ts`) into saved plans, so a plan written from
  untrusted text cannot widen an executing agent's scope.
- The self-audit's open defects of October 19 (run `run-fddb5d17`): redaction (bracket index access, swallowed
  delimiters, escaped newlines in JSON-encoded source, quotes that redaction makes ungroundable), process termination
  (POSIX process groups, Windows descendants, `treeTerminated`), CLI transports (identical prompt prefixes resuming
  the wrong conversation, three dialects ignoring the output ceiling, leftover trees checked only on success),
  pipeline (peer conflict resolution failing the run on one bad reply, grouped verification never re-asking place by
  place or exceeding its question limit or showing finder-named ids, merge recovery stopping after one defect, a
  critic that does not complete replacing earlier blocking items, critic revisions bypassing the question checkpoint,
  malformed or refused evidence operations dropping citations, moved locations invalidating evidence), discovery
  (oversized injection follow-ups skipped, unbounded recursive splitting, quadratic quote widening), repository
  (diff paths, untracked files in `working_tree`, excluded directories walked), a failed event append poisoning later
  records, and write-scope overlap that understands only a trailing `/**`.

## Measure on the next runs

- **Test files packed with their source:** whether claims about production code that cite only tests go away, and
  what the 9% more discovery units cost.
- **The new export:** how many workarounds the executing agents still need, against nextra's stale lines, wrong
  premises and false waits.
- **A Sonnet second look at medium reports Opus leaves unsettled:** build it as an option, off by default; it decided
  6 of 7 rightly on nextra, at about 28K tokens a question.
- **Eight discovery units at a time** instead of four: the audit runs in two waves (14 minutes of a 28-minute run).
- **Claude Code's cache on first calls:** 72 first calls in one run wrote 1.18M tokens and read none.
- **Whether the critic still lacks its source** (`critic-result.citedSourceLeftOut`): seen at the Antigravity CLI's
  prompt limit; the default critic is now Sol.
- **What the injection scanner's hits hold**, before sending them to model follow-ups.
- **Four measurements from October 11 to 13:** prompts sized at one byte a token outside the stages that set
  `estimatedBytesPerToken`, discovery source as one JSON object a line, Gemini's output nearly all thinking, a pinned
  copy of each CLI per protocol. Re-read them from the new runs' traces, or drop them.

## UI phase

Audit every screen, control and term; research how people want this kind of setup and result shown; design around a
person's work (pick a project, choose how thorough with measured cost, start, watch, read the issues, take the plan,
see its results); one word per idea and models named by model and effort (`Opus 5.5 · xhigh`); mockups the owner
chooses from before code; then build on a `ui` branch with the browser tests. Done when the owner signs off and the
browser suite passes in Linux. It owns:

- "Balanced" and "deep" name two settings: the workflow (two or three auditors) and the audit depth (effort).
- The owner's drag-and-drop "slots" idea for settings, audited against a preset with a lineup card and a plain role
  list, not assumed.
- How models are found and chosen, which the setup barely says.

## Need design

Built only where the measurements support them.

- **Duplicates across discovery units** are never compared. The export's TF-IDF similarity found 4 of nextra's 5
  overlaps; it could send likely duplicates to the merge check.
- **Partial stages are not told the rest of the repository exists:** give them its file index. Plan sections and the
  critic have the source tools and used none in six runs.
- **Batch the critic by task with the files each cites**, if the measurement above shows it is still short of source.
- **Cheap verification steps answer "inconclusive":** symbol, call-path, route, configuration and import checks
  (`inconclusiveTools` in `packages/runtime/src/model-pipeline.ts`), while verification is about half a run's tokens.
- **Profile settings that change nothing:** `promptStyle`, `fewShotPolicy`, `documentPlacement`, `historyPolicy` and
  the sampling defaults are set by the templates and ignored. Build them or remove them.

## Parked

Out of the plan until the named event happens.

- **Engineering restructuring** (shared admission across runs, per-stage envelopes, clustering by representatives, one
  staged-call port for every mode, README and spec files as untrusted evidence; sizes in the
  [design audit](docs/design-audit.md#engineering-review-of-october-14)): when a defect traces to one of them.
- **Edge contracts of saved graphs**, stored but not applied: when the graph editor is used for real.
- **Feature and Testing output repairs not resized:** when those modes get real use.
- **Experiments 12, 13, 15, 16 and 17** ([design audit](docs/design-audit.md#what-changes): lower efforts, a second
  varied discovery pass, another vendor verifying a sample, an execution rung, a static analyser): when a run shows
  defects being missed.
- **The paid-API bundle** ([completion plan](docs/completion-plan.md#deferred-the-paid-api-bundle)): with funded API
  accounts. P21 lists it as deferred.
- **A resumed Claude turn returned its tool-call markup as text once:** if it happens again.
- **Injection follow-ups from the scanner's hits:** once the measurement above shows what they hold.
- **The other five run plans** (beachflag, rokavatar, raquelsblog, commentanywhere, rokbot): when the owner wants
  those projects fixed. Re-export each first so it gets the current export.
