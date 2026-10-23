# Remaining work

Updated October 23, 2026 (branch `main`, into which every branch was merged on October 22). Task status lives in the [completion plan](docs/completion-plan.md); this
file says what is left and in what order. The measurements and decisions behind every item, from the P20 pilot
(October 10 to 19), are in this file's history: `git show 9558aef:WORK-REMAINING.md`.

## State

- **P20 is closed on its pilot (owner, October 19).** No held-out runs. On the three pilot projects, wherever three
  Opus-only runs together missed a planted defect, the premium panel found it, using 0.57 to 0.67 times their time
  and 0.69 to 0.76 times their tokens. That is 21 planted defects: an estimate, not a test. Per-defect results stay
  in the private benchmark repository. The held-out set stays unrun on purpose (owner, October 22: "there was no
  reason to run them"); the product's claims rest on what each run checks and proves, not on the premise.
- **Checkpoint 2 (October 22):** `beta`, `friend-test` and `packaging` (the v0.2.0 installers) merged into `main` and
  deleted; work goes on from `main`. Next is the improvement phase below: the changes held back until now because
  they could destabilise the app.
- **The order of work (owner, October 19):**
  1. **Checkpoint 1:** the app working properly. Every defect in the way fixed, all work merged, stale docs and
     files cleaned up, then the whole check, the browser tests, live runs on the three subscriptions and arbitra
     auditing its own recent changes from the web UI; merged to `main` and tagged `checkpoint-1`.
  2. **UI phase**, on its own branch: research how people want run results and settings shown, audit the current
     UI, and agree a direction from mockups before code changes. The owner finds the UI wordy, full of similar
     terms and choices it does not explain, and silent about how models are gathered and which are chosen; the
     original drag-and-drop "slots" idea is to be audited, not assumed.
  3. **Improvement phase**, on its own branch: the items below that change what the pipeline does, each measured.
  4. **P21**, the completion report, last.
- **Checkpoint 1 is out** (October 20): `main` and the tag `checkpoint-1` at e8ef14b.
- **First, a hand-off to testers (owner, October 20), on branch `friend-test`,** ahead of the UI phase because the
  owner's weekly usage is low and friends will test it on their projects: one file starts arbitra
  (`arbitra.cmd`, `arbitra.command`; Node.js 22.13 or newer required, pnpm installed into the folder, install and build when out of date, the web app
  served by the control plane itself); the CLIs a machine has are found, the first supported installation of each is
  used, and the New run page shows them with fixes and recommended models; graph nodes and "executed by" name the
  model and effort; each run has a plain-text report to copy and send (`/diagnostics/runs/:id`); the Plan tab saves
  the plan into the project as prompts grouped by model tier (`.arbitra/plans/`); each model is chosen from a list
  rather than typed; New run opens on three auditors on the subscription CLIs with the settings of the benchmark's
  premium panel (Gemini at high thinking, or Argon when the CLI offers it), and a browse button opens the system's
  folder dialog. [`TESTERS.md`](TESTERS.md) is the testers' guide.
- **The first real-project run (October 20): beachflag**, 84 files and 11,291 lines, from the downloaded zip at
  145ed4c with the benchmark's settings (Gemini critic, every issue verified): 80 minutes, 613 calls, 17.6M tokens
  (verification 10.6M of them: 132 questions in 341 calls plus 54 place re-asks in 180), one Gemini audit call at
  its output ceiling. 210 findings became 81 accepted issues (3 high, 25 medium, 52 low), 40 rejected and 11 open;
  the plan has 24 tasks for the 28 issues of medium and up, and 5 blocking questions only the owner can answer.
  It led to: Sol as critic and Opus as critique checker, verification only of the issues the plan covers (58% of
  the candidates were below it), the token limit sized from the project (3,500 tokens a line, about twice the
  measured 1,560), raising the limit of a paused run, leaving files Git ignores out of the snapshot (a 600 KB
  Playwright report refused the project), and opening model-activity artifacts (their IDs were too long a route).
- **The rokavatar run (October 21, owner: "start it now and fix issues as we go"):** `run-757824f4`, 117 files and
  10,716 lines, from a fresh zip of 2a819bf with the new defaults (Sol critic, Opus critique checker, verification
  of planned issues only). Claude's week went from 86% to 91% by the critic. At 18:32, after 474 calls and about
  15M tokens (verification 6.7M in 356 calls for 78 questions; peer review 4.2M; Gemini 2.1M in 51 calls, 12 of
  them refused by its content filter and 5 stopped at its output ceiling, 560 call-minutes), Sol hit the Codex
  five-hour window at the critic and the run failed; resumed at 21:35, it completed at 21:43: 480 calls, 15.6M tokens (1,455 a line; beachflag 1,560) and about 110 minutes of work (beachflag 80, 613 calls, 17.6M), a plan of 21 tasks for 23 issues with 2 blocking questions. Saved with the new export, it carries 14 check-first prompts and 48 also-found issues. 212 candidates: 71 accepted,
  46 rejected, 95 unresolved (81 low or informational, skipped by design; 14 medium or high the verifier could not
  settle). Fixed on `friend-test` because of it: a usage limit pauses the run and resumes it after the reset
  (b3626a8); "last activity" and the report's state during a stage (c3ca222); and, the owner's choice after the
  findings were laid out, the safeguards against losing issues (6274c9e, 4368435): check-first prompts for issues
  the verifier could not settle, a severity lowered by one reviewer alone no longer takes an issue out of the plan's
  scope (25 such issues here, 22 lowered by Opus), a second model before a critical or high issue a reviewer backed
  is rejected (12 here), and the accepted issues no task fixes listed in the saved plan (48 here). Together these
  add about 37 questions to a run like this one, about 3M tokens.
- **Then a public release (owner, October 21):** v0.1.0 on GitHub with a zip attached, after the rokavatar run is
  done and its fixes are checked on Linux.
- **Open from the rokavatar run:** Gemini's audit took 560 call-minutes and 2.1M tokens with 17 of 51 calls lost to
  its filter or output ceiling; verification still costs about 86K tokens a question (beachflag 80K). Later runs are
  on the owner's other projects, for real-world data.
- **An outside critique, checked against the code (October 22).** Of 17 points, 9 held, 4 partly, 2 were already
  fixed and 2 described an older arbitra. Acted on the same day, on `friend-test`:
  - Each run's report and Evaluation tab lead with what it confirmed against the source, tokens per confirmed issue,
    and what each model found that no other did (ef98804). On rokavatar: 23 of 212 confirmed (3 high, 20 medium),
    677K tokens each; found alone by Opus 12, Sol 2, Gemini 0, though Gemini's audit took 2.1M tokens and its peer
    review 1.9M. The 48 "accepted" low issues were accepted by the vote and never checked; the README now claims
    checking only for the issues the plan acts on.
  - The README leads with checking and replay, not "Just another…", and gives the measurements with their caveats,
    including that the P20 pilot projects were hardened until Opus missed defects. A one-page
    [privacy](docs/privacy.md) answer: what is sent, to whom, how to send less.
  - Google's terms, settled as far as reading goes: wrapping `agy` in another application "is not supported under
    consumer plans", and third-party access "may be grounds for suspension" (FAQ and terms, read October 22). New
    run, TESTERS.md and the privacy page say so; Google's route for tools is a Gemini API key (fcef7ee). The owner
    keeps Antigravity in the lineup: "we only use gemini for testing, if it dies, it dies".
  - The blog test run found that the snapshot read a fixed list of extensions and left out all 30 `.astro`
    files; Astro, shell, C-family and other common sources are now read (fcef7ee).
- **The blog run (October 22):** `run-7fb6177a`, an Astro blog with a CMS, 164 files and 14,204 lines, from a
  fresh zip of fcef7ee, Gemini at medium (owner). 63 minutes, 359 calls, 13.1M tokens (922 a line; rokavatar 1,455,
  beachflag 1,560). 41 of 180 candidates confirmed (3 high, 38 medium), 320K tokens per confirmed issue; found alone by
  Opus 16, Sol 7, Gemini 2. Peer review 4.0M tokens and verification 3.9M (219 calls). Gemini at medium took 135
  call-minutes (560 at high on rokavatar), and 9 of its 47 calls were refused by its content filter. The plan has 33
  tasks for 41 issues and 31 open questions, 1 blocking: questions are still not merged across sections. Its replay
  without peer review (experiment 11) is `run-d6fbbf98`.
- **The commentanywhere run (October 23), the first real run without peer review:** `run-5a90c75d`, an embeddable
  comments service (Fastify, Postgres, Preact widget, React dashboard), `main` at 648363c, 93 files and 11,719 lines
  (beachflag's size), Gemini at medium. 40 minutes, 234 calls, 7.5M tokens (640 a line; blog 922, rokavatar
  1,455, beachflag 1,560). 51 of 150 candidates confirmed (1 critical, 7 high, 43 medium), 14 rejected, 6 the source
  could not settle, 79 below the plan's minimum and not checked; 146K tokens per confirmed issue (blog 320K,
  rokavatar 677K). Found alone by Opus 20, Sol 8, Gemini 2. Verification 3.6M tokens in 176 calls; discovery 2.5M,
  Gemini's 1.1M of it, with 6 of its 21 calls refused by its content filter. Claude's five-hour meter went 21% to 32%
  (about 6M of the run's tokens were Claude's), the week 89% to 91%. The plan has 40 tasks for the 51 issues and 29
  open questions, 3 blocking; one question names two issues as the same defect (the worker's row lock across the
  provider call, found by Opus and by Gemini under two titles). Questions are still not merged across sections.
  - **First attempt failed, fixed (57ee601):** `run-1dad8491` on the stale `codex-implementation` branch failed after
    18 minutes when Gemini asked for a ninth tool turn on one discovery window: nothing told it the tools were spent,
    and the loop limit failed the run. A tool call past the limit is now answered unrun with
    `TOOL_TURN_LIMIT_REACHED` and the model gets one more turn; a model that still asks is a rejected reply, so the
    stage records the gap. On that branch Gemini's filter refused 20 of its 55 calls. The checkout was switched to
    `main` during the run, so it could not be resumed (`RUN_REPOSITORY_CHANGED`) and was started again on `main`.
  - **Fixed after it:** with no review round, every candidate's consensus reason said review rounds were exhausted;
    it now says no peer-review round ran. Still open: the issue board labels those candidates "no consensus" in a
    run that had no review.
  - **Dependabot (October 23):** fastify 5.12.5 (low, header validation) has no patched release yet (5.12.6 is not
    published); the vitest advisory (moderate, its mocker, test tooling only) is fixed only in vitest 5, a major
    upgrade. Both left for now.
- **The nextra run (October 23), the largest real project so far:** `run-ccd3ccea`, low-latency screen sharing
  (Express, Socket.IO, mediasoup, React), `main` at ef694bf, 172 files and 38,967 lines (3.3 times commentanywhere;
  13,487 of them tests), from a fresh archive of 69d4291, Gemini at medium. 105 minutes, 683 calls, 26.8M tokens (688
  a line; commentanywhere 640, blog 922). 126 of 415 candidates confirmed (1 critical, 21 high, 104 medium), 46
  rejected, 20 the source could not settle, 223 below the plan's minimum and not checked; 213K tokens per confirmed
  issue (commentanywhere 146K). Found alone by Opus 40, Sol 30, Gemini 3 (Gemini: 16 of 61 confirmed for 2.0M tokens,
  2 of 39 calls refused by its filter). Verification 14.4M tokens in 497 calls for 192 questions, 75K each; discovery
  7.6M. Wall time: discovery 53 minutes, with Opus the long pole (Gemini done after 25, Sol after 29), clustering 6,
  verification 19, plan 17, critic and its check 4, revision 5. Claude's five-hour meter went 32% to 68%, the week 91%
  to 97%. The plan has 105 tasks for the 126 issues and 68 open questions, 5 blocking; two of those, in different
  sections, ask about the same OBS test stream.
  - **Against the handbook's known defects:** both of its access-control concerns were found and confirmed, one as
    the critical issue (details stay in the run's record until nextra is fixed). Not found: the client never sends the
    operator token a remote host needs, a missing piece across client and server rather than a defect in one place.
    A claim about OBS ingest over plain HTTP was rejected, rightly as a security claim; that is the handbook's point
    from the other side, that a remote host cannot start an OBS room. The "peer-to-peer" copy is only in
    `public/manifest.webmanifest`, which the snapshot does not read.
  - **Fixed after it:** every one of Sol's 92 findings opened its `problem` with the `<quotes>` block the prompt asks
    for before reasoning (33 of 33 on commentanywhere), 44% of that text, repeating its evidence in each claim,
    verification question and plan issue. Discovery now drops a leading block from a finding's prose and records which
    findings had one (`quoteBlocksRemoved`).
  - **Also fixed after it (owner: "i still get these"):** every completed model run on a real project failed the
    gate, and the web app showed "gate failed" in red. Here: 20 issues the verifier could not settle, 5 blocking plan
    questions, and coverage marked incomplete for three causes: a source-only audit always is, 11 places an auditor
    did not examine, and, without peer review, all 415 candidates listing their other auditors as missing reviewers.
    With no review round nobody is now counted missing. The web app reads such a run as "done · needs you", lists the
    work with counts (issues to check by hand, questions only the owner can answer) and what the run could not see,
    keeps every code, and says the CLI still exits 1; any other reason still reads "gate failed". The CLI gate is
    unchanged.
  - **Data for open items:** 13 confirmed issues cite only test files, 6 of them claims about production code, and at
    least 2 of those repeat a confirmed issue that cites the source (the forwarded client IP; the OBS test stream). The
    verifier's rejections carry no reason, only outcome, evidence and confidence, so checking one means reading its
    tool trace.
- **Small fixes from the self-audit, on `friend-test` (October 20):** a system "permission denied" on Antigravity's
  stderr no longer discards its reply as a soft-denied tool; a spawn that runs out of file descriptors no longer
  raises an unhandled error; workspace packages take the root's package manager for their test commands, and a
  package.json that does not parse no longer stops the catalog; the issue board says when its other records are
  still loading or failed, and when the run's coverage is incomplete; the critic's requirement counts only the
  planned issues, and its call count every call made; the verification counts say what they count.

## Checkpoint 1

Fixed on October 19, each with a test:

- The run page was blank for every model run with a coverage gap (e3519fc); recorded limitations are folded under
  one line (c171b01).
- A plan written in sections cited other sections' tasks and checks in its text (d3f2d4f).
- One operation of the wrong shape refused a whole peer-review reply (c6f2c3c).
- Discovery told models that files outside their unit do not exist; empty searches counted as tool errors (41275b8).
- Discovery refused quotations copied with the frame's entities for `<`, `>` and `&` (39c2d03).
- Secret masking hid ordinary code such as `token: this.ids.leaseToken()` (812fed6, redaction patterns version 4).
- Every continued Antigravity tool turn failed: the CLI's resume notice was read as tool use (3bbdbe9).
- The plan critic's coverage: the cited files no critic call carried are recorded (377546c).
- On Windows, a CLI's descendant holding its pipes kept a call open until its timeout (2d19b2f).
- A Feature or Testing stage's output repair was not resized like its first attempt (eb8238e).
- A copied or restored run showed the copy's date as its start (9558aef).
- Windows line endings stayed inside each snapshot line, so every Feature and Testing run on a Git for Windows
  checkout failed to ground its evidence (3541978; found by the live runs).
- The details panel lost its trail across selections inside the new error boundary (b815f15); a running graph run
  read "starting" for its whole run (565cea2).
- From the self-audit: secrets under prefixed names (`DB_PASSWORD`, `AWS_SECRET_ACCESS_KEY`), passphrases filed under
  a secret's name and private keys split across lines were not masked (e16a103); the Windows descendant scan could
  match an unrelated process by a reused ID and blocked the event loop (c9c99ae); Git read the audited repository
  with that repository's own configuration, which can name programs to run (570e436).

**The self-audit (October 19, from the web UI).** The premium panel on the 25 files changed since 9ef97b8 (5,254
lines): 63 minutes, 212 reports, 78 issues confirmed, 28 rejected, 39 undecided. Fixed above: 7. Still open,
confirmed, for the improvement phase (most predate this week's changes; the audit read whole changed files):

- Redaction: bracket index access after a secret's name is masked as a secret; JSON-encoded source loses escaped
  newlines after redaction; redacting model input and output can make an exact quote impossible to ground.
- Processes: POSIX descendants that start their own group escape termination; on Windows a descendant that holds no
  pipe outlives a normal exit, and `treeTerminated` is assumed; leftover trees are checked only on success.
- CLI transports: identical request prefixes can resume the wrong conversation; three dialects do not enforce the
  output ceiling.
- Pipeline: peer conflict resolution fails the run on one invalid or output-limited reply; grouped verification
  never re-asks a rejected merged candidate place by place, can exceed its question limit, and shows finder-named
  IDs to the verifier; merge recovery stops after one rescued defect; with `recheckRevisedPlan`, a second critic
  that does not complete replaces the first one's blocking items; critic revisions bypass the blocking-question checkpoint;
  one malformed evidence operation can leave dangling or remove valid citations; moving a shared location can
  invalidate evidence grounded at its old range.
- Discovery: dense instruction-shaped text merges into one oversized follow-up that is skipped; recursive scope
  splitting multiplies concurrency and has no depth or spend bound; quote widening is quadratic on repetitive files.
- Repository and Testing: diff paths are taken relative to the audited root, not the repository top level; the
  `working_tree` diff leaves out untracked files; excluded directories are still walked.
- Smaller: a failed partial event append poisons later records; plan write-scope overlap understands only a trailing
  `/**`. (The search tool's one hit per line is deliberate, as grep reports it.) 36 low-severity issues and the 39
  undecided are in the run's record.

Still to do for the checkpoint:

- **Branches (the owner's):** the tag `p20-build-13be324` is pushed (the private benchmark cites that commit); the
  dependabot branch is gone; `p20-2.7.0-fix` and `agent/elegant-sagan-3tby00` (already in `beta`) are to be deleted.
- Done on October 19: the whole check in Linux; the browser tests in Linux, 69 of 69 in Chromium, Firefox and WebKit
  (on Windows WebKit does not move Tab between links, so one keyboard test cannot pass there); live runs on the three
  subscriptions (Audit, Feature, Testing plan) after the line-ending fix; the self-audit. Then: merge to `main`, tag
  `checkpoint-1`, push.

## Improvement phase

Each changes what the pipeline does or costs, so each is measured before it becomes a default (the owner's targets:
a panel within about 1.5 times the time and 1.7 times the tokens of three Opus-only runs, quality kept; design
changes checked against Anthropic's guidance first).

**Quality**

- **Test files are audited apart from the code they test.** Units are packed by top folder, so `test/` gets units
  of its own (3 of 8 Opus units a run, about 250K tokens): 6 to 14 accepted issues a run are claims about production
  code that cite only test lines, which clustering cannot join to a report citing the source. Pack a test file with
  the source it imports.
- **Stages are not told the rest of the repository exists.** A partial prompt should say it is part of a larger
  repository and list its file index; plan sections and the critic have the source tools and used none in six runs;
  package manifests are recorded by name and never given, so plans guess the test command.
- **Duplicates survive:** pairs from different discovery units with the same failure mechanism are never compared,
  nor are candidates added during peer review with existing ones (2 of 5 and 2 of 7 additions in two panels).
- **An abstention says nothing about why.** "Cannot tell" and "rejected" should carry one sentence of what the
  source cannot show, shown in the handoff.
- **Plan questions are not merged across sections** (one question asked in three sections); merge them and drop the
  ones the repository answers.
- **The critic works almost without source:** at the Antigravity CLI's prompt limit it left out 153 to 278 cited
  files, and most of its remarks did not hold against the source. Batch it by task with the files it cites (now
  recorded in `critic-result.citedSourceLeftOut`).

**Cost and speed**

- **Verification is most of a run's tokens** (three quarters of an Opus-only run; low and informational questions
  alone 29 to 35%, though those issues get no task). A cheaper verifier for low severity (design audit item 14).
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

**Experiments** ([design audit](docs/design-audit.md#what-changes), items 11 to 17): no peer review, lower efforts,
a second varied discovery pass, a cheaper verifier, a verifier of another vendor on a sample, an execution rung, a
static analyser. And score plans by executing them.

**Order after the October 22 critique** (each measured as above):

1. **Prove it (item 16).** First part built (October 22): the saved plan asks the executing agent to prove each
   defect with a test that fails on the unchanged code before fixing it, and to record each issue's result in the
   plan's `results.json` (fixed, not reproducible, no change needed, blocked; whether a test failed before the fix).
   The run report and the Evaluation tab read it back: issues proven by a failing test, and fixed. This proves defects
   in the user's own environment, with any agent (Claude Code, Codex, Gemini), and scores the plan by executing it.
   Still open: arbitra running such a test itself before the plan, in the Docker sandbox. The snapshot holds no
   dependencies and the sandbox has no network, so it needs a dependency step per ecosystem first. A test that
   cannot be written leaves the issue confirmed, never rejected (agents write one for only 16–37% of real bugs).
2. **Cut what does not earn its place.** Item 11, no peer review, is measured and now the default of the
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
   Still to measure: a cheaper verifier (item 14). Gemini's part: across the next real runs, compare its confirmed
   finds no other model made with what its audit costs (blog at medium: 2 alone for 1.9M tokens; rokavatar's
   replay: 7 alone; commentanywhere at medium: 2 alone for 1.1M tokens, 6 of 21 calls refused by its filter; nextra at
   medium: 3 alone for 2.0M tokens, 2 of 39 refused).
3. **Plans carried out by Codex and Gemini as well as Claude:** count issues fixed, things broken and edits a person
   had to make.
4. **Evidence a skeptic can check:** each real run's report (confirmed, proven by a failing test, fixed, cost), and
   perhaps a small public track of real fixed bugs (reverted fixes from public projects). P20's held-out set stays
   unrun (owner, October 22).

**To re-check on the current build** (measured October 11 to 13, before later changes): prompts sized at one byte a
token outside the stages that set `estimatedBytesPerToken`; discovery source as one JSON object a line; Gemini's
output nearly all thinking and its CLI's own agent prompt; a pinned copy of each CLI per protocol, as for Claude Code.

**Product, vendor terms (read October 22):** Google: Antigravity on a consumer plan is not supported inside arbitra
(above). Anthropic: allowed as arbitra does it. Claude Code's
[legal page](https://code.claude.com/docs/en/legal-and-compliance) does not prevent "an end user from signing in to
the unmodified Claude Code binary with their own Claude subscription"; it forbids tools that collect or route
subscription credentials, which arbitra never does, and limits assume "ordinary, individual usage". OpenAI: no
statement found on driving `codex exec` from another tool; ChatGPT's terms govern the data.

## Deferred: the paid-API bundle

It needs funded API accounts, which the owner does not use ([completion plan](docs/completion-plan.md#deferred-the-paid-api-bundle)):
the OpenAI Responses, OpenAI Chat and Anthropic Messages protocols live (P03); P08's live context limits; each P15
batch driver; and from the engineering review, opaque reasoning state per message, native output schemas and
explicit cache control.

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
3. **Web UI.** `arbitra.cmd` (Windows) or `arbitra.command` builds when needed and opens http://127.0.0.1:4178, served by the control plane. For UI work, `pnpm --filter @arbitra/web dev` on http://127.0.0.1:4173 proxies to it.
4. **Workflows (P03).**
   1. Generate the configurations: `node tooling/live/configure.mjs tooling/live/bindings.subscription.json .runs/live/configs-sub`.
   2. Run one: `tooling/live/run.sh .runs/live/configs-sub <audit-mixed-providers|feature-automatic|feature-interactive|testing-plan|testing-execute>`. A sleeping host stretches every stage timeout, so keep the machine awake during a run.
   3. An interactive Feature stops `BLOCKED`. Inspect it with `requirements <run-id>`, then `revise-requirements` and/or `approve-requirements`, then run `tooling/live/resume.sh feature-interactive <run-id>`.
   4. Hand a Feature plan to fresh Claude Code executors: `node tooling/live/handoff.mjs <work-name> <run-id>`.

   `testing-execute` needs Docker and the pinned image; see [qa/p04](docs/qa/p04/README.md).
5. **Native writer (P12).** Run in `packages/runtime`:

   ```bash
   ARBITRA_NATIVE_HARNESS_CONFORMANCE=1 ARBITRA_CLAUDE_CODE_EXECUTABLE=<absolute claude path> \
   ARBITRA_NATIVE_CONFORMANCE_MODEL=claude-sonnet-5 ARBITRA_NATIVE_CONFORMANCE_CREDENTIAL_KIND=subscription_login \
   npx vitest run test/native-harness.conformance.test.ts --silent=false
   ```

   See [qa/p12](docs/qa/p12/README.md).
6. **Premise evaluation (P06): complete.** Version 2.1.0's results are in [qa/p06-subscription](docs/qa/p06-subscription/README.md). Its run state is local only, in `.runs/p06-subscription-2.1.0` (2.0.0's in `.runs/p06-subscription`); keep both. For live runs, pace on the Claude five-hour window (`rate_limit_event` in any `claude -p --output-format stream-json --verbose` call); the owner can reset the weekly limit when needed.
7. **Usage windows.** Codex's are read without a model call through `codex app-server` (`account/rateLimits/read`).

Evidence per item is in [docs/qa](docs/qa/README.md); the subscription runs are in [qa/p03-subscription](docs/qa/p03-subscription/README.md).
