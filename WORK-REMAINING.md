# Remaining work

Updated October 19, 2026 (branch `beta`). Task status lives in the [completion plan](docs/completion-plan.md); this
file says what is left and in what order. The measurements and decisions behind every item, from the P20 pilot
(October 10 to 19), are in this file's history: `git show 9558aef:WORK-REMAINING.md`.

## State

- **P20 is closed on its pilot (owner, October 19).** No held-out runs. On the three pilot projects, wherever three
  Opus-only runs together missed a planted defect, the premium panel found it, using 0.57 to 0.67 times their time
  and 0.69 to 0.76 times their tokens. That is 21 planted defects: an estimate, not a test. Per-defect results stay
  in the private benchmark repository.
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

Still to do for the checkpoint:

- **Branches (needs the owner):** tag `13be324` as `p20-build-13be324` (the private benchmark cites it), then delete
  `p20-2.7.0-fix`, `agent/elegant-sagan-3tby00` (already in `beta`) and the dependabot fastify branch (superseded:
  `beta` has fastify 5.12.5). The session's permission check refuses deleting remote branches.
- The whole check in Linux, the browser tests (`pnpm --filter @arbitra/web e2e`), a live run per subscription, and
  the self-audit from the web UI; then merge to `main`, tag and push.

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
  loop; `verification-metrics.modelCalls` counts questions, not calls.

**Experiments** ([design audit](docs/design-audit.md#what-changes), items 11 to 17): no peer review, lower efforts,
a second varied discovery pass, a cheaper verifier, a verifier of another vendor on a sample, an execution rung, a
static analyser. And score plans by executing them.

**To re-check on the current build** (measured October 11 to 13, before later changes): prompts sized at one byte a
token outside the stages that set `estimatedBytesPerToken`; discovery source as one JSON object a line; Gemini's
output nearly all thinking and its CLI's own agent prompt; a pinned copy of each CLI per protocol, as for Claude Code.

**Product:** the terms of each vendor's subscription CLI need a check before arbitra recommends subscriptions.
Google's Antigravity FAQ says wrapping `agy` in third-party applications "is not supported under consumer plans".

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
3. **Web UI.** `node apps/server/dist/src/serve.js` from the repository to audit, then `pnpm --filter @arbitra/web dev`, and open http://127.0.0.1:4173.
4. **Workflows (P03).**
   1. Generate the configurations: `node tooling/live/configure.mjs tooling/live/bindings.subscription.json .runs/live/configs-sub`.
   2. Run one: `tooling/live/run.sh .runs/live/configs-sub <audit-mixed-providers|feature-automatic|feature-interactive|testing-plan|testing-execute>`. The script keeps the Mac awake; a sleeping host stretches every stage timeout.
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
