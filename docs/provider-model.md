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

**The runtime infers nothing from a model's name.** The example configurations use
`replace-with-your-model-id` and null limits deliberately: provider catalogues change, and a
stale table asserting what a model supports would be fabricated capability data. Fill a
profile in from your provider's own documentation. `limits` stays `null` until you know the
number — a null renders as *unavailable* everywhere, and never as zero.

The web app's New run page carries a small model catalogue
(`apps/web/src/pages/new-run/model-catalog.ts`): model IDs per transport with their family
and capability tier, and for some the context and output limits and the vendor's effort
words. It lists no prices. Choosing a model there writes those values into the profile, and
the subscription templates start with each CLI's recommended model filled in
(`apps/web/src/pages/new-run/templates.ts`). The values are still declarations, checked by
preflight like any other.

Every capability field is therefore an operator declaration with the operator's
documentation as its provenance. Runtime preflight
(`packages/runtime/src/preflight.ts`) checks the declarations against what each
configured stage will ask for before a run exists. It checks tool support for Testing
writers, capability tiers, and effort levels that are neither supported nor explicitly
collapsed. A live run whose profile still carries a `replace-with-` identity is refused
(`MODEL_IDENTITY_PLACEHOLDER`). Runnable templates for every wire protocol and a
mixed-provider configuration are in `examples/model-backed/`. [Getting started](setup.md)
explains endpoint/role binding and the enforced budget limits.

### Independence

`capabilityTier` is `frontier` · `balanced` · `fast`. `independenceGroup` is what makes a
multi-auditor run mean anything: two aliases in the same group are not independent
auditors, whatever their names.

The group is read where independence is required: peer review accepts a high-risk candidate,
and settles a structural conflict, only with evidence-backed votes from at least two groups
(`packages/workflow/src/consensus/engine.ts`); Feature reviewers must declare distinct groups,
and a Feature critic a group other than the planner's. Nothing compares the models behind
two profiles: two aliases of one served model (a reseller endpoint, or the same model behind
two names) in different groups count as independent. A "three-auditor" run that is really
one model is a false claim about the result, and only the configuration prevents it.

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
| `claude-code-cli`, `codex-cli`, `antigravity-cli`, `gemini-cli` | `transports/cli/` (subscription CLIs) |

`TRANSPORT_SUPPORT_MATRIX` in `transports/cli/support.ts` records every shipped transport
with its credential kind and verification status:

| Transport | Kind | Credential | Status | Evidence |
|---|---|---|---|---|
| `openai-responses` | HTTP API | API key variable | declared, unverified live | mock contract tests |
| `openai-chat` | HTTP API | API key variable | live verified | [P03](qa/p03/README.md) (Gemini's compatible endpoint) |
| `anthropic-messages` | HTTP API | API key variable | declared, unverified live | mock contract tests |
| `gemini-native` | HTTP API | API key variable | live verified | [P03](qa/p03/README.md) |
| `claude-code-cli` | subscription CLI, Claude Code 2.1.0–<3.0.0 | CLI login or `claude setup-token` token | live verified on 2.1.282 (macOS) and 2.1.296 (Windows) | [subscription-cli](qa/subscription-cli/README.md) |
| `codex-cli` | subscription CLI, Codex 0.150.0–<0.200.0 | ChatGPT login | live verified on 0.154.0 (macOS) and 0.162.1 (Windows) | [subscription-cli](qa/subscription-cli/README.md) |
| `antigravity-cli` | subscription CLI, Antigravity CLI 1.1.15–<2.0.0 | Google login (personal Google AI plans) | live verified on 1.2.11 (macOS) and 1.3.3 (Windows) | [subscription-cli](qa/subscription-cli/README.md) |
| `gemini-cli` | subscription CLI, Gemini CLI 0.60.0–<1.0.0 | Google login (Code Assist Standard/Enterprise only since June 18, 2026) | declared, unverified live (a personal account was refused as ineligible) | [subscription-cli](qa/subscription-cli/README.md) |

**Subscription CLI transports** run a vendor's official CLI headless as a completion engine,
so a role can use a Claude, ChatGPT or Google subscription instead of API credit. The
endpoint is `cli://<vendor>` with `auth` (`subscription_login`, or `oauth_token` plus
`oauthTokenEnvVar` for Claude Code); no key or URL is configured. Each call: resolves the
executable (override variable, PATH, documented install locations), refuses a CLI version
outside the matrix range, serializes the conversation deterministically into one framed
transcript (system messages through the CLI's own system-prompt mechanism, with its default
prompt replaced; a compiled stage prompt — protocol, schema, tools and instruction — is one user
message, so the system prompt carries only arbitra's short engine preamble and the stage prompt
travels in the transcript), runs the CLI in an empty temporary directory with an allowlisted
environment and its agent tools, MCP, hooks, skills, plugins and project instructions
disabled, and kills the process tree on exit. Tool use is emulated: the transcript lists
arbitra's tools and the model replies with `{"toolCalls":[{"name","arguments"}]}` or its final
answer; calls get IDs derived from the conversation hash, so the canonical harness's durable
tool loop is unchanged. The transcript's markers carry a boundary derived from a secret of the
transport and from what a stage's calls share (instructions, tools, schema), so every call of a
stage starts with the same text; a message that happens to contain the boundary gets the
request's own hash instead. Before October 14, 2026 every transcript that offers tools began
with its request's hash. A provider that caches any shared prefix (OpenAI and Google cache
automatically) can now read that start from its cache; Claude Code caches at the ends of its
system prompt and of the conversation, so its separate calls share the system prompt only, and
its savings come from continued sessions. Each stage's input puts its source first and the
call's own question after it, as Anthropic advises for long documents. Measured (October 14,
Claude Code 2.1.296, its system prompt replaced): a call in another directory read 26,032 of
26,387 prompt tokens from the cache another call wrote, so a fresh directory a call costs about
355 tokens of cache, not the prompt. On Claude Code a conversation that offers tools runs in the CLI's own
session: the first call starts it (`--session-id`), and a tool turn continues it (`--resume`)
in the same working directory with only the tool results, so the CLI reads the conversation
so far from its prompt cache. A kept session is found by the conversation and the tool calls its
model asked for, so two completions of one input each continue their own. The directory and the
stored session are removed when the conversation ends, when the run that owns the transport
settles (each run builds its own
transports, so nothing else would remove a session its run left open), or after two hours. A
session that cannot be continued is sent whole once; a continuation that is throttled or meets
an upstream failure goes back to the runtime's retry, which waits its backoff and retry hint
before sending the conversation whole. Measured (October 14, 2026): a continued turn read 91% of its prompt from the
cache, the same turn sent whole 19%, writing the rest to the cache again. Codex and the
Antigravity CLI keep sessions the same way: Codex starts one by leaving out `--ephemeral` and
continues it with `codex exec resume <thread>`, the Antigravity CLI with `--conversation <id>`
(its turn then leaves out the instructions, which the conversation already holds; the CLI opens a
continued conversation with a `system_message` notice of its own, which is read as part of a plain
answer, not as tool use: until October 19, 2026 it failed every continued Antigravity turn, which
was then sent whole). A continued answer that cannot be read is sent whole at once rather than
spending one of the runtime's attempts. Both report
a continued turn's usage for the whole conversation so far, so the turn is charged the
difference. Codex keeps its databases in the call's control directory (`CODEX_SQLITE_HOME`) and
its session as a rollout file that is removed with the conversation; the Antigravity CLI stores
every call's conversation in the operator's home with no flag against it (1.2 GB after the P20
pilot), so every call's conversation is removed when the call ends. Measured the same day through
the transport: a continued Codex turn read 16,768 of 17,092 prompt tokens from the cache (98%);
a continued Antigravity turn read 21,246 tokens from the cache in one check and none in another
(Gemini's cache is implicit). The Antigravity CLI's `input_tokens` leaves out cache reads, so its
prompt is counted as the two together. Codex (`--output-schema`), Claude Code and the Antigravity CLI (`--json-schema`; the answer is
read from `structured_output`, and a SUCCESS without it is `MALFORMED_RESPONSE`) enforce a
response schema natively when one is requested without tools; otherwise output is prompt JSON
(no runtime stage requests one; see [Structured output](#structured-output)).
Usage is mapped as reported (unknown stays `null`), cost is unknown, the provider request ID is
the CLI session or thread ID, and the response's `transportVersion` (`<vendor>/<version>`) is
recorded on the trace. Failures are classified: not signed in or ineligible account → `AUTH`;
plan allowance exhausted → `QUOTA` (with the reset, also recorded for preflight); throttling
or overload → `RATE_LIMIT` with the CLI's retry hint; refused model → `INVALID_REQUEST`;
output ceiling (including Claude Code's automatic continuation, which is stopped, and, on the
CLIs that take no ceiling, a reply reported past it) → `OUTPUT_LIMIT`; unreadable stream or bad
tool envelope → `MALFORMED_RESPONSE`; timeout and cancellation as usual; a process tree that
outlives the call, whatever stopped it → `CLI_PROCESS_TREE_NOT_TERMINATED`, never retried. The
CLI's own tool events (`tool_use`, `command_execution`, `file_change`, MCP, search) stop the
process immediately and fail the call.

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
live model capabilities. Configured CLI/server workflows invoke these transports through
the canonical harness; Audit with no configured models uses scripted auditors.
Gemini native, its compatible chat endpoint and three subscription CLIs have live evidence.
Live conformance of the OpenAI Responses, OpenAI Chat and Anthropic Messages API protocols
is deferred to the [paid-API bundle](completion-plan.md#deferred-the-paid-api-bundle) (P03).

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

Every stage asks for JSON in its prompt. The compiled prompt
(`packages/core/src/prompt/compiler.ts`) locks the stage's output schema beside the protocol
and the tool definitions, and says to return only JSON matching it. No stage sends the schema
to the provider: the transports can carry one (`responseSchema`: a JSON-schema output format
on the API codecs, `--json-schema` or `--output-schema` on the CLIs when no tools are
offered), but the runtime never sets it, so every call records
`structuredOutputTier: "prompt_json"` in its activity trace.

`parsePromptJson` (`packages/runtime/src/model-activities.ts`) reads the JSON document out of
the reply, and the stage's own schema validates it; many stages also check their rules inside
the call (evidence grounding, plan traceability, outline and patch rules). A reply that fails
is asked for again within `maximumOutputRepairs` (0–3, default 0;
`packages/runtime/src/model-harness.ts`). Each repair is its own durable activity
(`<activity>/repair-<n>`) that carries the rejection reason and the rejected reply as
untrusted data, and its trace counts it in `repairCount`. A reply still invalid after the last
repair fails the activity, and a stage that can go on without that one answer records the gap
([harness](harness.md#the-adapter-port)). Provider failures, refusals and output-limit stops
are never repaired.

## Quirks

`packages/providers/src/quirks.ts` parses the per-model behavioural differences that
otherwise become folklore: whether a system prompt helps or hurts, whether few-shot
examples help, XML versus Markdown prompt style, where documents belong in the context,
what to do with reasoning content in history, sampling defaults, whether greedy decoding is
safe, the tool-loop limit, and whether prefill is supported.

Encoding these as data rather than as conditionals is what lets one prompt compiler serve
every provider. Today only `systemPromptSupport` and `toolLoopLimit` change what is sent:
the others, and `structuredOutputDialect`, are validated and recorded with the run but no
renderer or transport reads them yet, so setting one changes no request.

## Budget, scheduling and continuation

`packages/providers/src/registry.ts` binds endpoint IDs to transport implementations.
It supports OpenAI Responses, OpenAI Chat, Anthropic Messages, Gemini Native and the four
subscription CLI transports in the same registry. Multiple compatible services can share a protocol while retaining separate
URLs and environment-variable credential references. Custom transport factories can be
supplied for other protocols; unknown protocols fail explicitly.

`packages/providers/src/model-pool.ts` routes model-profile IDs through those bindings
and the existing invocation runtime. It validates endpoint identity, output/context
limits, tool and structured-output capability, and explicit effort collapse before
dispatch. Endpoint identity separates continuation state even when two services expose
the same model name. Request model identity must also match the trace context.

The run schema validates optional `workflow.modelExecution` settings: `endpoints`,
`modelEndpoints`, `maximumOutputTokens`, optional `maximumDiscoveryTokens` and
`maximumContextTokens`, `timeoutMs`, `maximumRetries`, `maximumTokens`,
per-provider `rateLimits`, optional `batch` lanes (see [Batch lane](#batch-lane)), and `roles` (`planner`, `verifier`, optional `critic`, `critiqueChecker` and `secondOpinion`, the model asked again when `verification.secondOpinion: "severe_rejections"` and the verifier rejects a critical or high issue a reviewer backed; by default the critic, or another auditor than the verifier). Endpoint credentials are named by `apiKeyEnvVar`; values
are resolved only at dispatch; `run` first checks that each referenced variable is set
(`PROVIDER_CREDENTIAL_MISSING:<endpoint>`) without reading the value into any output.
Limits are supplied by the operator, not inferred from a provider-name table. The CLI/server executes a bounded source-snapshot Audit when these
settings and model profiles are supplied. Profile IDs for discovery match the selected
preset's `auditor-a`, `auditor-b` and, for deep audits, `auditor-c` nodes. Roles reference
configured profile IDs; deep audits require a critic profile. Audit depth requests low,
medium or high effort, with unsupported effort rejected unless an explicit collapse is
configured. Feature composition uses these same endpoint bindings and budgets, with
separate role selections in `workflow.feature`; see [Feature mode](workflows.md#feature-mode).
Testing composition uses `workflow.testing.roles` for its frontier analyst and planner,
with the same endpoint bindings, budgets and durable harness. See
[Testing mode](workflows.md#testing-mode). The Testing writer can also run natively on
Claude Code; see [harness.md](harness.md#native-harness-adapters).

`packages/runtime/src/model-activities.ts` durably records request fingerprints, parsed
results, per-attempt provider traces and actual token usage. Completed calls are reused
after restart; changed requests under an existing activity ID are rejected. Calls are
stateless with explicit context, so an interrupted retry does not append the same prompt
to an opaque provider conversation. `DurableTokenBudget` saves reservations before
dispatch, reserves retries separately, and retains estimated charges for unknown usage.
An attempt that provably consumed nothing is released and charged zero, with the rule
recorded on the reservation and in the attempt's trace: it was never dispatched; the
credential, CLI or login was missing; the connection was never established; or the provider
refused it before any work (HTTP 429, quota, 401/403, 400/404/413/422, a 503/529 carrying the
provider's own error body, or a Claude Code usage-limit refusal with no output). Timeouts,
other 5xx, dropped streams and malformed replies stay charged.
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
question when deterministic checks cannot establish the claim: one for every candidate,
including those the peer vote accepted or rejected, up to `maximumParallelCalls` at a time.
A vote ranks a candidate; it does not decide it (models agree on 60% of the answers both get
wrong, and in one measured three-vendor run 26 of 53 accepted issues had reached the plan on
votes alone; [design audit](design-audit.md)). The questions go out most severe first, then by
how many reviewers supported the candidate, so a bound leaves out the least important. A
question names the places its findings cite, not the candidate's title, and the verifier reads
each finding's location, trigger, problem and quoted evidence under neutral references: not
which model found it, nor its severity, status or confidence, and with evidence and location IDs
renamed (a judge leans towards claims stated with authority, and towards its own family's).
Answering that the source cannot decide is named as an expected answer; such an issue is
reported as unverified and not planned. A rejected candidate whose findings cite places that do
not overlap, asked alone or in a group, is asked about one place at a time, in order; the issue
then stands for every confirmed place's findings under the first one's title (`verification-places-<id>`,
`verification-held-findings`). Observed: a merge gave a real defect another finding's title,
and the question about that title was rejected. The accepted list is ranked by severity, then by
how many auditors found the issue, then by the verifier's confidence (`issue-ranking`).
`verification.maxModelQuestionsPerRound` bounds the questions when it is set (zero disables
model verification): the re-asks of a merge's places, second opinions and a failed group's
questions asked one at a time come out of what the first questions leave, a question it leaves
out is listed (`verification-questions-not-asked`, `verification_questions_not_asked:<n>`), and a
severe rejection it leaves without a second opinion stays open. An answer may write 16,000
tokens, reasoning included, and a group that many a question: of about 5,500 measured
verification turns the longest wrote 2,284, and one that ran on to a 128,000-token ceiling had
looped. A question reads the files its candidate cites (every other file is a
tool call away, and its instruction says to read what the answer depends on), and the
unresolved peer operations that involve its own candidate in outline; the plan reads those
that involve accepted issues in full. A wider source was measured and dropped: with the files
of the cited files' modules, each of 51 questions read 47 of a project's 57 files, because one
chain of imports joins most of a project, and the questions of one run read 5.3M tokens.
`verification.maxQuestionsPerCall` (default 1) lets questions whose claims cite the same files
share a call: a group starts with the first question not yet grouped and takes later ones that
cite a file it already reads, while the files it reads stay within 60,000 characters and the
call fits. The call answers every question on its own, with evidence from that question only,
and shows the evidence and location IDs of all its questions under one neutral naming
(`verification-groups` lists the groups; `modelQuestionCalls` in the metrics counts the calls).
Replayed on a run's 58 stored questions, three to a call made 25 calls where there were 58, and
the source they read first fell from 656,000 to 428,000 characters. It stays off: every lab's
own review tool checks one finding per sub-task, and papers measured lower accuracy when
different reasoning problems share a prompt (worse in 81.7% of mixed cases, by 13.5 points on
average; [research](research.md#9-papers)). The P20 pilot set it for protocol 2.7.0 and took it
out the same evening, before any run. A question its provider declines, or whose reply stays invalid or stops at the output
ceiling, leaves its candidate unverified and the run records
`verification_question_unanswered:<n>`. A stage whose
required input cannot fit its context is tried as required input before it gives up:
with those operations in outline, then at two bytes a token with no optional source
([harness](harness.md#remaining-explicit-limits)). A question that cannot be sent even
so is not asked: the candidate stays
unverified, no question is spent on it, and the run records
`verification_question_exceeds_context:<n>`. Remaining candidates can still undergo deterministic checks and
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
run spend. The global `maximumContextTokens` policy defaults to 128,000 conservative
estimated tokens and also caps the discovery allocation.

Later stages retain all required decision data and allocate optional source context from
the same compiled-prompt estimate. Cited files and related imports take priority; oversized
cited files can use excerpts with original line numbers. Allocation artifacts and the
model input identify omitted/excerpted paths. Required issues, evidence, conflicts and
plan data are never dropped to fit; an oversized required input fails explicitly.
Growing tool histories archive complete older exchanges into activity-local artifacts,
preserving the original prompt and valid tool-call/result pairing. Archived content is
available through the read-only artifact tool and remains recorded in the run.
Peer review partitions oversized candidate sets using the actual compiled prompt budget
(and at most as many candidates per primary batch as the output capacity admits at 160
tokens each). Each candidate receives one full review
per selected reviewer. Pairs separated by batching receive additional merge-only checks,
so batching does not silently remove duplicate-detection opportunities. These checks can
grow quadratically and share the run token budget; exhaustion suspends the run. Complete
candidates or pairs that cannot fit still fail explicitly. Batch manifests, namespaces
and durable activities preserve coverage and restart reuse. Unusually large individual
records still fail explicitly; the staged planner path below handles oversized issue sets.

Peer review also accepts merge/split, added evidence and counter-evidence, severity and
blocker changes, remediation/verification supplements and missing findings. New evidence
must quote the selected snapshot and declare valid locations. The runtime binds local
IDs to reviewer provenance and rejects forged verification metadata and cross-candidate
citations. The durable board retains structural lineage; only active claims enter
verification and planning. Overlapping structural edits and contradictory severity or
blocker changes are deferred together, with every proposal preserved. Original claims
stay active while follow-up reviewers examine anonymous alternatives before the next
review round. Applying a proposal or retaining the original requires evidence-backed
agreement from every configured auditor, plus quorum and independence requirements.
A changed resolution vote requires newly cited evidence. Proposals, votes, and decisions
remain durable artifacts; ordinary peer review evaluates the resulting claims. Missing
reviewers, disagreement, or stale source claims keep the conflict unresolved and planning
receives those proposals. These
conflicts remain explicit coverage gaps, even if verification confirms the underlying
defect. Reviewer order does not select a winning structural claim.
Ambiguous finding pairs now use durable semantic classification through the verifier profile,
reading the files the two findings cite. Unless `maximumClusteringPairs` is set, every pair whose
findings cite overlapping lines is classified, with the pairs two findings of one answer form and
the pairs the structural rule would have joined, and the first 20 of the rest; those pairs come
first, up to 300 in all (`MAXIMUM_SHARED_LINE_PAIRS`): fifty findings on one line would
otherwise be 1,225 pairs, about 370,000 output tokens. Pairs past the ceiling, the weakest, stay
unclassified and reach verification as separate candidates. The structural rule then joins only
exact duplicates and proposes the rest. Set, the bound
is exact (0 disables escalation; maximum 1000) and the structural rule joins as before. Observed:
with the first 20 pairs in id order, 40 pairs of one run's 53 accepted issues overlapped, and
each duplicate paid for its own verification and task; in a three-model shakedown on October 14
the structural rule joined a stock leak, an unbounded coupon and missing input checks into one
issue of 9 findings, pairs the semantic check had judged unrelated.

## One pass per review stage

A run reads its material once in each review stage unless it asks for more. Measured on one
audit with three models at their highest effort (P20 pilot, 301 minutes and 20.3M tokens): the
second review round, the votes on conflicting proposals, the pair checks and the second critic
reading were 194 of 283 calls, and after them the accepted list held 2 of the 7 known defects
that the review had not rejected.

- **Peer review** runs the rounds `maxConsensusRounds` allows. The API-key Audit templates set
  one; the subscription Audit templates set 0, so their auditors never review each other's
  findings. What a round leaves undecided, including candidates tied up in conflicting
  structural proposals, goes to verification. Conflicting proposals are put to the auditors
  only from a second round on; with one round they stay recorded as coverage gaps.
- **A review batch carries the source its candidates cite**, whole or as excerpts: a batch is
  closed when the next candidate's cited source would not fit beside it. A reviewer cannot check
  a claim against a file it was not given (observed: batches packed with candidates until 3 of
  53 files were left, and "needs verification" was voted as often as "accept").
- **Candidates of different review batches are not compared for a merge** unless
  `review.crossBatchMergeChecks` is true. A reviewer still merges within a batch.
- **The critic reads the plan against the issues the plan resolves**, the accepted ones, in one
  call when that fits and otherwise in batches of complete records with the global index.
  Records of different batches are compared pair by pair only when `review.criticPairChecks`
  is true. (Feature plans keep their pair coverage.)
- **The critic is asked only what code cannot check** (protocol `plan-critic` 1.1.0, the
  audit's default): a task that would leave its issue unfixed, a regression, verification that
  would pass while the defect remains. A blocking item names the failure it prevents and quotes
  its task; at most ten non-blocking items are kept from a call. With `roles.critiqueChecker`
  set, each blocking item is checked by that model before the revision, one question an item
  against the tasks, issues and files it names (protocol `critique-check`); an item that does
  not hold stays in the feedback as non-blocking, with the reason (`critique-checks`). A model
  of neither the planner's nor the critic's family judges between them most evenly.
- **A plan may cover only the most severe accepted issues**
  (`modelExecution.planScope.minimumSeverity`, off unless set). The others stay on the
  accepted list with their evidence and are listed in `plan-scope` and in the handoff.
- **The audit hands off its final plan** as an implementation tree (`implementation`): one
  file per accepted or unverified issue with where it is, the quoted evidence, the verifier's
  answer and how many auditors reported it; a planned issue asks for a test that fails before the
  fix and for a result the executor reports in `progress.jsonl` (`fixed`,
  `not_reproducible`, `no_change_needed` or `blocked`, with proof). Saving the plan into the
  project writes it as prompts under `.arbitra/plans/`, with a `results.json` for the same
  results that the run reads back ([Getting started](setup.md#export-the-plan-into-the-project)).
- **One critic, one revision.** The critic reads the revised plan again only when
  `review.recheckRevisedPlan` is true. Otherwise `critic-feedback` keeps the critique and adds
  a `revision` record: which blocking items the revision resolved and which it could not revise.
  Only an item it could not revise still fails the gate; its question is in the plan.
- **Tasks that write the same files are ordered by the run, not by a repair.** A plan or a
  revision that leaves two such tasks unordered is not refused: the later task (by id) waits for
  the nearest earlier one ([task IR](task-ir.md)). Observed: the refusal named the missing edges,
  and the repair wrote the whole plan again, 60,000 output tokens in eight minutes.
- **A plan too large for one answer is not asked for in one call.** The run counts the accepted
  issues against what one answer is expected to hold (1,400 output tokens an issue for a plan,
  1,200 for an outline, 900 for the reading notes; a dozen issues are always asked for whole)
  and goes straight to the notes, the outline and one call a task. Observed: the one call for
  52 issues stopped at a 64,000-token ceiling after nine minutes, and all of it was discarded.
  An outline of more issues than one answer holds is written in sections of equal size, side by
  side; each section's rules (its own records only, every question kept, no reference outside
  it) are checked inside its call, so a reply that breaks one is sent back with the rule.
- **A plan of many issues may be written in sections side by side**
  (`modelExecution.planSections.issuesPerSection`, audit plans, off unless set). The issues are
  put in order of the files they cite and cut into sections of even size; each section is
  planned whole in one call, checked inside it, and the sections are joined by numbering
  (tasks of different sections that write the same files are ordered by the run). Questions
  that different sections ask for one decision are asked once: a call reads the sections'
  questions alone and names the groups, and each group keeps its first question's id with
  every section's wording and the strictest blocking flag and blast radius, every reference
  pointing at it. On nextra's 59 questions (October 24) it joined the three on which forwarded
  headers to trust, the two blocking ones on how OBS setup may release a held encoder, and two
  on the read-only constraint, in 19 seconds; rules on shared words or shared issues also
  joined different questions in other sectioned plans, such as a repeated consume request
  with a repeated produce request. Compared on
  the 52 accepted issues of a stored run with Opus 5.5 as planner (October 14,
  `tooling/planner-compare`): one call took 10.3 minutes and 0.18M tokens for a plan of 25
  tasks; four sections side by side took 7.4 minutes and 0.39M tokens for 49 tasks. A blind
  judge (GPT-6.1 Sol, each issue's tasks from both plans in an order drawn per issue) preferred
  the sections' plan for 41 issues and the one call's for 10, with one tie, and scored it higher
  on correctness (4.38 against 4.23 of 5), completeness, verification (4.21 against 3.50) and
  safety; the side a plan was shown on made no difference (26 and 25 wins). The sections' plan
  is 2.4 times as long, and a judge may favour detail, so the next timed runs check what the
  critic and the revision make of it.
- **A task is written out against its own part of the plan.** When the outline has more than
  eight tasks, the call that writes one task out reads that task's dependency neighbourhood in
  full and an index of every task, not the whole outline. It reads the files its task names and
  the files and locations its issues cite; every other file is a tool call away. Observed: each
  of 31 such calls read 213,000 characters, 105,000 of them the whole outline and 23,000 the
  locations of all 52 issues.
- **A reply is not sent back for one bracket too many.** Closing brackets left over after a
  complete JSON document are read past, and so is a fenced block the model abandoned before the
  one that ends its reply. Anything else after the document is still refused. Observed: 7 of 31
  replies of about 20,000 characters ended in one bracket too many, and each repair read the
  whole prompt again.
- **A source tool returns a file of ordinary size whole** (32 KB a result). A larger result ends
  on a whole line and says which lines it carries and where to read on. Observed: at 8 KB a
  result cut in the middle of a line still named the whole range, and the model asked again
  from a guessed line.

`stageEffort` sets the effort of the stages after discovery (`clustering`, `peerReview`,
`verification`, `planner`, `critic`, `revision`; each `low`, `medium` or `high`, mapped by the
model profile). A stage left out runs at the effort of the audit depth, as discovery always
does. The shipped deep audits check at `medium` and cluster at `low`: a provider's highest
effort is for work where a gain was measured, and a check is a narrower task than the audit.

`estimatedBytesPerToken` (1 to 4, default 1) is how many bytes of a prompt count as one token
when a call after discovery is sized. Real prompts measured 1.9 to 2.5 bytes a token, so the
default counts about twice what a provider reads and halves what a call may carry; the shipped
model-backed audits set 2. Discovery units stay at one byte a token, because the size of a unit
is how finely the audit reads the source. A transport that takes only so many bytes of a prompt
(the Antigravity CLI) bounds a call at that size whatever the setting.

`maximumParallelCalls` (default 1, maximum 8) is the number of independent calls one auditor has in flight
at a time within a stage: the units of a discovery (however they split), the batches of a peer review, the conflicts that share
no candidate, the questions of a verification, the briefs and task expansions of a plan, and the parts of a
critic review. It changes only how long a stage takes: no call reads another's reply, and the replies
are put together in a fixed order. Each call in flight holds its own budget reservation, and the provider's
`maxConcurrent` still applies. The reviewers of a peer-review round and the auditors of one conflict are
always asked together and recorded in the auditor order.

A peer-review reply is checked operation by operation. A citation of another candidate's evidence is left
out when the operation also cites evidence of its own candidate. An operation that fails its own validation,
including one of the wrong shape (a vote without its `type`), is left out and recorded (`peer-review-refused-operations-*`, limitation
`peer_review_operations_refused:<n>`), and evidence only it would have added is withdrawn from the other
operations' citations; a presented evidence ID it reused stays cited. A changed vote that cites no new
evidence is left out the same way, so the earlier vote stands. The reply is refused, and repaired within `maximumOutputRepairs`, only when its envelope,
locations or findings are invalid, or when more than half of its operations would be left out. A pair check
(`merge_check`) is still checked whole.

A provider's refusal of one call does not fail the audit. The CLI transports report a content-filter notice
as a refusal instead of a reply, and the harness records it durably (`model-refusal-*`) and does not ask
again. Discovery tries a declined unit again in smaller parts (several files as two scopes, one file as
two line windows). A part declined beside parts that were answered is split the same way to find the source
declined; a declined window, or parts all declined, are left unexamined for that auditor
(`discovery-declined-*`, limitation `discovery_provider_refused`), since a cause in no one part (a fixed prompt
the provider refuses) declines every smaller part too. A unit whose reply stays invalid after its repairs is
treated the same way (`discovery_reply_rejected`). A declined review batch contributes nothing and counts as rejected
review output, and an auditor whose provider declines a conflict, or whose answer stays invalid after its
repairs or stops at the output ceiling, casts no vote (`peer-conflict-unanswered-*`), so that conflict stays
unresolved.
Exact and structural matches still resolve without model calls. Unclassified pairs remain
separate. The run persists classifications, rationales, operations, and unresolved pairs.
Clustering aggregate token/cost metrics are null when model calls occur; individual
provider turn traces retain available usage. Audit verification optionally executes
operator-configured checks through the isolated Docker adapter described below.

Set `verification.execution` to an object with `driver: "docker"`, a local Linux image
reference pinned as `name@sha256:<64 hex digits>`, and `checks`. Each check has a unique
`id`, snapshot-relative `sourcePaths`, an absolute container `executable`, and an
`arguments` array. Checks run for unresolved candidates citing any configured path;
all configured paths must exist in the snapshot. No shell command is inferred from
model output. Defaults are five runs, 30 seconds per check and 65,536 output bytes;
override these with `maximumRuns`, `timeoutMs` and `maximumOutputBytes`.

The engine must already be running locally and the pinned image must already exist.
Images are never pulled or built. Only source snapshot files are mounted, so the image
must provide dependencies. Check reservations consume budget even if interrupted or
unavailable. Resume cleans up unfinished containers and reuses completed results;
interrupted checks are not automatically repeated. Results are redacted artifacts and
untrusted verifier context, never automatic proof that a claimed defect exists. Missing
engine support and unsuccessful checks remain visible as coverage gaps.

- `packages/providers/src/runtime.ts` enforces an `InvocationBudget` and suspends with
  `ProviderBudgetSuspendedError` rather than overspending. Every invocation emits an
  `InvocationTrace` to a `TraceSink`.
- `packages/providers/src/scheduler.ts` (`RateLimitScheduler`, `SchedulerLease`) paces
  calls under a `RateLimitPolicy` and records scheduler metrics. Each run has its own
  scheduler: runs side by side (one process each, as the P20 runners are) do not share
  `maxConcurrent`, the per-minute rates or a retry hint. Only an exhausted usage window is
  shared, through the CLI limit ledger.
- No production path sets prompt-cache control: the API codecs send no `cache_control` or
  `cachedContent`. Cache reads come from the providers' automatic caching and the CLIs'
  own; usage reports them per call as cache reads and writes.
- `packages/providers/src/continuation/store.ts` provides optional persistence for
  provider continuation handles. Composed model activities currently disable that store
  and send explicit durable context on each call. Completed recorded turns are reused;
  an interrupted provider request has no guarantee of avoiding additional billed work.

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

## Batch lane

Provider batch APIs are an explicit, opt-in lane (`packages/providers/src/batch/`).
Nothing moves an interactive call onto it: a call uses the lane only when
`workflow.modelExecution.batch.lanes` names its model profile *and* the first segment of
its durable activity ID (for example `semantic-clustering` or `critic`). Everything else,
including every tool loop, stays on the interactive path.

```json
"batch": { "lanes": [{
  "modelProfileId": "cheap-classifier", "activityGroups": ["semantic-clustering"],
  "pollIntervalMs": 60000, "maximumWaitMs": 86400000,
  "maximumItemsPerSubmission": 100, "collectWindowMs": 5000, "maximumAttempts": 2
}] }
```

**Drivers and provenance.** Drivers are keyed by wire transport behind the registry
(`ProviderRegistry.batchDriver`):

| Driver | Transport | Provider API | Uncertain-submission reconciliation |
|---|---|---|---|
| `openai-batch` | `openai-responses` | JSONL file upload, `/v1/batches` for `/v1/responses` | batch `metadata.arbitra_submission_key` via listing |
| `anthropic-message-batches` | `anthropic-messages` | `/v1/messages/batches` | none available; operator only |
| `gemini-batch` | `gemini-native` | `models/{model}:batchGenerateContent`, inline requests | batch `displayName` via listing |

Each driver carries a `BatchCapabilityDeclaration`. **All three are
`declared_unverified`, with `liveValidation: null`:** they were written against the
provider documentation linked in each declaration and exercised against injected HTTP
fakes. A live runner submitted through all three, and every account refused before a job
was created (no credit, or no batch on the Gemini free tier;
[qa/p15-live](qa/p15-live/README.md)). The environment-gated conformance
test requires a `batch:<driverId>` entry per driver. Live validation of every driver is
deferred to the [paid-API bundle](completion-plan.md#deferred-the-paid-api-bundle) (P15). Every
batch trace and submission records the declaration status, so an unverified driver is
never presented as a verified capability. Gemini file-based output is not supported.

**Preflight.** Run validation (`validateBatchLanes`) and `ModelActivities` reject a lane,
before any spend, when the endpoint's transport has no driver
(`BATCH_LANE_UNSUPPORTED_ENDPOINT`, including OpenAI Chat-compatible endpoints), the
profile declares `supports.batch: false` (`BATCH_LANE_MODEL_UNSUPPORTED`) or
`supports.tools: true` (`BATCH_LANE_INTERACTIVE_PROFILE`, because such activities run
tool loops). Each message names the configuration to change. A registered transport is
not proof that a compatible third-party service implements the same batch API.

**Durable state.** Each item and each submission is a separate run artifact
(`model-batch-item-*`, `model-batch-submission-*`). An item records its activity ID,
trace ID, request fingerprint, and per attempt: provider `custom_id`, budget reservation,
submission, state, raw result, error, usage and `late` flag. A submission records its
client key, provider job ID and status, members, timings, cancellation, reconciliation
attempts, operator resolution and anomalies (result lines that matched no member).
Results are matched by `custom_id`, so out-of-order, partial and failed results keep their
item and trace identity; a member without a result line becomes `missing` (or `errored`
with the job failure when the provider failed the whole job).

**No blind resubmission.** A submission is saved as `prepared`, then `sending` before any
request leaves the process. After a crash, `prepared` is provably unsent and is
abandoned; `sending` becomes uncertain. An acknowledgment lost to a network error,
timeout or 5xx is also `uncertain`. The lane reconciles an uncertain submission with the
driver's lookup. A match attaches it to the provider job; not-found (listings can lag),
inconclusive or unsupported lookup keeps it uncertain and fails the waiting activity with
`BATCH_SUBMISSION_UNCERTAIN`. It is never resubmitted automatically; only an operator
decision (see operator resolution below) moves it on. A definite rejection
(4xx, 429, failed upload, encoding error) marks items `not_submitted`. A new attempt
follows only provider-confirmed non-processing (`not_submitted`, `cancelled`, `expired`)
and is bounded by `maximumAttempts`; `errored` and `missing` items are not resubmitted.

**Operator resolution of uncertain submissions.** The CLI and HTTP expose the same
orchestrator operations:

```text
node apps/cli/dist/src/bin.js batches <run-id>
node apps/cli/dist/src/bin.js resolve-batch <run-id> <submission-id> <version> provider_job <provider-job-id> --by=<actor>
node apps/cli/dist/src/bin.js resolve-batch <run-id> <submission-id> <version> not_submitted|abandon --by=<actor>
GET  /runs/:id/batches
POST /runs/:id/batches/:submissionId/resolve   {"version": "<64 hex>", "decision": "provider_job", "providerJobId": "batch_abc", "by": "operator"}
```

The listing returns every submission of the run in preparation order. Each entry has its
state, driver, capability status, the driver's reconciliation support, provider job ID
and status, timings, the recorded submit error, reconciliation attempts and last lookup
result, any operator resolution, anomalies and a content `version`. It also lists each
member's activity ID, trace ID, attempt, state, estimate, reported usage (`null` =
unknown) and whether its reservation moved on. Raw result bodies are omitted. An
`uncertain` submission, or a `sending` one left by a crash, is `resolvable`. The CLI exits
`3` with reasons `batch_submission_uncertain:<id>` while any resolvable submission remains.

A decision names the `version` the operator inspected and an explicit actor (`by`). The
run must not be live in this process. The decision is saved on the submission record
with actor, time, version and job ID, so it survives restart. Each version accepts one
decision. A changed version fails with `BATCH_SUBMISSION_VERSION_STALE` (HTTP 409), for
example after another reconciliation attempt. A second decision fails with
`BATCH_SUBMISSION_NOT_UNCERTAIN` (409). An unknown submission returns 404, and the CLI
exits `2` on all three. No decision submits anything.

| Decision | Effect |
|---|---|
| `provider_job` | Binds the job ID found in the provider console. One status request must succeed first (`BATCH_PROVIDER_JOB_UNVERIFIED`, 409), and a job already bound to another submission is refused (`BATCH_PROVIDER_JOB_ALREADY_BOUND`, 409). Members become `submitted`; resume or reconcile polls and collects the job normally, matching results by `custom_id`, so item and trace identity are kept. |
| `not_submitted` | Declares that the provider never accepted the submission. Members become `not_submitted`. Nothing is refunded: the reservation stays charged and moves to the item's next attempt, which is sent on resume within `maximumAttempts`. |
| `abandon` | Fails the members with non-retryable `BATCH_ABANDONED_BY_OPERATOR`. Their estimates stay charged as unknown spend, and they are never resubmitted. No provider job is cancelled because none is known. |

A wrongly bound job whose results contain no line for a member makes that member
`missing` (unknown spend, not resubmitted). Unmatched result lines are recorded as
anomalies.

**Budget.** Every item reserves its worst-case estimate (input bytes plus output reserve)
through the shared `DurableTokenBudget` before it can join a submission; a refusal
suspends without submitting. Reported per-item usage is recorded against that
reservation. Cancelled, expired, errored and missing items keep their estimate charged as
unknown spend, never zero. The reservation of work that was never sent moves to the next
attempt instead of being charged twice. Monetary cost, including batch discounts,
remains unknown.

**Polling, cancellation and late results.** Polling runs in the lane (an activity-level
component with an injected clock and timer), never in workflow code. If
`maximumWaitMs` passes, the lane requests provider cancellation and fails the waiting
activity with retryable `BATCH_DEADLINE_EXCEEDED`; the job remains recorded. A cancelled
activity marks its item; the provider job is cancelled once every unfinished member has
been cancelled. `ModelActivities.reconcileBatches` collects results that arrive after
cancellation or the deadline and records their usage. A resumed activity reuses a late
result (`late: true` in provenance) instead of submitting again.

## Not yet validated live

- **Live batch validation.** The batch lane and drivers are implemented. A live run was
  refused by every provider before job creation, so no driver is verified live. See
  [Batch lane](#batch-lane).

This is deferred to a later phase as part of the
[paid-API bundle](completion-plan.md#deferred-the-paid-api-bundle) (P15), along with live
conformance of the OpenAI and Anthropic API protocols (P03). The bounded advisor runtime
([Task IR](task-ir.md#advisors)) has been exercised live on Gemini
([qa/p13-live](qa/p13-live/README.md)). The environment-gated gate
(`real-provider.conformance.test.ts`) reads the provenance-bearing observations written by
the live conformance runners, and requires a passed live observation per capability and per
batch driver.

## Large planning and critic contexts

Large critic inputs are partitioned into complete task, accepted issue, and validation
records. Every batch retains the global dependency, routing, traceability, and scope
index; cross-batch record pairs receive additional checks when `review.criticPairChecks`
is set ([one pass per review stage](#one-pass-per-review-stage)). Inputs explicitly identify
partial review scope so omitted batch records are not mistaken for missing plan work.
Feedback IDs are namespaced per durable batch and every item is preserved for validation.
Rejected mappings or duplicate critique IDs mark review coverage degraded. The runtime
records the actual number of critique batches and reuses completed batches on restart.
Global metadata or individual records/pairs that exceed context still fail explicitly.

When accepted issues do not fit a single planner prompt, the same configured planner
reads complete issue batches into explicitly intermediate briefs, produces one global
outline, and expands its task outlines against the full original assigned issues. The
global outline owns validation assertions, issue mappings, decomposition, scope, routing
and dependencies. Expansion may add implementation detail and unresolved questions but
cannot change that outline. Every accepted issue must reach an expanded task; missing
briefs, changed issue IDs, invalid dependencies or dropped unresolved questions fail
validation. New questions receive stable namespaces, and any blocking plan question
fails the run gate even if the critic returns no blocking items.

All phases use the canonical harness, compiled context estimates and shared durable
budgets. Batch manifests, the global outline, composition metadata and logical call
counts persist; provider attempts and spend remain in the trace log. Resume reuses
completed phases. Individually oversized issues, a global outline/index that cannot
fit, or a task assigned more complete issues than it can read still fail explicitly.
The one-call path remains when the initial request fits; output capacity is still
bounded by the configured provider output limit.

The model audit runtime now performs at most one planner revision after a complete,
non-degraded critic review reports blocking findings. The same planner profile returns
a full Plan IR and an explicit resolution for every blocking item. Traceability, exact
accepted issue coverage, audit mode and premise provenance are checked. With
`review.recheckRevisedPlan` a second independent critic review follows: it receives the
original feedback and proposed resolutions as untrusted claims, and remaining blocking
feedback still fails the gate. Without it the resolutions are published with the revision
and are not checked by a model ([one pass per review stage](#one-pass-per-review-stage)).
Original plan/critique, revision output and final review remain durable; restart reuses
completed work. If a complete revision prompt does not fit, the plan is revised in parts.
A call answers the critique items that name the same tasks (at most 12 items, and tasks
filling at most half of the planner's output ceiling when written out again) and reads only
what those tasks need: the tasks in full, an index of every task, the plan header without
its questions, the open questions, validation assertions and issue links of those tasks,
their canonical issues and the files they name. It writes only what it changes
(`planRevisionPatchSchema`): the tasks it rewrites or adds, retired tasks with their
lineage, new questions and assertions, the links of its own issues, and additions to the
plan's notes. A reference elsewhere to a retired task moves to the tasks its lineage names,
and the task graph and routing recommendations are rebuilt from the tasks, so a call never
restates them. New tasks, questions and assertions are renumbered per call. Calls whose tasks
do not overlap run side by side in rounds and are applied in item order; an item whose tasks
span two calls of a round waits for the next round and reads the result. Only selected tasks
may be replaced or retired; unchanged task bodies are preserved, and existing questions are
carried over by the runtime. Explicit lineage keeps later critiques attached to replacement
tasks, including reintroduced work after retirement. Observed live (P20 pilot): one call per
item, each reading and writing the whole plan header (302 open questions, 138,000 characters)
with every neighbouring task in full; for 108 blocking items that was 108 calls one after
another, and the first item already did not fit. Replayed on that run's stored plan and
critique, the same items take 28 calls in 5 rounds, the largest reading 252,000 characters.

Re-review batches keep each prior critique together with its resolution claim and check
those records against every current task, issue and validation record. Missing or
duplicate resolution mappings fail validation. Prior summary text is also retained as
a review record. Patch outputs and batch identities are durable, so interrupted work
reuses completed patches and reviews. A single critique's necessary records, global
metadata, or a required re-review pair that still exceeds context fails explicitly.
All additional calls share the run's provider budgets; no extra revision loop is added.
