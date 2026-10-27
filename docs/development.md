# Developing arbitra

How the project's own live testing runs, what the vendors' terms say about it, and how to pick the work up on a
machine. The plan of work is in [remaining work](../WORK-REMAINING.md).

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
users: [bindings.claude-primary.json](../tooling/live/bindings.claude-primary.json) is the API-key equivalent, and
[bindings.gemini.json](../tooling/live/bindings.gemini.json) records the free-tier Gemini setup behind the earlier
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
      arbitra keeps the machine from idle sleep while a run is live (`caffeinate -i`, `systemd-inhibit`,
      `SetThreadExecutionState`; see `packages/runtime/src/keep-awake.ts`), but a closed MacBook lid still sleeps it.
      A call a sleep cut is sent again once the machine has been awake for two minutes, without counting an attempt,
      and the run records the sleep (`host_suspended`); see [provider-model.md](provider-model.md).
   3. An interactive Feature stops `BLOCKED`. Inspect it with `requirements <run-id>`, then `revise-requirements`
      and/or `approve-requirements`, then run `tooling/live/resume.sh feature-interactive <run-id>`.
   4. Hand a Feature plan to fresh Claude Code executors: `node tooling/live/handoff.mjs <work-name> <run-id>`.

   `testing-execute` needs Docker and the pinned image; see [qa/p04](qa/p04/README.md).
5. **Native writer (P12).** Run in `packages/runtime`:

   ```bash
   ARBITRA_NATIVE_HARNESS_CONFORMANCE=1 ARBITRA_CLAUDE_CODE_EXECUTABLE=<absolute claude path> \
   ARBITRA_NATIVE_CONFORMANCE_MODEL=claude-sonnet-5 ARBITRA_NATIVE_CONFORMANCE_CREDENTIAL_KIND=subscription_login \
   npx vitest run test/native-harness.conformance.test.ts --silent=false
   ```

   See [qa/p12](qa/p12/README.md).
6. **Premise evaluation (P06): complete.** Version 2.1.0's results are in
   [qa/p06-subscription](qa/p06-subscription/README.md). Its run state is local only, in
   `.runs/p06-subscription-2.1.0` (2.0.0's in `.runs/p06-subscription`); keep both. For live runs, pace on the Claude
   five-hour window (`rate_limit_event` in any `claude -p --output-format stream-json --verbose` call).
7. **Usage windows.** Codex's are read without a model call through `codex app-server` (`account/rateLimits/read`).

Evidence per item is in [docs/qa](qa/README.md); the subscription runs are in
[qa/p03-subscription](qa/p03-subscription/README.md).

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
([completion plan](completion-plan.md#deferred-the-paid-api-bundle)): the OpenAI Responses, OpenAI Chat and
Anthropic Messages protocols live (P03); P08's live context limits; each P15 batch driver; and from the engineering
review, opaque reasoning state per message, native output schemas and explicit cache control.

