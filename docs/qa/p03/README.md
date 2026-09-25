# P03: live-provider acceptance

Recorded September 25, 2026 on branch `beta`. Host: macOS 26, arm64, Node 22.23.2.
Credentials came from the repository's untracked `.env`. None appear in these files: they
were checked against the actual values and key-shaped patterns.

## Accounts available for this run

| Protocol | Account state | Consequence |
|---|---|---|
| OpenAI Responses and Chat | Key valid, **no API credit** (`insufficient_quota`) | Every model call is `unavailable` (QUOTA) |
| Anthropic Messages | Key valid, **no API credit** (`credit balance is too low`) | Same |
| Gemini Native | **Free tier**, see limits below | Live; `gemini-3.1-flash-lite` and `gemini-3.5-flash-lite` |
| Compatible endpoint (OpenAI Chat wire protocol) | Gemini's OpenAI-compatible endpoint, same free-tier key | Live |

Gemini free-tier limits observed:

- 20 requests per day per model on the gemini-3 / 3.5 flash models;
- 5 requests per minute on gemini-3-flash;
- 0 on Pro;
- 500 requests per day per model on flash-lite, reached during this work;
- gemini-2.5 models return 404 for new users;
- frequent `503 high demand` responses.

A mixed-*provider* run was therefore impossible. The runs below mix protocols instead (native and compatible chat) and Gemini model variants. These are **one model family**, and no independence claim is made from them.

## Transport conformance (actual invocations)

Runner: [live-transport.conformance.test.ts](../../../packages/providers/test/conformance/live-transport.conformance.test.ts).
Endpoints: [tooling/live/endpoints.json](../../../tooling/live/endpoints.json).
Evidence: [transport-conformance.json](transport-conformance.json), 40 observations, each with its endpoint, protocol, model, provider request IDs, measured usage and runtime traces.

| Case | gemini-native | Gemini via openai-chat | openai-responses / openai-chat / anthropic-messages |
|---|---|---|---|
| text, usage, request ID | passed | passed (request ID absent then; later fixed to fall back to the completion `id`) | unavailable (QUOTA) |
| structured output | passed | passed | unavailable |
| tool call + tool result round trip | passed | passed | unavailable |
| output limit → `OUTPUT_LIMIT` | passed | passed | unavailable |
| cancellation (client abort in flight) | passed | passed | passed (client side only; no response existed) |
| timeout + retry trace (`retry:TIMEOUT, failed:TIMEOUT`) | passed | passed | passed (client side only) |
| cache accounting | passed (4,075 cached tokens) | not elicited (the endpoint reported no cached tokens) | unavailable |
| continuation | unsupported | unsupported | openai-responses: unavailable; others: unsupported |
| refusal, context limit | not elicited | not elicited | — |

The gate in [real-provider.conformance.test.ts](../../../packages/providers/test/conformance/real-provider.conformance.test.ts)
now reads this evidence instead of supplied booleans. It still fails `continuation` and every
`batch:<driver>` case (see [P15 live](../p15-live/README.md)), as it should.

## Public workflows through the CLI (fresh fixture checkout each)

Fixture: [tooling/live/fixture-repo](../../../tooling/live/fixture-repo). It has three seeded defects, whose ground truth is kept outside the checkout copy.

- **Configurations** were generated from `examples/model-backed` by [configure.mjs](../../../tooling/live/configure.mjs) and [bindings.gemini.json](../../../tooling/live/bindings.gemini.json).
- **Scripts:** runs used [run.sh](../../../tooling/live/run.sh); resumes from a fresh process used [resume.sh](../../../tooling/live/resume.sh).
- **Run settings:** `maximumRetries: 5`, `maximumOutputRepairs: 2`.

| Workflow | Result | Evidence |
|---|---|---|
| Testing plan | **passed** gate; `report`/`export` reloaded from a fresh process | 9 activities, 33,118 input / 2,295 output tokens |
| Feature, automatic | **passed** gate | 5 activities, 5,470 / 1,223 tokens, 1 output repair (exploration) |
| Testing execute (Docker + live writer) | **passed** gate | 13 activities, 36,669 / 3,100 tokens, 2 repairs |
| Audit, three auditors (audit-deep) | **not completed** | See below |
| Feature, interactive | not run | Daily quota spent first |

**Testing execute details:**

- The task check and the final check ran in the P04 image.
- `apply-changes` wrote the verified bytes into a separate matching checkout, whose own `node --test` then passed 5/5.
- A checkout with a diverged `test/session.test.js` was rejected, and nothing was written.

**Earlier runs:**

- *Feature and Testing:* failed runs were resumed from a fresh process. Completed activities were reused, and the runs then completed.
- *Audit:* runs progressed further after each fix:
  1. through discovery, clustering, verification and peer review;
  2. then to the planner;
  3. the last attempt stopped at the free tier's 500 requests/day on flash-lite.

  The Audit acceptance, the handoff to a fresh executor, and the budget and blocking-decision checks at workflow level remain outstanding.

## Defects found by these live runs (all fixed on beta, with regressions)

1. Exhausted credit was retried as a rate limit (OpenAI 429) or reported as bare HTTP 400 (Anthropic). There is now a non-retryable `QUOTA` class, and failures keep a bounded, redacted provider error detail.
2. Google reports per-minute throttles and exhausted daily allowances with the same 429 text. They are now classified from the `QuotaFailure` details, and `RetryInfo` is honoured.
3. Gemini rejected `additionalProperties` in `responseSchema` and `parameters`. The transport now sends `responseJsonSchema` and `parametersJsonSchema`.
4. Gemini tool round trips require the thought signature back. It is now carried as opaque `providerState` on tool calls, natively and as `extra_content` on the compatible endpoint.
5. The compatible endpoint sends no `x-request-id`. The request ID now falls back to the completion `id`.
6. Models quote the right lines but miscount ranges, and copy the framing's entity escaping. Exact quotes are now re-anchored within a few lines (Testing and Feature evidence, and the peer reviewer's own locations). The text itself must still match byte for byte.
7. Replies follow our own prompt: `<quotes>`, reasoning, then JSON, often fenced. The JSON document that ends the reply is now parsed, and nothing looser.
8. A reply that failed validation failed the stage outright. **`maximumOutputRepairs`** now re-asks, as a durable and budgeted activity. Planner traceability, evidence grounding and Testing selection are validated inside the repairable step.
9. Any listed limitation withholds a handoff, and models listed findings and caveats as limitations. The prompts now define a limitation.
10. Planners emitted `TASK-1 -> TASK-1` self-edges and invented requirement IDs. Self-references are now dropped, and the Feature and Testing prompts say what a requirement ID is.
11. Peers filled the verifier-only `verification` field, because the schema offered it, and reused presented candidate IDs. The peer schema now omits the field, and refusals now name the rule broken.
12. One reviewer's reply that stays invalid after repair failed the whole Audit. It is now set aside and reported as degraded review coverage.
13. A Testing writer that looped to the tool-turn limit failed the run. The attempt now ends as incomplete, and the next attempt proceeds.
14. A generated test pins the seeded defect: `isExpired` is asserted false *at* `expiresAt`, against the documented contract. This is a **quality finding from human review**, not a runtime defect. Final verification proves only that the tests pass, not that they are right.

## What remains for P03

- A mixed-provider run and every OpenAI/Anthropic case. These need API credit on either account.
- Completing the Audit and the interactive Feature run, and then:
  - the handoff of an exported plan to a fresh executor;
  - the workflow-level budget and blocking-decision checks.

  All of this needs the next daily quota window or a paid key.
- Eliciting a refusal and a context-limit error. The cases exist; neither was triggered.
