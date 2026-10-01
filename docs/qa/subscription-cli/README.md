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
| Antigravity CLI | 1.2.11 | Google AI login (OS keyring) | `gemini-3.8-flash-low` | passed | passed | passed | [antigravity.json](antigravity.json) |
| Gemini CLI | 0.61.0 | Google login cached | `gemini-3-flash-preview` | unavailable (`AUTH`, `CLI_ACCOUNT_INELIGIBLE`) | not reached | not reached | [gemini.json](gemini.json) |

Measured per call: Claude Code about 440 to 880 input tokens (the default system prompt is
replaced) and about 1 second; Codex about 5,700 to 6,100 input tokens (Codex adds its own
instructions; most were cache reads) and about 4 seconds. Usage is recorded as reported and
cost as unknown. Both emulated tool calls produced a single `lookup_word` call with the ID
`call_0ca79e88e488264659ff17b8`, derived from the conversation, so the same conversation gives
the same ID on every CLI.

Antigravity CLI: about 24,600 to 25,100 input tokens per call (its own agent instructions) and
about 7 seconds. Its stream-json events are `{"event": "init" | "step_update" | "result", ...}`;
a plain answer has only `user_input`, `agent_response` and `finish` steps, and the transport
treats any other step as agent tool use. The init event lists about 40 built-in tools
(browser, command, file and permission tools) that cannot be switched off. With
`--json-schema` the `response` text carried extra `toolAction`/`toolSummary` keys, so the
transport reads `structured_output` only. `--mode plan` only warns while slash commands are
disabled, so it is not used.

Gemini: the Google account signs in, but the Code Assist service refuses it before any model
call: `IneligibleTierError: This client is no longer supported for Gemini Code Assist for
individuals` (tier `free-tier`, reason `UNSUPPORTED_CLIENT`). The transport reports this as
`AUTH` / `CLI_ACCOUNT_INELIGIBLE` and never counts it as passing. This is Google's retirement
of personal logins from the Gemini CLI (June 18, 2026), not a defect: personal Google AI
subscriptions are served through the Antigravity CLI above. `gemini-cli` stays
`declared_unverified` until a Code Assist Standard or Enterprise login passes this runner.

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
- Antigravity CLI 1.2.14 (September 30, 2026) keeps only the first 191,580 bytes of a prompt
  and replaces the rest with `<truncated N bytes>`, which only the model sees: prompts of
  200,010, 260,013 (multibyte) and 380,321 bytes, from two working directories, all kept
  exactly 191,580 bytes, and the stream reported nothing. A P20 pilot discovery on a 385 KB
  prompt was audited in part this way. The transport now refuses prompts over 190,000 bytes.
  The same version streams its own tool use as a `tool` step naming the tool
  (`"tool_name": "run_command"`), and in `--sandbox` it ran `ls -la` without asking; the
  transport fails the call at that step.
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

The failures in runs 1 and 2 were not transport failures. With `package.json` in
`scope.modules`, both models listed it in `reviewedSourcePaths`. The validator is right to
refuse that: the field is compared with the inventory's source files (`src/session.js` here)
to report unreviewed source, and `package.json` is test metadata. The refusal carried only
the code, so the repairs could not tell what to change. `validateTestingRisk` now names the
offending paths and the allowed ones (for example `TESTING_REVIEWED_SOURCE_INVALID:
reviewedSourcePaths lists "package.json", which is not among the source files …; allowed:
"src/session.js"`), and the check itself is unchanged.

| Run | Analyst / planner | Calls | Result |
|---|---|---|---|
| 4 | Sonnet 5 / Haiku 4.5, committed scope (with `package.json`), descriptive refusal | 7 | Risk analysis recovered on its first repair; gap selection passed; the run `FAILED` in planning with `MODEL_PLAN_PROVENANCE_MISMATCH` |

In run 4 the Haiku planner's first call stopped at the 8,000-token output ceiling
(`OUTPUT_LIMIT`, and Claude Code's automatic continuation was stopped), so the runtime split
planning into a brief and an outline. The outline's first attempt ran past the 600 s stage
timeout and was retried. Its repaired reply then failed validation: it did not echo the
premise report verbatim, `MODEL_PLAN_PROVENANCE_MISMATCH`. That is a planner-output problem
on Haiku, not a transport one. A Sonnet 5 planner, or a descriptive refusal for that check
like the one above, is the next thing to try. The long first attempt suggests that Claude
Code retries throttled or overloaded requests internally before it reports anything, so a
subscription call can take minutes.
