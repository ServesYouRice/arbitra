# Real-project runs

Audits of the owner's own projects on the current build, from October 20, 2026, and what came of carrying out their
plans. These are the product's working evidence: the [completion plan](../completion-plan.md) covers P01 to P20, and
[remaining work](../../WORK-REMAINING.md) says what is still open. Earlier measurements are in that file's history:
the P20 pilot in `git show e917ec7:WORK-REMAINING.md`, the first narratives of these runs in
`git show 7a68462:WORK-REMAINING.md`.

## The runs

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

Verification costs 75K to 86K tokens a question. Gemini's confirmed finds that no other model made, against what its
audit cost: rokavatar 0 for 2.1M tokens at high thinking (560 call-minutes; 17 of 51 calls lost, 12 to its content
filter and 5 to its output ceiling), 7 in that run's replay; blog 2 for 1.9M at medium (135 call-minutes; 9 of 47
calls refused); commentanywhere 2 for 1.1M (6 of 21 refused); nextra 3 for 2.0M (2 of 39 refused). Gemini has been
opt-in since v0.2.1, so its share is measured only on a run that uses it.

## Peer review measured (October 23)

Item 11 of the design audit, no peer review, is measured and is now the default of the
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

## A cheaper verifier measured (October 24)

Verification is about half a run's tokens (nextra 14.4M of 26.8M, 192 questions). Issues below the plan's severity
bar are no longer verified by default (`belowPlanScope: "skip"`; before that, low and informational questions were 29
to 35% of a run). A cheaper verifier (design audit item 14) was measured by replaying nextra's run with Sonnet 5.5
verifying every question (`run-98e2ee7a`, in the experiments folder):

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
  - **Scored against the carried-out plan** (nextra's `.arbitra/dev-notes/verifier-comparison.md`): 15 of the 22
    differing verdicts have a known truth; the other 7 were Opus rejections that never reached the plan.
    - **Opus:** right on all 6 of its definite calls, all real defects proven by a failing test, which Sonnet left
      unsettled. It left the other 9 unsettled.
    - **Sonnet:** right on 6 of its 9 definite calls, all medium. It was wrong on both highs it decided (it
      confirmed check 05 and rejected check 07) and confirmed check 18, a medium that did not hold.
    - **Confidence:** it does not separate Sonnet's right calls from its wrong ones (0.70 to 0.86 for either).
    - **Where Opus left a medium unsettled:** Sonnet decided 6 of 7 rightly.
    - **One Sonnet question ran to the 128K-token output limit** (C-5a27b05f4697) and was recorded as unanswered.
      A verifier answer that long means something looped; cap or stop it far earlier.
  - **So far:** a cheaper primary verifier is not worth it, since it misses real defects Opus confirms; the default
    keeps Opus. Worth one measured try in balanced audits: a Sonnet second look at medium reports Opus leaves
    unsettled (about 28K tokens a question, against about 122K for an agent to decide a check), off until the next
    real run shows it holds beyond these 7 cases. High and critical stay with frontier verifiers, as in deep audits.

## Test files packed with their source (October 24)

Units were packed in path order, so `tests/` filled units of its own: 6 to 14 accepted issues a run were claims about
production code that cited only test lines, which clustering cannot join to a report citing the source. Now each test
file goes into the unit of the file it imports whose name it carries (else the last file it imports), Python imports
are resolved for this, and an oversized module splits between a file and its tests rather than inside. Measured on
the six real-run projects at a 60 KB unit: test files packed with the source their name points at went from 37 of 119
to 82 (nextra 0 to 31 of 48), test-only units from 23 to 10, and units from 99 to 108 (9% more discovery calls).

## Plans carried out

The runs were on the owner's own projects, so their plans are carried out there, on a `dev` branch of each project
(never `main`), counting the issues fixed, not reproducible and blocked, what the fixes broke, and the work the plan's
prompts did not cover (edits made by hand, questions only the owner could answer). First findings, before nextra's
plan was carried out: 79 of nextra's 105 prompts cited validation ids (`VAL-003 tests exist and pass`) and 47 cited open
questions (`section-…/Q-004`) that the folder never defined, since only the 5 blocking questions of 68 reached
the README; each prompt now carries the checks and questions it cites, and `questions.md` lists the others with
their defaults. Ten of its tasks (026, 033, 063, 071, 075, 079, 087, 091, 092, 093) cited VAL-145, VAL-146 or
VAL-147, other tasks' assertions, in place of their own (renumbered into VAL-147 to VAL-163): a revision call's
new assertions and tasks were renumbered but its prose kept the ids the model chose. Everything a patch writes
now follows the renumbering, and a prompt marks a cited assertion that is not one of its task's checks; the plan
already exported for nextra keeps the wrong ids in those ten prompts.

### nextra, October 24

Carried out on nextra's `dev` branch (pushed October 24). One agent per item on the model its tier names (Haiku 19 tasks, Sonnet 70, Opus 15 tasks and the 20
checks), up to 17 at once in git worktrees, each reviewed and merged by the driving session. Records are in
nextra's `.arbitra/dev-notes/` (`log.md`, `followups.md`, `results/`).
- **All 146 issues have a result:** 130 fixed, 1 fixed by another task, 15 no change needed (13 unsure claims
  that did not hold, check 07, and TASK-027, which check 17 had fixed). 124 are recorded as proven by a test that
  failed on the unchanged code (checked October 25, below). Unit tests went from 421 to 1,510, all passing, and the
  browser suite passes 126 (13 desktop-only tests skip on the phone project).
- **Cost:** about 16.4M tokens and 1,495 agent-minutes for the 124 items. A Haiku item took 3 minutes and 71K
  tokens on average, a Sonnet one 10 and 128K, an Opus task 29 and 254K, a check 15 and 122K. The follow-ups
  below took about 2M more.
- **Reviewer corrections: 3 of 124.** A Haiku agent skipped the browser check its prompt asked for, because the
  prompt said "ask before running". An agent stopped as blocked because an existing test pinned the defect: the
  brief now says to change such a test as little as keeps its intent and cite it, which 12 later items did. One
  agent's throwaway worktree deleted the shared `node_modules`; the brief now forbids extra worktrees. Running
  items in parallel cost the driver about a dozen merge fixes (tests written before a shared helper existed, hand
  merges of a shared spec), none an agent's error.
- **What the prompts got wrong** (the agents worked around each and said so):
  - **Line numbers and quoted code:** stale in most prompts, since earlier items had changed the code.
  - **Read-first lists:** five named files the task itself creates.
  - **"Ask before running":** 75 of 125 prompts' verify lines say it, against the plan's own "prove first".
  - **A wrong file:** check 19 pointed at `fmp4RelayPlayer.js`; the defect was in WatchView's relay player.
  - **Five wrong premises:** a restore endpoint that did not exist, a ref cleared after `stop()` and not before, a
    reconnect that would retry, a tunnel origin that cannot reach WebRTC, a refused `SetVideoSettings` that only
    warns.
  - **Blocking question 1:** its recommended option, answering with the consumer's payload types, was taken, and
    it cannot work. Under RFC 3264 a recvonly offer names the payload types its offerer expects to receive. The
    browser check the owner asked for showed playback failed either way. The fix needed a router per payload-type
    layout.
- **The order serialised more than it had to:** 36 of 125 prompts wait for another task only because both edit
  a file ("Ordered by arbitra, not a functional dependency"). Run in parallel, each merged cleanly or with one
  append conflict.
- **Defects the plan did not cover, found while carrying it out, each fixed with a failing test first:**
  - **WHEP:** a browser-hosted room could not be watched over WHEP in Chromium or Firefox, in 2.1.6 too.
  - **Host reclaim:** reclaim requests went out after the host left, on two paths.
  - **OBS:** a failed setup's rollback restarted a stream OBS was only retrying; the host page missed a WHIP
    DELETE; the encoder settings file was never really restored.
  - **Layout:** a 320 px overflow, and a clipped Resolution toggle.
  - **Port search:** it ran past 65535.
  - **Host stop:** a stop sent while the host was offline was ignored, so viewers waited the 30 s window.
  - **Late relay viewers:**
    - the catch-up buffer counted with live chunks against the queue's 24 MB, and an MP4 catch-up left its init
      segment out of the ceiling;
    - the 16 MB slow-viewer cap counted a catch-up still on its way, so on a slow link a late viewer was dropped;
    - live chunks that arrived before `get-media-init` answered were thrown away.
  - **Viewer page:** a transport recovery dropped the relay without asking for it again, and attempts in flight
    could restart playback during Leave Room's 5 s wait.
  - **Not real:** 4 of the 18 suspected defects the agents reported while working did not hold: three browser
    tests failing on an old build, a chunk-count overflow and two of five viewer-page gaps.

- **Built from it (October 24),** checked by re-exporting nextra's run with the new exporter:
  - **Order:** a wait only for a shared file shows as "same files as" in the README and under
    `shares_files_with` in the prompt, not as work to finish first (35 of nextra's 36; the 36th note had gained a
    revision's instruction, so it stays an order). Tasks with no "after" can run side by side.
  - **Prompts:** say that what they state about the code (lines, quoted code, behaviour) is a claim to check, to
    find code by name and follow the code where it differs. The planner is told to name code by symbol and file,
    to state an issue's premise as a claim, and to recommend a question's answer only when the source, a cited
    standard or a test shows it works (`PLAN_TEXT_RULE`).
  - **Commands:** "run them yourself"; ask first only for one that installs software, deletes data outside the
    build output or reaches the network. No prompt says "ask before running" now (75 of 125 did).
  - **Read first:** a listed file the repository lacks moves to `new_files` (27 of nextra's prompts).
  - **`AGENTS.md`** and each prompt: run the checks; an existing test that pins the defect is changed as little
    as keeps its intent and named; a fix that crosses a boundary (browser and server, processes, what a person
    sees) gets an end-to-end check.
  - **`results.json`:** `checkedEndToEnd` per issue and `foundWhileFixing` for defects no issue named; the run
    report and the Evaluation tab read both back.
  - **Overlaps:** each prompt lists up to three reports elsewhere in the plan that read like its issue
    (`related_reports`, TF-IDF cosine of title and description at 0.35). On nextra: 24 prompts, 16 pairs; it
    finds 4 of the 5 overlaps the agents met (all but TASK-048's half covered by TASK-043, at 0.30), and the
    other pairs are related work in the same code. Location overlap did worse (2 of 5, with 48 pairs).
- **Premise check (October 25),** no model: the export looks up what each prompt names (paths, symbols, routes and
  socket events, quoted code, cited lines) in the project's code, marks what it cannot find under `<not_found>` and
  counts it in the README; `check-premises.mjs` in the folder looks again before each task and prints what moved, what
  is gone and what was never found (`packages/runtime/src/premise-check.ts`). Re-exporting nextra's run: of 2,132
  things the prompts state about the code, 2,116 were found and 16 were not, in 11 prompts. The restore endpoint is one
  (TASK-083); 8 are library, platform or H.264 field names outside the project, 4 example values, 2 names a context
  line gives as if they existed, 1 a described command. Names a task's steps add are not counted. At the audited
  commit no quote sat at other lines; run against nextra's `dev` history at the parent of each of 106 fix commits, 88
  prompts had something moved, 51 had quoted or cited lines moved (201 of them) and 7 had something gone. Not caught,
  as expected: check 19's wrong file (it exists) and the four behavioural premises.

### Unsure reports

7 of nextra's 20 unsure reports held, and no confirmed issue was a false alarm. The executing agents decided all 20
from the code and a test. 13 did not hold. 7 did: 5 fixed with a failing test first, 1 already removed by a task, and
check 07, real when audited and fixed for 2.1.6. The severe ones were mostly the false alarms: 2 of 10 high or
critical held (both security: a viewer could connect the host's transport, and the OBS gate let tunnelled sockets
through), and 5 of 10 medium. Deciding them took about 2.4M tokens (Opus, 122K each), about what a second look would
cost. No confirmed issue turned out unreal (the proofs are checked below). Decided: the second look at unsure reports
before the plan stays an option, off by default in both modes, since carrying out the check costs the same and proves
the answer; the plan's README gives this rate.

### The proofs, checked (October 25)

Each of the 124 proofs was classed by hand from nextra's `results.json`, dev-notes and `dev` history, with no model
calls.
- **115 failed on the defect's behaviour:** 106 on an assertion (17 of them in the browser), 4 on the defect's own
  exception and 5 on a bounded wait where the defect is a hang.
- **3 more were shown by a script** while the committed test failed only on a missing export.
- **9 were not a failing test of the defect's behaviour:** 5 failed only on a missing module or export, 2 asserted on
  source text, 1 had no failing run (TASK-095, a test gap shown by a mutant) and 1 failed on another defect (TASK-102).
- **Re-run:** 14 unit proofs, rerun in a separate clone, all failed on the fix's parent with assertions and passed on
  the fix. Every cited range ran in 11. In the other 3, the cited code that did not run was a caller, a route file or
  the producer's side.
- **The records disagree in places:** TASK-095 and TASK-102 are marked `failedBefore: true` against their own proof
  text, and 18 behavioural proofs also added tests that failed only on a missing export, so a count of failing tests
  overstates them. The raw failing output was kept for 11 issues only.

### The plan critic, scored (October 25)

nextra's critic items were checked against the code and against what carrying out the plan met, and a sample of
rokbot's against its source, with no model calls.
- **Precision is high:** 18 of nextra's 20 distinct items were real, and the 2 that were not are the 2 the critique
  check rejected. All 10 of rokbot's items checked rest on true facts.
- **Recall of what execution met is near zero:** none of the 8 named problems above (five wrong premises, question 1's
  unworkable answer, check 19's wrong file, stale lines), and 1 of the 21 plan errors the dev-notes record (TASK-051
  and 052's exit clash, which the revision fixed). The critic saw almost no source (`citedSourceLeftOut`: 124 files on
  nextra, 88 on rokbot), and those problems are about the source.
- **The revision added errors:** TASK-091's wrong premise ("so onReconnect can retry") is not in the plan before the
  critique, the 10 prompts with wrong validation ids are all revised tasks, and TASK-092's step 8 had to be
  overridden.
- **Cost:** the critic, its check and the revision took 11.5% of nextra's tokens and 8.6% of its time (3.1M, 9 of 105
  minutes), and 16.9% and 10.6% of rokbot's.
- No prompt carries the 6 non-blocking items, and the agents dealt with 5 of them on their own.
