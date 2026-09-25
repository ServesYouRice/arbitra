# P13 live advisor path: results

`advisor-evidence.json` is the redacted evidence from one run of the opt-in live advisor test
(`packages/runtime/test/model-advisors.live.test.ts`) on 2026-09-25. The code was beta at
41a1e65 plus the commit that adds this directory. **Both Gemini paths passed every check.**

| Item | Value |
|---|---|
| Platform | macOS (Darwin 25.6.0), darwin-arm64, Node v22.23.2 |
| Model | `gemini-3.1-flash-lite` as the `balanced` advisor profile |
| Endpoints | `gemini-native` (transport `gemini-native`, `https://generativelanguage.googleapis.com/v1beta`) and `gemini-compatible-chat` (transport `openai-chat`, `https://generativelanguage.googleapis.com/v1beta/openai`) |
| Path under test | Production `TaskAdvisor` → `ModelActivities` → provider pool → transport → real HTTP. Only the HTTP client is wrapped, to count requests. |
| Policy | `maximumUsesPerTask` 1, task `advisorMaxUses` 1, context 20 000, output 2 048, 40 000 tokens per task |
| Spend | One advisor call per endpoint: 433 input / 285 output tokens native, 434 / 247 compatible |

## Command

```sh
set -a; . ./.env; set +a
ARBITRA_LIVE_ADVISOR=1 ARBITRA_LIVE_ENDPOINTS=$PWD/tooling/live/endpoints.json \
ARBITRA_LIVE_ADVISOR_ENDPOINTS=gemini-native,gemini-compatible-chat \
ARBITRA_LIVE_ADVISOR_EVIDENCE=$PWD/docs/qa/p13-live/advisor-evidence.json \
  pnpm --filter @arbitra/runtime exec vitest run test/model-advisors.live.test.ts
```

Without `ARBITRA_LIVE_ADVISOR=1`, the test is skipped.

## Checks (all passed on both endpoints)

| Check | What it verifies |
|---|---|
| `advice` | The first consult returns schema-valid advice. The ledger records the use as `completed`, not replayed. |
| `identity` | The use records advisor profile `advisor`, tier `balanced`, model `gemini-3.1-flash-lite`, an activity under `testing/advisor/…`, and exactly one provider request ID. |
| `measuredUsage` | Provider-reported input and output tokens. The ledger's `chargedTokens` equals their sum: 718 and 681, against an admission estimate of 4 110. After a retried transient failure the check instead requires the conservative outcome: ledger usage null, charge equal to the estimate. |
| `replayNotRepaid` | A fresh advisor over the same durable store, given the same request ID, replays the advice without a provider call. |
| `useLimit` | A second request ID returns `exhausted: uses` with `usesConsumed: 1`, and no provider call is made. |
| `providerCalls` | The HTTP request count equals the transport attempt count (1), all to the configured origin. |
| `noTools` | No tools are sent to the advisor. |
| `trace` | Exactly one model-activity trace, with `harnessId: advisor-direct`, the advisor's model, `tokenUsage` equal to the ledger, and `advisorTokens` equal to the charge. |
| `budget` | The run token budget holds one reservation, for the advisor activity, with the measured usage. |
| `advisoryInput` | The executor-facing advisory input has `authority: none` and names the advisor's model. |

## Defects found and fixed

- **Advisor output contract.** In the first live run, both endpoints produced advice that
  failed `advisorAdviceSchema` (`risks: expected array, received string`). The advisor system
  prompt named `risks` without a type. The prompt now gives every field's JSON type, the
  20-item caps, and the non-empty rule. After the change, all runs passed.
- **Missing request identity on the OpenAI-compatible endpoint.** The `openai-chat` transport
  read the provider request ID only from the `x-request-id` header. Gemini's compatible
  endpoint does not send that header, so the advisor traces had no request identity. The
  transport now falls back to the completion `id` in the response body. A unit test covers
  this: `packages/providers/test/contract/openai-chat-identity.test.ts`.

## Notes and remaining gaps

- One earlier run on the compatible endpoint hit a transient `HTTP` error on its first
  attempt, and the retry then succeeded. By design, `ModelActivities` does not report a total
  once there has been more than one attempt: the failed attempt may have been billed. The
  ledger therefore charged the admission estimate. The test accepts this outcome explicitly,
  and this is not a defect. The recorded run had no retry.
- Only Gemini was exercised. The OpenAI and Anthropic keys have no credit, so their advisor
  paths would record `unavailable` (QUOTA).
- This is one sample per endpoint. It shows the path works end to end. It does not measure
  advice quality or how reliably the model follows the output contract.
