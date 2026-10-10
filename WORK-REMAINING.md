# Remaining work

Updated October 10, 2026 (branch `beta`).

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
- **Running now:** the pilot panels (`node evaluation/run-paced.mjs pilot-v2 0.9 0.8` in `arbitra-p20`), started
  on the owner's Windows PC on October 10 because the Mac is unavailable for a few days. They pace themselves on
  the Claude and Codex usage windows and will take several days. The private `HANDOFF.md` says how to watch, stop
  and restart them.
  - Codex answers through arbitra on Windows (0.162.1, live evidence in
    [qa/subscription-cli](docs/qa/subscription-cli/README.md)).
  - Restarting the PC ends the runner. That happened once on October 10; started again with the same command, it
    resumed the interrupted run.
  - The first three-vendor run used a whole Codex five-hour window and 15% of the weekly one before it was
    finished. The owner therefore replaced GPT-6 Astra with GPT-6.1 Sol in the premium and light lineups on
    October 10 (xhigh and medium effort), before any panel run had finished. The pilot started again under a new
    protocol version; the unfinished run was retired unscored. The cheap lineup's GPT-6 Luna effort is still open.
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
- **In progress:** P20, a hard premise benchmark. It is rebuilt as `p20-hard-v2` (12 projects); its pilot was re-calibrated on October 10 and is no longer at the ceiling, and the pilot panels are running on the owner's Windows PC. P20's benchmark is kept in the owner's private repository `arbitra-p20` so its answer keys stay out of public training data; never add it here.
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

One, found by the P20 pilot on October 10:

- **The Antigravity transport reports the CLI's error step as tool use.** A Gemini call ended with
  `CLI_AGENT_TOOL_USE_FORBIDDEN: Antigravity CLI attempted a error_message step`. The reader treats every step type
  outside a short list as agent tool use, which is never retried; `error_message` is the CLI's own step for a failed
  model call. The run failed, and its resume succeeded. To fix: record the step's text and classify it as a failed
  call (usage limit, throttle or service error). Fix it after the pilot, because the pilot's arbitra build must not
  change while it runs.

All eight findings in [qa/p19](docs/qa/p19/README.md) are fixed, and the affected live acceptance passed on subscriptions on September 30 (runs A–E there). The reruns found four more defects; all are fixed. The completion report is P21, after P20.

See [project status](docs/project-status.md) for implemented capabilities and measured evidence. Evidence per item is in [docs/qa](docs/qa/); the subscription runs are in [qa/p03-subscription](docs/qa/p03-subscription/README.md). Update task status only in the completion plan.
