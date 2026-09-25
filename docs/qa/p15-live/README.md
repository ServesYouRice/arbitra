# P15 live batch validation: results

`batch-evidence.json` is the redacted evidence from one run of the opt-in live batch runner
(`packages/providers/test/conformance/live-batch.conformance.test.ts`) on 2026-09-25. The code was
beta at 41a1e65 plus the commit that adds this directory. **No batch driver could be verified
live, because no configured account can create a batch.** All three drivers stay
`declared_unverified`, and the gate test (`real-provider.conformance.test.ts`) still fails
`batch:<driverId>` for every driver, as it should.

| Item | Value |
|---|---|
| Platform | macOS (Darwin 25.6.0), darwin-arm64, Node v22.23.2 |
| Endpoints | `tooling/live/endpoints.json`: `openai-responses` (gpt-5.4-nano), `anthropic-messages` (claude-haiku-4-5-20251001), `gemini-native` (gemini-3.1-flash-lite) |
| Path under test | The production `ProviderRegistry.batchDriver` and `BatchLane`, with file-backed lane and budget state. The runner does not use a driver of its own. |
| Spend | None. Every submission was refused before any billable work was created. |

## Command

```sh
set -a; . ./.env; set +a
ARBITRA_LIVE_BATCH=1 ARBITRA_LIVE_ENDPOINTS=$PWD/tooling/live/endpoints.json \
ARBITRA_LIVE_BATCH_EVIDENCE=$PWD/docs/qa/p15-live/batch-evidence.json \
ARBITRA_LIVE_BATCH_STATE=$PWD/.runs/live/batch-state ARBITRA_LIVE_BATCH_RUN=final \
  pnpm --filter @arbitra/providers exec vitest run test/conformance/live-batch.conformance.test.ts
# Gate over transport and batch evidence together (path-delimiter separated):
ARBITRA_REAL_PROVIDER_CONFORMANCE=1 ARBITRA_LIVE_EVIDENCE=<transport.json>:$PWD/docs/qa/p15-live/batch-evidence.json \
  pnpm --filter @arbitra/providers exec vitest run test/conformance/real-provider.conformance.test.ts
```

For each endpoint that has a batch driver, the runner does four things:

1. It submits a 2-item batch through `BatchLane.execute`. One item is plain text. The other asks
   for structured output with `additionalProperties: false`.
2. It polls to the end. `ARBITRA_LIVE_BATCH_POLL_MS` sets the interval (default 20 s).
   `ARBITRA_LIVE_BATCH_WAIT_MS` bounds the wait (default 20 min).
3. It checks each item's result: one shared provider job, distinct custom IDs, trace IDs that
   match their items, the expected text or structured value, and measured usage.
4. It cancels a separate 1-item batch at the provider.

The runner is resumable. Item and submission records, including the provider job ID, persist
under `ARBITRA_LIVE_BATCH_STATE/<run tag>/<endpoint>`. The lane's own deadline is 24 h, so the
lane never cancels a slow job by itself. If the runner's wait ends first, the observation is
`pending` and the job keeps running. Running again with the same `ARBITRA_LIVE_BATCH_RUN`
reattaches to that job through the lane's `attach` plan and collects its results; nothing is
resubmitted.

## Results

| Driver | `batch:<driver>` | Lookup (no spend) | Cancel | Why |
|---|---|---|---|---|
| `openai-batch` | unavailable | passed. A live `GET /v1/batches` listing returned `not_found` for an unknown key. | not attempted | `POST /v1/batches` returned `QUOTA` (`invalid_request_error/billing_hard_limit_reached`). The JSONL file upload is not billable and succeeded. |
| `anthropic-message-batches` | unavailable | unsupported. Reconciliation is `operator_only` by declaration, so the lookup makes no provider call. | not attempted | `POST /v1/messages/batches` returned `QUOTA` (400, "credit balance is too low"). |
| `gemini-batch` | unavailable | passed. A live `GET batches` listing returned `not_found`. | not attempted | `models/gemini-3.1-flash-lite:batchGenerateContent` returned 400 `FAILED_PRECONDITION`. A minimal 1-item batch sent through the same driver was refused the same way. |

### Gemini: the account's tier has no batch access

The Gemini key works for interactive calls, and the P13 advisor run used it. It belongs to a
**free-tier** project:

- A `generateContent` probe on a model outside the free tier answered with
  `generate_content_free_tier_*` quota metrics at `limit: 0`.
- The Gemini pricing page lists Batch as "Not available" on the free tier for Gemini 3.1
  Flash-Lite.
- `models.list` shows `batchGenerateContent` among the model's supported methods, so the model
  itself supports batch. The refusal is account-level.

Gemini sends the same generic `FAILED_PRECONDITION` for other causes, such as an unsupported
location. For that reason the driver keeps it as `INVALID_REQUEST`, now with the provider's
status in the message. The runner then resubmits the smallest possible request. If that
minimal batch were accepted, the runner would cancel it immediately and record `failed`,
because the refusal would then belong to the driver's encoding. Here the minimal batch was
refused too.

## Defects fixed

- **Batch HTTP error classification.** The batch HTTP client reported exhausted credit as
  `RATE_LIMIT` (retryable, OpenAI 429 `insufficient_quota`) or as a bare `INVALID_REQUEST`
  (Anthropic 400 "credit balance"). It now uses the same non-retryable `QUOTA` classification
  as the interactive transports, as a definite non-submission (`accepted: "no"`). Every batch
  HTTP failure also carries the provider's bounded, redacted error detail
  (`providerErrorDetail`). Before this change, Gemini's refusal read only "Provider HTTP 400".
- **Gemini batch request encoding.** The batch driver has no encoder of its own. It calls
  `geminiNativeCodec.encode`, so the P03 fix in 41a1e65 (`responseJsonSchema` and
  `parametersJsonSchema` instead of the OpenAPI-subset fields that reject
  `additionalProperties`) already applies to batch items. A regression test in
  `test/batch/drivers.test.ts` now pins this. Thought signatures do not apply to batch, since
  the lane rejects tool-bearing requests (`BATCH_LANE_REQUIRES_SINGLE_SHOT_REQUEST`). None of
  this could be exercised live, because no Gemini batch was accepted.
- The gate accepts several evidence files in `ARBITRA_LIVE_EVIDENCE`, separated by the path
  delimiter, so transport and batch evidence can be gated together.

## Remaining gaps

- **submit, poll, results and cancel are unverified live for all three drivers.** Closing the
  gap needs OpenAI or Anthropic API credit, or a paid-tier (billing-enabled) Gemini project.
  After that, rerun the command above. A passing `batch:<driverId>` observation, with its
  provider job ID and usage, is the evidence to cite in that driver's
  `declaration.liveValidation`. Its status can then move to `verified_live`.
- The resume path (a `pending` job collected by a second invocation) has not run against a real
  provider job, because no job was ever created. The lane's reattach behavior is covered by
  `test/batch/lane.test.ts` only.
- Gemini `FAILED_PRECONDITION` is classified by the runner only. Production code still treats
  it as a non-retryable invalid request, not as `QUOTA`.
