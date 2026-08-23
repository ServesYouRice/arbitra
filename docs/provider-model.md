# Provider and model layer

arbitra is not built around one vendor, and not around one model naming generation. The
provider layer's job is to make several genuinely different APIs comparable without
pretending the differences do not exist.

## Model profiles

`packages/schemas/src/model-profile.ts` is the canonical schema; the runtime view is
`packages/providers/src/profiles/model-profile.ts`. A profile is strict — an unknown field
is an error, not a forward-compatible extra.

```text
provider · modelId · transport · servedBy · family · independenceGroup · capabilityTier
supports { tools, parallelToolCalls, structuredOutput, reasoning, promptCaching, batch, vision }
limits   { contextTokens, maxOutputTokens }          # nullable — null means unknown
effort   { supported, collapse, params }
quirks   { systemPromptSupport, fewShotPolicy, promptStyle, documentPlacement,
           historyPolicy, samplingDefaults, greedyDecodingSafe, toolLoopLimit,
           prefillSupported }
structuredOutputDialect
```

**arbitra ships no table of real model names, capabilities or prices.** The example
configurations use `replace-with-your-model-id` and null limits deliberately: provider
catalogues change, and a stale table asserting what a model supports is exactly the
fabricated capability data §32.1 forbids. Fill a profile in from your provider's own
documentation. `limits` stays `null` until you know the number — a null renders as
*unavailable* everywhere, and never as zero.

### Independence

`capabilityTier` is `frontier` · `balanced` · `fast`. `independenceGroup` is what makes a
multi-auditor run mean anything: two aliases in the same group are not independent
auditors, whatever their names.

`packages/providers/src/served-identity.ts` computes `servedIdentity` and
`independenceGroupOf`, and `collapseDuplicateServedIdentities` detects the case where two
configured aliases resolve to the same served model — a reseller endpoint, or the same
model behind two names. That collapse is reported rather than silently accepted, because a
"three-auditor" run that is really one model is a false claim about the result.

## Transports

`packages/providers/src/transport-contract.ts` defines the contract (`HttpClient`,
`FetchHttpClient`, `TransportError`). Implementations:

| Transport | Module |
|---|---|
| `openai-responses` | `transports/openai-responses.ts` |
| `openai-chat` | `transports/openai-chat.ts` |
| `anthropic-messages` | `transports/anthropic-messages.ts` |
| `gemini-native` | `transports/gemini-native.ts` |
| JSON test transport | `transports/json-transport.ts` |

A transport translates; it does not decide policy. Budget, retry and scheduling live above
it.

## Effort

`packages/providers/src/effort.ts` resolves a requested effort level against what a profile
supports (`resolveEffort`, `EffortResolution`). Where a model cannot honour the request,
the profile's `collapse` map records what it becomes — for example `xhigh → high`.

**Collapse is never silent.** The resolved level is recorded per call as
`effortRequested` / `effortResolved` in `packages/persistence/src/trace.ts`, surfaced by
the UI, and shown as a labelled degraded state rather than a hue. Honest effort projection
is the point: a run that quietly downgrades every call is indistinguishable from a cheap
run unless the downgrade is recorded.

## Structured output

`packages/schemas/src/projections/` projects one canonical schema into each provider's
dialect (`project-schema.ts`, `dialects/openai-strict.ts`, `dialects/gemini.ts`,
`dialects/anthropic-tool.ts`). A projection that cannot preserve the canonical schema
fails at build time with `SchemaProjectionError` rather than quietly mid fan-out — that is
the whole reason the projection harness exists.

`packages/schemas/src/repair.ts` defines the tiers (`structuredOutputTiers`) and the
bounded repair path (`RepairRequest`, `RepairDiagnostic`, `StructuredOutputResult`).
Tier degradation — strict schema unavailable, falling back to JSON mode or prompted JSON —
is recorded per call alongside effort collapse, and is likewise never silent.

## Quirks

`packages/providers/src/quirks.ts` parses the per-model behavioural differences that
otherwise become folklore: whether a system prompt helps or hurts, whether few-shot
examples help, XML versus Markdown prompt style, where documents belong in the context,
what to do with reasoning content in history, sampling defaults, whether greedy decoding is
safe, the tool-loop limit, and whether prefill is supported.

Encoding these as data rather than as conditionals is what lets one prompt compiler serve
every provider.

## Budget, scheduling and continuation

- `packages/providers/src/runtime.ts` enforces an `InvocationBudget` and suspends with
  `ProviderBudgetSuspendedError` rather than overspending. Every invocation emits an
  `InvocationTrace` to a `TraceSink`.
- `packages/providers/src/scheduler.ts` (`RateLimitScheduler`, `SchedulerLease`) paces
  calls under a `RateLimitPolicy` and records scheduler metrics.
- `packages/providers/src/cache-handle.ts` tracks prompt-cache handles so cache hit rate is
  measured per node rather than estimated.
- `packages/providers/src/continuation/store.ts` persists continuation state
  (`ContinuationStateStore`, `continuationTrace`) so a long generation can resume without
  re-paying for what was already produced.

## Refusals are not errors

`packages/persistence/src/trace.ts` records `outcome` as `success` · `refusal` · `error` ·
`cancelled`, with `refusal` and `error` in separate fields. A model declining to answer is
a measurable behaviour of that model, not a transport failure, and the metric layer
(`packages/persistence/src/metrics/query.ts`) can filter on it. Collapsing the two would
make a model that refuses often look identical to a flaky endpoint.

## Aggregation guard

The full identity tuple — model, profile version, transport, transport version, harness,
harness version, harness policy hash, protocol id, version and hash, prompt hash, resolved
provider config hash — is recorded on every trace. `MetricStore.query` refuses to aggregate
across differing model, harness or protocol identity unless that dimension is an explicit
grouping key, throwing `IncomparableIdentityError`. See [`evaluation.md`](evaluation.md).

## Not implemented

- **Provider batch API path.** `supports.batch` is recorded; the scheduler has no batch
  lane. v1.1.
- **Advisor runtime.** `advisor` and `advisorMaxUses` exist in Task IR and `advisorTokens`
  is recorded on traces, but nothing consumes them. v1.1.
