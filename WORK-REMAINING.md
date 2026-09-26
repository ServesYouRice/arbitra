# Remaining work

Updated September 25, 2026 against commit 0c6fb12 (branch `beta`).

The maintained execution queue is the [completion plan](docs/completion-plan.md). Every item is recorded in its [status table](docs/completion-plan.md#status-september-25-2026).

- **Complete:** P01, P02, P04, P05, P07, P09–P11, P13, P14, P16 and P17.
- **Implemented, evidence still outstanding:** P08, P12 and P15.
- **Partially accepted live:** P03.
- **Interim result (insufficient evidence; resumable plan in [docs/qa/p06](docs/qa/p06/README.md)):** P06.
- **Decided provisionally (reject), to be rerun on P06 data:** P18.
- **Pending:** P19.

## What is left, by what it needs

1. **Funded provider accounts.** The OpenAI and Anthropic keys have no API credit, and the Gemini key is free tier.
   - The Gemini free tier limits flash-lite to 500 requests per day per model and flash to 20; it has no Pro access and no Batch.
   - Credit on any account unlocks the rest of P03: the other protocols, a mixed-provider run, live Audit, interactive Feature and the executor handoff.
   - It also unlocks each P15 batch driver, a heterogeneous-family P06 and the P12 conformance run. P12 needs Anthropic credit, or instead a subscription token from `claude setup-token` with `credentialKind: oauth_token`.
2. **The next Gemini quota window**, for the remaining live Audit/Feature runs and P06 conditions, if no paid key is added.
3. **After live data:** rerun P18 on P06 findings, then the P19 final review.

## Live-testing policy

Subscription mode is a product feature for every user, on an equal footing with API keys and selectable per role. The owner's own live testing runs **only on subscription models**, through the vendors'
CLIs, and never on API credits:

| Vendor | CLI | Sign-in |
|---|---|---|
| Anthropic | Claude Code | Claude login |
| OpenAI | Codex CLI | ChatGPT login |
| Google | Gemini CLI | Google login (the owner is signed in) |

Claude carries most roles. Codex and Gemini take at most one secondary role each, because
their limits are lower. The API-key transports remain for other users.

Subscription CLI transports are being built so that every role can run this way. When they
land, live configurations come from `tooling/live/bindings.subscription.json`.
[bindings.claude-primary.json](tooling/live/bindings.claude-primary.json) is the API-key
equivalent, and [bindings.gemini.json](tooling/live/bindings.gemini.json) records the
free-tier Gemini setup that produced the evidence so far.

## How to pick this up again

1. **Credentials.** They live in the repository's gitignored `.env`:
   - `ARBITRA_ANTHROPIC_API_KEY`
   - `ARBITRA_OPENAI_API_KEY`
   - `ARBITRA_GEMINI_API_KEY`

   To use Claude, the Anthropic account needs API credit. For the native Claude Code writer only (P12), a subscription token also works:
   1. Run `claude setup-token`.
   2. Put the token in the variable `apiKeyEnvVar` names.
   3. Set `harness.native.credentialKind: "oauth_token"`.
2. **Transport conformance (P03).** Run
   `ARBITRA_LIVE_CONFORMANCE=1 ARBITRA_LIVE_ENDPOINTS=tooling/live/endpoints.json pnpm --filter @arbitra/providers exec vitest run test/conformance/live-transport.conformance.test.ts`.
   Then gate the evidence with `ARBITRA_REAL_PROVIDER_CONFORMANCE=1`.
3. **Workflows (P03).** Steps:
   1. Run `pnpm build`.
   2. Run `node tooling/live/configure.mjs tooling/live/bindings.claude-primary.json .runs/live/configs`.
   3. Run `tooling/live/run.sh .runs/live/configs <audit-mixed-providers|feature-automatic|feature-interactive|testing-plan|testing-execute>`.
   4. If a run fails for a provider reason, resume it from a fresh process with `tooling/live/resume.sh <name> <run-id>`.

   `testing-execute` needs Docker and the pinned image; see [qa/p04](docs/qa/p04/README.md).
4. **Batch (P15).** Run the command in [qa/p15-live](docs/qa/p15-live/README.md). Mark a driver `verified_live` only when its `batch:<driver>` observation passed.
5. **Premise evaluation (P06).** The saved run state is **local only**, in `.claude/worktrees/agent-a6beaf6fd1302766f/.runs/p06`. Keep that folder. The resume commands are in [qa/p06](docs/qa/p06/README.md). The P06 protocol is prespecified with Gemini models. Moving it to Claude-primary auditors needs a new protocol version, committed before any run.
6. **Then:** rerun P18 on the P06 findings, then the P19 review.

## Open findings to fix or decide

- **Generated tests are only checked to pass, not to be right.** A live Testing writer pinned the seeded `isExpired` defect as correct behaviour. A reviewer or critic step that checks tests against the documented contract would catch this.
- **Failed requests drain the budget.** A request that fails with no usage (a 503) is charged its full admission estimate, about 59k tokens each in P06.
- **Single-auditor plans never address a finding.** With the `diff-fast` preset, every issue stays `single_source`, so the plan addresses nothing.
- **All auditors missed a hard-coded admin bypass.** The bypass sat under a planted "this file is safe" comment (P06).
- **Gemini free tier:** 500 requests/day per flash-lite model, 20 on flash, no Pro, no Batch, frequent 503s.

See [project status](docs/project-status.md) for implemented capabilities and measured evidence.
Evidence per item is in [docs/qa](docs/qa/). Update task status only in the completion plan.
