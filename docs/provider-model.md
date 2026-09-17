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

The adapters use native wire formats, including tool-call history and tool-result IDs.
The Responses adapter reads every text/refusal content block and uses
`previous_response_id`; the other three APIs use explicit message history rather than
an invented top-level continuation field. Gemini includes the model in the request URL
and sends system instructions as Content parts. These corrections were checked against
the [OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling),
[OpenAI structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs),
[Gemini GenerateContent reference](https://ai.google.dev/api/generate-content), and
[Anthropic structured-output guide](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

Effort parameters are transport-specific: Responses uses `{ "effort": "high" }`,
Chat Completions uses `{ "reasoning_effort": "high" }` (or the `effort` alias),
Anthropic uses native thinking fields, and Gemini uses native `thinkingConfig` fields.
Only supply fields supported by the selected model. Mock contract tests do not establish
live model capabilities; the composed CLI/server still uses scripted auditors only.

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

`packages/providers/src/registry.ts` binds endpoint IDs to transport implementations.
It supports OpenAI Responses, OpenAI Chat, Anthropic Messages, and Gemini Native in the
same registry. Multiple compatible services can share a protocol while retaining separate
URLs and environment-variable credential references. Custom transport factories can be
supplied for other protocols; unknown protocols fail explicitly.

`packages/providers/src/model-pool.ts` routes model-profile IDs through those bindings
and the existing invocation runtime. It validates endpoint identity, output/context
limits, tool and structured-output capability, and explicit effort collapse before
dispatch. Endpoint identity separates continuation state even when two services expose
the same model name. Request model identity must also match the trace context.

The run schema validates optional `workflow.modelExecution` settings: `endpoints`,
`modelEndpoints`, `maximumOutputTokens`, optional `maximumDiscoveryTokens`, `timeoutMs`, `maximumRetries`, `maximumTokens`,
per-provider `rateLimits`, and `roles` (`planner`, `verifier`, optional `critic`). Endpoint credentials are named by `apiKeyEnvVar`; values
are resolved only at dispatch. Limits are supplied by the operator, not inferred from a
provider-name table. The CLI/server executes a bounded source-snapshot Audit when these
settings and model profiles are supplied. Profile IDs for discovery match the selected
preset's `auditor-a`, `auditor-b` and, for deep audits, `auditor-c` nodes. Roles reference
configured profile IDs; deep audits require a critic profile. Audit depth requests low,
medium or high effort, with unsupported effort rejected unless an explicit collapse is
configured. Feature/Testing and native harness composition remain unavailable.

`packages/runtime/src/model-activities.ts` durably records request fingerprints, parsed
results, per-attempt provider traces and actual token usage. Completed calls are reused
after restart; changed requests under an existing activity ID are rejected. Calls are
stateless with explicit context, so an interrupted retry does not append the same prompt
to an opaque provider conversation. `DurableTokenBudget` saves reservations before
dispatch, reserves retries separately, and retains estimated charges for unknown usage.
Estimates are admission limits, not actual billed usage; monetary cost remains unknown.
The shared `inputTokens` value includes cache reads/writes. Anthropic's disjoint input
buckets are summed in its codec according to the
[documented token breakdown](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Model Audit uses the canonical harness with bounded read-only snapshot tools. Tool
artifacts are scoped to the current activity; discovery cannot read peer outputs.
Trusted protocol bytes are pinned per run and reused on resume/replay. Layered prompt
compilation locks the protocol, schema and tool declarations, and frames repository and
model artifacts as untrusted input. Each turn records prompt, profile, harness and
protocol identity, input/output references, duration and available usage. Unknown usage,
effort and monetary cost remain unknown rather than being reported as zero.

Discovery is isolated. Peer review uses seeded anonymous source labels, hides the
reviewer's own sources, aliases evidence/location IDs and dispatches candidates according
to the full, risk-weighted or minimal policy. Later rounds use candidate deltas; omitted
votes and objections are retained. A changed disposition requires new cited evidence.
Round artifacts record dispatch decisions, and accepted citations map back to their
original evidence IDs outside the model context. Verification asks a targeted model
question when deterministic checks cannot establish the claim. The configured
`verification.maxModelQuestionsPerRound` limits questions (default four; zero disables
model verification). Remaining candidates can still undergo deterministic checks and
remain unresolved when evidence is insufficient. Verification does not treat a
matching quotation as proof of a bug. Security coverage remains degraded because no
deployment/runtime evidence is collected. Wire-level and end-to-end tests inject HTTP
responses; these tests do not establish real-model correctness or the multi-model premise.

Discovery packs source by approximate import topology. Its initial compiled request,
including schemas, tools, framing and output reserve, must fit 80% of the smaller of
the configured discovery limit (default 128,000 conservative estimated tokens) and the
profile's known context limit. The remaining space accommodates tool turns. Oversized
modules split at file boundaries; files that cannot fit are reported as unexamined.
Lost joint module context is also reported. Each scope has isolated tools, unique finding
IDs and durable model activities, so resume reuses completed calls. Discovery allocation
artifacts record the selected paths and estimates. This limit is separate from total
run spend, and does not yet allocate context for later stages or trim growing tool history.
Peer review also accepts merge/split, added evidence and counter-evidence, severity and
blocker changes, remediation/verification supplements and missing findings. New evidence
must quote the selected snapshot and declare valid locations. The runtime binds local
IDs to reviewer provenance and rejects forged verification metadata and cross-candidate
citations. The durable board retains structural lineage; only active claims enter
verification and planning. Overlapping structural edits and contradictory severity or
blocker changes are deferred together, with every proposal preserved. Original claims
stay active and enter verification; planning receives the unresolved proposals. These
conflicts remain explicit coverage gaps, even if verification confirms the underlying
defect. Reviewer order does not select a winning structural claim.
Context allocation for later stages, semantic clustering escalation and executed verification still
require runtime integration.

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
