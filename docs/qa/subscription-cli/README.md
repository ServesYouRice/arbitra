# Subscription CLI transports: live evidence

Recorded September 26, 2026 on macOS 26 (arm64), Node 22.23.2, with the owner's own
subscription logins. No API key was used, and none appears in these files. Email addresses
and key-shaped strings are redacted at the source.

## Transport conformance (actual CLI calls)

Runner: [live-subscription-cli.conformance.test.ts](../../../packages/providers/test/conformance/live-subscription-cli.conformance.test.ts),
opt-in with `ARBITRA_LIVE_SUBSCRIPTION_CLI=<vendor>:<model>,...`. Each CLI gets three tiny calls
through the production registry and transport: a text reply, an emulated tool call, and the
final answer after the tool result is replayed in the transcript. Executables were found by
the production discovery (Claude Code from the newest VS Code extension binary, Codex from the
ChatGPT app, Gemini from PATH).

| CLI | Version | Login | Model | text | tool call | tool result | Evidence |
|---|---|---|---|---|---|---|---|
| Claude Code | 2.1.282 | Claude Max (`claude auth status`) | `claude-haiku-4-5-20251001` | passed | passed | passed | [claude-code.json](claude-code.json) |
| Codex CLI | 0.154.0-alpha.6.2 | ChatGPT (`codex login status`) | `gpt-5.6-luna` | passed | passed | passed | [codex.json](codex.json) |
| Gemini CLI | 0.61.0 | Google login cached | `gemini-3-flash-preview` | unavailable (`AUTH`, `CLI_ACCOUNT_INELIGIBLE`) | not reached | not reached | [gemini.json](gemini.json) |

Measured per call: Claude Code about 440 to 880 input tokens (the default system prompt is
replaced) and about 1 second; Codex about 5,700 to 6,100 input tokens (Codex adds its own
instructions; most were cache reads) and about 4 seconds. Usage is recorded as reported and
cost as unknown. Both emulated tool calls produced a single `lookup_word` call with the ID
`call_0ca79e88e488264659ff17b8`, derived from the conversation, so the same conversation gives
the same ID on every CLI.

Gemini: the Google account signs in, but the Code Assist service refuses it before any model
call: `IneligibleTierError: This client is no longer supported for Gemini Code Assist for
individuals` (tier `free-tier`, reason `UNSUPPORTED_CLIENT`). The transport reports this as
`AUTH` / `CLI_ACCOUNT_INELIGIBLE` and never counts it as passing. `gemini-cli` stays
`declared_unverified` until an eligible account (a paid Google AI or Code Assist plan, or a
Workspace licence with `GOOGLE_CLOUD_PROJECT`) is signed in and this runner passes.

Probes made while building the adapters (not repeated in the evidence files):

- Claude Code with `--tools ""` and `--json-schema` exposes one tool, `StructuredOutput`, and
  takes two model turns, so arbitra uses it only when a schema is requested without tools.
- Claude Code answers an output-ceiling stop by injecting "Output token limit hit. Resume
  directly" and calling the model again (four calls observed). The transport stops the process
  at that event and returns `OUTPUT_LIMIT`. Thinking is off unless requested
  (`MAX_THINKING_TOKENS=0`); with it on, Haiku spent 720 of 800 output tokens thinking.
- With `--safe-mode`, `--setting-sources ""` and a replaced system prompt, the model reported
  no CLAUDE.md, AGENTS.md, memory, skill or tool definitions in its context. It still saw
  Claude Code's environment block: the temporary working directory, platform, date and the
  account's email address.
- Codex with every optional feature disabled still lists `exec`, `apply_patch`, `wait`,
  `request_user_input` and collaboration functions. The read-only sandbox, `approval_policy
  "never"`, the empty working directory and the event check (any item other than a message or
  reasoning fails the call) contain them.
- Codex refused `gpt-6-luna` for a ChatGPT account (`model is not supported when using Codex
  with a ChatGPT account`); this is classified as `INVALID_REQUEST` / `CLI_MODEL_UNAVAILABLE`.
  One call on `gpt-5.6-luna` failed transiently (websocket drops, then an HTTPS fallback
  rejected with 401) and succeeded on retry.

## End-to-end: `testing-plan` through the public CLI on Claude Code

Configuration: [bindings.subscription.json](../../../tooling/live/bindings.subscription.json)
through `tooling/live/configure.mjs`, run with `tooling/live/run.sh` on the fixture repository.
`validate` reported `ready` with no diagnostics: the preflight probes found Claude Code, read
its version and confirmed the Max login without a model call. Traces:
[testing-plan-traces.json](testing-plan-traces.json).

| Run | Analyst / planner | Calls | Result |
|---|---|---|---|
| 1 | Haiku 4.5 / Haiku 4.5 | 3 (risk turn and two repairs) | `FAILED`: `TESTING_REVIEWED_SOURCE_INVALID` |
| 2 | Sonnet 5 / Haiku 4.5 | 5 (risk, then two repairs, each using an emulated tool call before answering) | `FAILED`: `TESTING_REVIEWED_SOURCE_INVALID` |
| 3 | Sonnet 5 / Haiku 4.5, scope without `package.json` | 2 (risk, gap selection) | `COMPLETED`, gate `failed`: `no_repository_test_command`, `no_implementation_handoff` |

Run 3 narrowed `scope.modules` by hand; the committed bindings keep `package.json` in scope.
Run 2's work directory was replaced by run 3, so its traces are not in the file; its five
Sonnet 5 calls used 4,111 to 8,392 input and 42 to 1,891 output tokens.

Every call succeeded at the transport level, with measured usage and
`transportVersion: claude-code/2.1.282` on each trace, and the durable repair loop and the
canonical harness's tool loop ran unchanged over the subscription. Run 3 completed the run
with 4 selected gaps; planning stopped because removing `package.json` from scope also removed
the repository test command, as designed.

The failures in runs 1 and 2 are a finding about the Testing risk prompt, not the transport.
When `package.json` is in `scope.modules`, both models listed it in `reviewedSourcePaths`, which
the validator allows only for inventory source files (`src/session.js` here), and the repair
message names only the code. The same scope is used by the API bindings
(`bindings.claude-primary.json`, `bindings.gemini.json`), so this would affect them too.
