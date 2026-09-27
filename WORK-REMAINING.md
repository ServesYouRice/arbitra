# Remaining work

Updated September 27, 2026 against commit b560162 (branch `beta`).

The maintained execution queue is the [completion plan](docs/completion-plan.md). Every item is recorded in its [status table](docs/completion-plan.md#status-september-27-2026).

- **Complete:** P01, P02, P04, P05, P07, P09–P11, P13, P14, P16 and P17.
- **Implemented, conformance passed, live limits being added:** P12.
- **Implemented, evidence still outstanding:** P08 and P15.
- **Accepted live except the API protocols:** P03.
- **Interim result (insufficient evidence; resumable plan in [docs/qa/p06](docs/qa/p06/README.md)):** P06.
- **Decided provisionally (reject), to be rerun on P06 data:** P18.
- **Pending:** P19.

## What is left, by what it needs

1. **Nothing but time, on subscriptions:**
   - **P12:** opt-in live cases for crash recovery, tool limits and unknown usage against the real CLI. They are being added to `packages/runtime/test/native-harness.conformance.test.ts`; run them as in step 4 of the pick-up guide.
   - **P06:** a new protocol version that moves the premise evaluation onto subscription models (the committed protocol is prespecified with Gemini API models), committed before any run, then its runs.
   - **P18:** rerun on the P06 findings.
   - **P19:** the final review.
2. **Funded API accounts, which the owner does not use for testing:**
   - the OpenAI Responses, OpenAI Chat and Anthropic Messages protocols live (P03);
   - each P15 batch driver;
   - P08's live context limits.

   These stay open unless another operator runs them.

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
5. **Premise evaluation (P06).** The saved run state is **local only**, in `.claude/worktrees/agent-a6beaf6fd1302766f/.runs/p06`; keep that folder. The resume commands are in [qa/p06](docs/qa/p06/README.md). Moving P06 to subscription models needs a new protocol version, committed before any run.
6. **Then:** rerun P18 on the P06 findings, then the P19 review.

## Open findings to fix or decide

- **Models adopt a seeded bug as the intended behaviour.** A live Testing writer pinned the `isExpired` defect as correct. The Feature requirements model wrote the same wrong contract twice. Haiku reviewers accepted it both times, and a Codex reviewer caught it once. A step that checks tests and contracts against documented behaviour would help.
- **Audit cannot answer a blocking plan question.** A live Audit plan correctly left "throw or clamp?" open and failed its gate. Unlike Feature, an Audit run has no checkpoint to answer it and resume.
- **Shared-file tasks are ordered loosely.** A planner gave two tasks the same files with only `conflictsWith`. The critic flagged it too late for the one revision. A deterministic check could require an order.
- **Failed requests drain the budget.** A request that fails with no usage is charged its full admission estimate.
- **Single-auditor plans never address a finding.** With the `diff-fast` preset, every issue stays `single_source`, so the plan addresses nothing.
- **All auditors missed a hard-coded admin bypass** under a planted "this file is safe" comment (P06).

See [project status](docs/project-status.md) for implemented capabilities and measured evidence. Evidence per item is in [docs/qa](docs/qa/); the subscription runs are in [qa/p03-subscription](docs/qa/p03-subscription/README.md). Update task status only in the completion plan.
