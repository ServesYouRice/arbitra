# Remaining work

Updated October 24, 2026, on `main`. Phase status lives in the [completion plan](docs/completion-plan.md) and the
design review's open items in the [design audit](docs/design-audit.md); this file says what is left and in what order.
Earlier measurements are in this file's history: the P20 pilot in `git show e917ec7:WORK-REMAINING.md`, the full
narratives of the real-project runs in `git show 7a68462:WORK-REMAINING.md`.

## State

- **P20 is closed on its pilot (October 19).** On the three pilot projects, wherever three Opus-only runs together
  missed a planted defect, the premium panel found it, using 0.57 to 0.67 times their time and 0.69 to 0.76 times
  their tokens. That is 21 planted defects: an estimate, not a test. Per-defect results stay in the private benchmark
  repository. The held-out set is left unrun by design; the product's claims rest on what each run checks and
  proves, not on the premise.
- **Releases:** `checkpoint-1` (October 20, 281c27c), v0.1.0 (October 21), v0.2.0 (October 23, adds the Windows
  single-file `.exe`), v0.2.1 (October 24, Gemini opt-in), `checkpoint-2` and v0.2.2 (October 24, 847878b: the
  critic on two auditors, the project's commands in plans, secret masking that leaves code readable). Every branch was merged into `main` on October 22; work
  continues from `main`. [`TESTERS.md`](TESTERS.md) is the testers' guide.
- **Next: the improvement phase** below, the changes held back until now because they could destabilise the app.
  Still planned after it:
  - **UI phase**, on its own branch: research how people want run results and settings shown, audit the current UI,
    and agree a direction from mockups before code changes. The UI is wordy, uses similar terms and choices it does
    not explain, and says little about how models are gathered and which are chosen; the original drag-and-drop
    "slots" idea is to be audited, not assumed.
  - **P21**, the completion report, last.
- **Default lineup:** New run starts on Claude Code and Codex (`subscription-audit`, audit-balanced, no peer-review
  round, Sol as plan critic and Opus checking its critique); Gemini is the opt-in `subscription-audit-gemini`
  template, labelled with Google's terms. The Feature
  templates still use Antigravity as their second reviewer (their review needs two independent vendors), behind the
  same warning in New run.
- **A fix proven from a plan:** nextra's critical and one high issue were fixed from the saved plan's prompts
  (TASK-053, TASK-010), each first shown by a test that failed on the unchanged code. nextra's `results.json` holds
  the failing output, so the run's report reads 3 issues proven and fixed (nextra 40a7e0a, released in nextra 2.1.6
  on October 24).

## Real-project runs

| Project, date | Run | Size | Time | Calls | Tokens (per line) | Outcome | Tokens per confirmed issue | Found alone: Opus / Sol / Gemini |
|---|---|---|---|---|---|---|---|---|
| beachflag, Oct 20 | — | 84 files, 11,291 lines | 80 min | 613 | 17.6M (1,560) | 81 accepted (3 high, 25 medium, 52 low), 40 rejected, 11 open | — | — |
| rokavatar, Oct 21 | `run-757824f4` | 117 files, 10,716 lines | about 110 min | 480 | 15.6M (1,455) | 23 of 212 confirmed (3 high, 20 medium) | 677K | 12 / 2 / 0 |
| blog, Oct 22 | `run-7fb6177a` | 164 files, 14,204 lines | 63 min | 359 | 13.1M (922) | 41 of 180 confirmed (3 high, 38 medium) | 320K | 16 / 7 / 2 |
| commentanywhere, Oct 23 | `run-5a90c75d` | 93 files, 11,719 lines | 40 min | 234 | 7.5M (640) | 51 of 150 confirmed (1 critical, 7 high, 43 medium) | 146K | 20 / 8 / 2 |
| nextra, Oct 23 | `run-ccd3ccea` | 172 files, 38,967 lines | 105 min | 683 | 26.8M (688) | 126 of 415 confirmed (1 critical, 21 high, 104 medium) | 213K | 40 / 30 / 3 |
| rokbot, Oct 24 | `run-869f90f0` | 125 files, about 26,100 lines | 71 min | 418 | 15.8M (605) | 102 of 300 confirmed (10 high, 92 medium) | 155K | 45 / 15 / — |

beachflag ran before confirmed issues were reported, so its counts are accepted issues. beachflag, rokavatar and
blog ran with one peer-review round; commentanywhere, nextra and rokbot without one, the default since October 23.
Gemini ran at high thinking on beachflag and rokavatar, at medium after that; rokbot ran on the two-auditor default
(Claude Code and Codex) with the plan critic.

What each run changed:

- **beachflag** (Gemini critic, every issue verified; verification 10.6M of its tokens): Sol as critic and Opus as
  critique checker; verification only of the issues the plan covers (58% of the candidates were below it); the token
  limit sized from the project (3,500 tokens a line, about twice the measured 1,560); raising the limit of a paused
  run; files Git ignores left out of the snapshot (a 600 KB Playwright report refused the project); model-activity
  artifacts open again (their IDs were too long a route).
- **rokavatar** stopped at the critic on the Codex five-hour window and was resumed. Because of it: a usage limit
  pauses the run and resumes it after the reset (475ca4e); "last activity" and the report's state during a stage
  (557d265); and safeguards against losing issues (db282ef, 11bd2cb): check-first prompts for issues the verifier
  could not settle, a severity lowered by one reviewer alone no longer takes an issue out of the plan's scope (25
  such issues here), a second model before a critical or high issue a reviewer backed is rejected (12 here), and the
  accepted issues no task fixes listed in the saved plan (48 here). Together these add about 37 questions to a run
  of this size, about 3M tokens.
- **blog** showed that the snapshot read a fixed list of extensions and left out all 30 `.astro` files;
  Astro, shell, C-family and other common sources are now read (ede4b14). Its replay without peer review is
  `run-d6fbbf98` (experiment 11 below).
- **commentanywhere**, the first run without peer review. A first attempt failed when Gemini asked for a ninth tool
  turn on one discovery window: a tool call past the limit is now answered unrun with `TOOL_TURN_LIMIT_REACHED` and
  the model gets one more turn, and a model that still asks gives a rejected reply that the stage records as a gap
  (26e13e4). With no review round, the consensus reason now says that no review ran (b386e0e).
- **nextra**, the largest so far (13,487 of its lines are tests). Wall time: discovery 53 minutes (Opus the long
  pole; Gemini done after 25, Sol after 29), clustering 6, verification 19 (14.4M tokens in 497 calls for 192
  questions), plan 17, critic and its check 4, revision 5. Of the project's known defects, both access-control
  concerns were found and confirmed, one as the critical issue; a gap that spans client and server (the client never
  sends the operator token a remote host needs) was not. Because of it (80d7065, c419640): Sol opened every finding
  with the `<quotes>` block the prompt asks for before reasoning, 44% of the text, repeated into every later stage,
  and discovery now drops a leading block and records which findings had one (`quoteBlocksRemoved`); and a completed
  run whose gate fails only on work left for a person reads "done · needs you" in the web app, with the issues to
  check by hand, the questions only the project owner can answer and what the run could not see. Without peer
  review no auditor is counted as a missing reviewer. The CLI gate is unchanged and still exits 1.
- **rokbot**, the first default run on two auditors with the plan critic (fixed that morning, see below), audited
  from a clone of its `origin/main`. No call failed. Verification took 8.9M of the 15.8M tokens (319 calls), the
  critic and its check 1.4M (9%), planning and revision 2.2M. 83 of the plan's 84 tasks verify with the project's
  own commands, read from its manifests. The snapshot masked three lines of code as secrets
  (`secrets.token_urlsafe(32)` and two reads of the token header), so the auditors wrote that they could not check
  how the capability token was made and compared: a call or an index on a secret's name now reads as code
  (6daff11). Once, near the end of planning, the server took more than 20 seconds to answer a status request; it
  did not happen again.

Open from the runs:

- **The default Audit ran no plan critic in v0.2.1:** dropping Gemini left two auditors, so `subscription-audit`
  moved to `audit-balanced`, whose graph had no critic node. Fixed October 24: a balanced audit runs the critic when
  `roles.critic` is set. On rokbot the critic and its check cost 1.4M tokens, 9% of the run.
- **Two settings share the words "balanced" and "deep":** the workflow (`audit-balanced` is two auditors,
  `audit-deep` three) and the audit depth (the effort level). The default is `audit-balanced` at depth `deep`. For
  the UI phase.
- **Gemini's share:** its confirmed finds no other model made, against what its audit costs: rokavatar 0 for 2.1M
  tokens at high thinking (560 call-minutes; 17 of 51 calls lost, 12 to its content filter and 5 to its output
  ceiling), 7 in that run's replay; blog 2 for 1.9M at medium (135 call-minutes; 9 of 47 calls refused);
  commentanywhere 2 for 1.1M (6 of 21 refused); nextra 3 for 2.0M (2 of 39 refused).
- Verification costs 75K to 86K tokens a question.
- Plan questions are not merged across sections: nextra has two blocking questions in different sections about the
  same OBS test stream (see Quality below).
- The issue board labels candidates "no consensus" in a run that had no review.
- 13 confirmed nextra issues cite only test files, 6 of them claims about production code, and at least 2 of those
  repeat a confirmed issue that cites the source (see the test-file item below).
- The verifier's rejections carry no reason, only outcome, evidence and confidence, so checking one means reading
  its tool trace (see the abstention item below).
- The snapshot does not read `.webmanifest` files, so claims made only there are invisible to a run.
- **Dependabot:** fastify 5.12.5 (low, header validation) has no patched release yet; the vitest advisory (moderate,
  its mocker, test tooling only) is fixed only in vitest 5, a major upgrade. Both are left until a fix is published.

## Open from the self-audit of October 19

The premium panel on the 25 files changed since 8fcc3df (5,254 lines) confirmed 78 issues; the ones fixed are in the
history. Still open, for the improvement phase (most predate the changes audited; the audit read whole files):

- Redaction: bracket index access after a secret's name is masked as a secret; JSON-encoded source loses escaped
  newlines after redaction; redacting model input and output can make an exact quote impossible to ground.
- Processes: POSIX descendants that start their own group escape termination; on Windows a descendant that holds no
  pipe outlives a normal exit, and `treeTerminated` is assumed; leftover trees are checked only on success.
- CLI transports: identical request prefixes can resume the wrong conversation; three dialects do not enforce the
  output ceiling.
- Pipeline: peer conflict resolution fails the run on one invalid or output-limited reply; grouped verification
  never re-asks a rejected merged candidate place by place, can exceed its question limit, and shows finder-named
  IDs to the verifier; merge recovery stops after one rescued defect; with `recheckRevisedPlan`, a second critic
  that does not complete replaces the first one's blocking items; critic revisions bypass the blocking-question
  checkpoint; one malformed evidence operation can leave dangling or remove valid citations; moving a shared location
  can invalidate evidence grounded at its old range.
- Discovery: dense instruction-shaped text merges into one oversized follow-up that is skipped; recursive scope
  splitting multiplies concurrency and has no depth or spend bound; quote widening is quadratic on repetitive files.
- Repository and Testing: diff paths are taken relative to the audited root, not the repository top level; the
  `working_tree` diff leaves out untracked files; excluded directories are still walked.
- Smaller: a failed partial event append poisons later records; plan write-scope overlap understands only a trailing
  `/**`. (The search tool's one hit per line is deliberate, as grep reports it.) 36 low-severity issues and 39
  undecided ones are in the run's record.

## Improvement phase

Each item changes what the pipeline does or costs, so each is measured before it becomes a default. The targets: a
panel within about 1.5 times the time and 1.7 times the tokens of three Opus-only runs, quality kept; design changes
are checked against Anthropic's guidance first.

**Quality**

- **Test files were audited apart from the code they test.** Units were packed in path order, so `tests/` filled
  units of its own: 6 to 14 accepted issues a run were claims about production code that cited only test lines,
  which clustering cannot join to a report citing the source. Built October 24: each test file goes into the unit of
  the file it imports whose name it carries (else the last file it imports), Python imports are resolved for this,
  and an oversized module splits between a file and its tests rather than inside. Measured on the six real-run
  projects at a 60 KB unit: test files packed with the source their name points at went from 37 of 119 to 82
  (nextra 0 to 31 of 48), test-only units from 23 to 10, and units from 99 to 108 (9% more discovery calls). Still to
  measure on the next real run: claims about production code that cite only tests, and discovery tokens.
- **Stages are not told the rest of the repository exists.** A partial prompt should say it is part of a larger
  repository and list its file index; plan sections and the critic have the source tools and used none in six runs.
  (The project's commands now reach the planners; see below.)
- **Duplicates survive:** pairs from different discovery units with the same failure mechanism are never compared,
  nor are candidates added during peer review with existing ones (2 of 5 and 2 of 7 additions in two panels).
- **Unsure reports are mostly false alarms.** Of nextra's first 6 reports the auditors disagreed on and the verifier
  could not settle, 5 did not hold; the executing agent changed nothing for them, since each prompt asks for proof
  first. The plan now lists them after the tasks, as optional, in `prompts/4-unsure` (they came first, in
  `0-check-first`). Still open: the false-alarm rate among confirmed issues, measured as nextra's plan is carried out;
  and a second look at unsure reports before the plan (another frontier model, or a run), as an option, off by default
  unless nextra's 20 show severe real defects among them; when off they stay on the issue board and in the plan's
  optional section. On nextra's scale it would add roughly 1.5 to 3M tokens.
- **An abstention says nothing about why.** "Cannot tell" and "rejected" should carry one sentence of what the
  source cannot show, shown in the handoff.
- **Plan questions are not merged across sections** (one question asked in three sections); merge them and drop the
  ones the repository answers.
- **The critic works almost without source:** at the Antigravity CLI's prompt limit it left out 153 to 278 cited
  files, and most of its remarks did not hold against the source. Batch it by task with the files it cites (now
  recorded in `critic-result.citedSourceLeftOut`).

**Cost and speed**

- **Verification is still about half a run's tokens** (nextra 14.4M of 26.8M, 192 questions). Issues below the plan's
  severity bar are no longer verified by default (`belowPlanScope: "skip"`; before that, low and informational
  questions were 29 to 35% of a run). A cheaper verifier (design audit item 14) was measured on October 24 by
  replaying nextra's run with Sonnet 5.5 verifying every question (`run-98e2ee7a`, in the experiments folder):
  - **Cost:** hardly lower. Verification took 11.7M tokens in 412 calls against Opus's 13.3M in 454, and 62
    call-minutes against 70; the saving is only what a Sonnet token costs against an Opus one.
  - **Verdicts:** of 188 verified issues, 22 differ (12%). Sonnet confirmed 10 that Opus left unsettled or
    rejected, rejected 2 that Opus left unsettled, and left unsettled 6 that Opus confirmed (2 of them high) and 4
    that Opus rejected.
  - **Where the truth is known** (nextra's plan carried out): Sonnet was wrong all three times. It confirmed the fMP4
    restart claim (check 05, which does not hold), left the forwarded-IP defect unsettled (TASK-005, proven by a
    failing test), and rejected the OBS gate on tunnelled sockets (check 07, real when audited). Opus confirmed the
    second and left the other two unsettled. One more Sonnet confirmation, "`TRUST_PROXY=1` enables IP spoofing",
    looks wrong too: Express's `req.ip` is only logged.
  - **So far:** not worth it. The default keeps Opus. The 18 medium issues where they differ will be judged as
    nextra's plan is carried out; if Sonnet turns out right on most, a medium-only Sonnet verifier for balanced
    audits is worth another look. Deep audits keep frontier verifiers either way.
- **Re-asking each finding of a rejected merged candidate rarely changes the answer:** 10 to 16% of each panel's
  tokens, 7 of 50 re-asked confirmed, none a planted defect. Re-ask only across files, or only at medium and above.
- **No first call reads Claude Code's cache** (72 first calls in one run wrote 1.18M tokens and read none). Measure
  the stage's stable part in the CLI's system-prompt file.
- **The audit runs in two waves** (eight units four at a time: 14 of a 28-minute run). Measure eight at a time.

**Engineering** (sizes in the [design audit](docs/design-audit.md#engineering-review-of-october-14))

- Admission shared across runs; per-stage envelopes; clustering by representatives; one staged-call port for every
  mode (Feature and Testing send the whole repository and hard-code `high` effort); README and spec files as
  untrusted evidence.
- Edge contracts of saved graphs are stored but not applied. Refusing non-default ones needs a definition of the
  default first: fixtures and examples set other values.
- Output repairs of the feature review and critic and the testing writer are not resized (the audit pipeline and the
  staged port are).
- Windows: `treeTerminated` is still assumed after the leader exits; the native harness stand-ins need POSIX.
- Smaller: after a resume one Claude turn returned its tool-call markup as text and the repair restarted its tool
  loop.
- From the spec review of October 24 (built differently from the build specification, or not applied):
  - Model-run verification is one model question per candidate: the deterministic rungs after reading the cited
    lines (symbol and call-path search, route and config checks, import paths) answer "inconclusive"
    (`inconclusiveTools` in `packages/runtime/src/model-pipeline.ts`).
  - Profile quirks are parsed but only `systemPromptSupport` and `toolLoopLimit` act; `promptStyle`,
    `fewShotPolicy`, `documentPlacement`, `historyPolicy` and the sampling defaults change nothing, though the
    templates set them.
  - `arbitra audit --preset …` builds a configuration with no models, so it runs the scripted detectors; model
    audits need `run <config>`.
  - Whether a plan gets a critic is decided by the graph alone: the critic's risk triggers receive a hard-coded
    `deepMode: true`.
  - Models are offered no Git tools (`gitStatus`, `gitDiff` and `gitLog` throw on a snapshot), and computed cache
    breakpoints are never sent.

**Built but not wired.** The cleanup of October 24 removed the modules no entrypoint used. Of the ones it kept, three
were wired on October 24 and the overlap allocator was removed (it bought extra auditors on risky paths, while the
runs moved to fewer review calls):

- **Wired, warnings only:** the deterministic injection scanner and suppression candidates
  (`packages/runtime/src/instruction-risk.ts`; [security](docs/security.md)). Still open: send the scanner's hits to
  the injection follow-ups (model calls), once the next runs show what the candidates hold.
- **Wired:** the project's own test, typecheck, lint and build commands, read from its manifests at the start of a
  model Audit or Feature (`packages/runtime/src/project-commands.ts`), given to the planners and listed in the saved
  plan's `AGENTS.md`. On rokbot, 83 of the plan's 84 tasks verify with them.
- **Wired:** the saved plan's README says when the project's files changed after the audit, or a CLI updated itself
  while the run was paused (`environment-versions`).
- **Derived write envelope** (`packages/security/src/envelope.ts`, with its tests). It derives the write scope from the
  modules that hold the accepted issues' locations, never from the plan's proposed scope, so a plan written from
  untrusted text cannot widen an executing agent's scope (for example to `.github/workflows/`). Wire it into the
  saved plan with item 3 of the order below, plans carried out by other agents.
- **Native output schemas** for the paid-API bundle: per-dialect schema projections (OpenAI strict, Gemini, Anthropic
  tool) were built and deleted unused; they are at `7a68462:packages/schemas/src/projections/`.

**Replay with another configuration** (October 24): an Audit replay may now run the stages after discovery with
another configuration (verifier, critic, planner, efforts) and read an identical checkout elsewhere
([workflows](docs/workflows.md)). The verifier experiments below use it on the five real runs' discovery, so they
pay only for verification and planning.

**Experiments** ([design audit](docs/design-audit.md#what-changes), items 11 to 17): no peer review, lower efforts,
a second varied discovery pass, a cheaper verifier, a verifier of another vendor on a sample, an execution rung, a
static analyser. And score plans by executing them.

**Order of work**, set after an outside critique on October 22 (of its 17 points, 9 held and 4 partly; the README,
the run report and a [privacy](docs/privacy.md) page were changed for it the same day) and narrowed on October 24.
Measurements are for our own judgement of whether the product is good, not to prove anything to others: the
"evidence a skeptic can check" item and a public track of fixed bugs are dropped. Each item is measured as above:

1. **Prove it (item 16).** Built (October 22): the saved plan asks the executing agent to prove each defect with a
   test that fails on the unchanged code before fixing it, and to record each issue's result in the plan's
   `results.json` (fixed, not reproducible, no change needed, blocked; whether a test failed before the fix). The run
   report and the Evaluation tab read it back. arbitra running such a test itself in the Docker sandbox stays an idea
   for the execution rung (item 16), not a goal of its own: it needs a dependency step per ecosystem, since the
   snapshot holds no dependencies and the sandbox has no network.
2. **Cut only what really does not earn its place.** Reliability and finding what other orchestrators miss come
   first; value matters, but not at that cost. **Balanced** weighs value against perfection, so cheaper models may
   take a role where a measurement shows quality holds. **Deep** may gain value too, but every role stays on frontier
   models. Item 11, no peer review, is measured and is now the default of the
   subscription Audit template (October 23; the API-key templates keep one round, so the smoke checks still cover
   the review path). Each finished run was replayed with zero rounds on its own discovery
   (`replay <run> --max-rounds 0`):
   - blog, same build: 44 confirmed against 41 with review, 39 the same; after discovery 3.9M tokens against
     9.4M (the whole run about 7.6M against 13.1M). Review's one addition was a defect a reviewer raised, confirmed
     twice under two titles. The five only the replay confirmed were most likely lowered below the plan's minimum by
     review and never verified.
   - rokavatar (its run predates later fixes, so only indicative): 39 confirmed against 23, 21 the same, 2 added by
     review; after discovery 6.4M tokens against about 11.8M.
   - Without review no reviewer votes, so the second opinion before rejecting a severe issue never fired (7 severe
     rejections on blog). Every severe rejection now gets it when no review ran.

   A cheaper verifier (item 14) is measured and not adopted (see Cost and speed above). Still to measure: Gemini's
   share across the next real runs
   (above).
3. **Plans carried out on the real-run projects.** The five runs were on the owner's own projects, so their plans
   are carried out there, on a `dev` branch of each project (never `main`), starting with nextra's remaining issues
   (3 of 126 were fixed for 2.1.6). Count the issues fixed, not reproducible and blocked, what the fixes broke, and
   the work the plan's prompts did not cover (edits made by hand, questions only the owner could answer). First
   findings: 79 of nextra's 105 prompts cited validation ids (`VAL-003 tests exist and pass`) and 47 cited open
   questions (`section-…/Q-004`) that the folder never defined, since only the 5 blocking questions of 68 reached
   the README; each prompt now carries the checks and questions it cites, and `questions.md` lists the others with
   their defaults. Ten of its tasks (026, 033, 063, 071, 075, 079, 087, 091, 092, 093) cited VAL-145, VAL-146 or
   VAL-147, other tasks' assertions, in place of their own (renumbered into VAL-147 to VAL-163): a revision call's
   new assertions and tasks were renumbered but its prose kept the ids the model chose. Everything a patch writes
   now follows the renumbering, and a prompt marks a cited assertion that is not one of its task's checks; the plan
   already exported for nextra keeps the wrong ids in those ten prompts.

Next: the smaller items of this phase (the cheaper-verifier replay and test files packed with their source are
done, above), with nextra's `dev` branch alongside, since it touches only nextra. Then the UI phase, then P21.

**To re-check on the current build** (measured October 11 to 13, before later changes): prompts sized at one byte a
token outside the stages that set `estimatedBytesPerToken`; discovery source as one JSON object a line; Gemini's
output nearly all thinking and its CLI's own agent prompt; a pinned copy of each CLI per protocol, as for Claude Code.

## Vendor terms

Read October 22. **Google:** wrapping `agy` in another application "is not supported under consumer plans", and
third-party access "may be grounds for suspension" (FAQ and terms); New run, TESTERS.md and the privacy page say so,
and Google's route for tools is a Gemini API key. **Anthropic:** allowed as arbitra does it. Claude Code's
[legal page](https://code.claude.com/docs/en/legal-and-compliance) does not prevent "an end user from signing in to
the unmodified Claude Code binary with their own Claude subscription"; it forbids tools that collect or route
subscription credentials, which arbitra never does, and limits assume "ordinary, individual usage". **OpenAI:** no
statement found on driving `codex exec` from another tool; ChatGPT's terms govern the data.

## Deferred: the paid-API bundle

It needs funded API accounts, which the project's own testing does not use
([completion plan](docs/completion-plan.md#deferred-the-paid-api-bundle)): the OpenAI Responses, OpenAI Chat and
Anthropic Messages protocols live (P03); P08's live context limits; each P15 batch driver; and from the engineering
review, opaque reasoning state per message, native output schemas and explicit cache control.

## Live-testing policy

Subscription mode is a product feature for every user, on an equal footing with API keys and selectable per role.
The project's own live testing runs **only on subscription models**, through the vendors' CLIs, and never on API
credits:

| Vendor | CLI | Sign-in |
|---|---|---|
| Anthropic | Claude Code | Claude login |
| OpenAI | Codex CLI | ChatGPT login |
| Google | Antigravity CLI (`agy`) | Google AI subscription login |

Claude carries most roles. Codex and Antigravity take at most one secondary role each, because their limits are lower.

Google retired personal logins from the Gemini CLI on June 18, 2026, so the `gemini-cli` transport serves only Code
Assist Standard or Enterprise accounts. Never use third-party plugins that reuse Antigravity OAuth tokens; they get
accounts banned.

Live configurations come from `tooling/live/bindings.subscription.json`. The API-key transports remain for other
users: [bindings.claude-primary.json](tooling/live/bindings.claude-primary.json) is the API-key equivalent, and
[bindings.gemini.json](tooling/live/bindings.gemini.json) records the free-tier Gemini setup behind the earlier
evidence.

## How to pick this up again

1. **Logins.** Sign in once in a terminal: `claude` (/login), `codex login` (Sign in with ChatGPT) and `agy`. The API
   keys in the gitignored `.env` are not used for live testing.
2. **Build.** Run `pnpm build`.
3. **Web UI.** `arbitra.cmd` (Windows) or `arbitra.command` builds when needed and opens http://127.0.0.1:4178,
   served by the control plane. For UI work, `pnpm --filter @arbitra/web dev` on http://127.0.0.1:4173 proxies to it.
4. **Workflows (P03).**
   1. Generate the configurations: `node tooling/live/configure.mjs tooling/live/bindings.subscription.json .runs/live/configs-sub`.
   2. Run one: `tooling/live/run.sh .runs/live/configs-sub <audit-mixed-providers|feature-automatic|feature-interactive|testing-plan|testing-execute>`.
      A sleeping host stretches every stage timeout, so keep the machine awake during a run.
   3. An interactive Feature stops `BLOCKED`. Inspect it with `requirements <run-id>`, then `revise-requirements`
      and/or `approve-requirements`, then run `tooling/live/resume.sh feature-interactive <run-id>`.
   4. Hand a Feature plan to fresh Claude Code executors: `node tooling/live/handoff.mjs <work-name> <run-id>`.

   `testing-execute` needs Docker and the pinned image; see [qa/p04](docs/qa/p04/README.md).
5. **Native writer (P12).** Run in `packages/runtime`:

   ```bash
   ARBITRA_NATIVE_HARNESS_CONFORMANCE=1 ARBITRA_CLAUDE_CODE_EXECUTABLE=<absolute claude path> \
   ARBITRA_NATIVE_CONFORMANCE_MODEL=claude-sonnet-5 ARBITRA_NATIVE_CONFORMANCE_CREDENTIAL_KIND=subscription_login \
   npx vitest run test/native-harness.conformance.test.ts --silent=false
   ```

   See [qa/p12](docs/qa/p12/README.md).
6. **Premise evaluation (P06): complete.** Version 2.1.0's results are in
   [qa/p06-subscription](docs/qa/p06-subscription/README.md). Its run state is local only, in
   `.runs/p06-subscription-2.1.0` (2.0.0's in `.runs/p06-subscription`); keep both. For live runs, pace on the Claude
   five-hour window (`rate_limit_event` in any `claude -p --output-format stream-json --verbose` call).
7. **Usage windows.** Codex's are read without a model call through `codex app-server` (`account/rateLimits/read`).

Evidence per item is in [docs/qa](docs/qa/README.md); the subscription runs are in
[qa/p03-subscription](docs/qa/p03-subscription/README.md).
