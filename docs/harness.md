# Harness

A *harness* is whatever owns the tool loop around a model call. arbitra ships exactly one —
the canonical harness — and defines the port a native harness would implement.

## Why the canonical harness exists

Independent discovery only means something if every auditor ran under identical conditions.
If auditor A runs inside a vendor CLI that silently reads project instruction files,
carries session memory, spawns subagents and manages its own context window, while auditor
B runs a plain API call, then a disagreement between them is not evidence about the
repository. It is evidence about the harnesses.

So round-zero discovery runs under one harness, with everything that could differentiate
the two switched off.

## `ROUND_ZERO_POLICY`

`packages/harness/src/profile.ts`:

```text
projectInstructions: "disabled"
network:             "none"
memory:              "none"
subagents:           false
advisor:             false
```

`assertRoundZeroPolicy` throws `ROUND_ZERO_POLICY_VIOLATION` if a profile relaxes any of
those, or if it grants `writeFiles`, `skills` or `subagents`. It is a runtime assertion, not
a convention.

Bounded advisors ([Task IR](task-ir.md#advisors)) exist only outside discovery. The advisor
runtime and `ModelActivities` both reject advisor calls for round zero or a discovery
activity, and an advisor call can never be a tool-bearing harness turn.

Project instruction files — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` — may be **inspected as
repository evidence**. They never become higher-priority instructions during an audit. That
distinction is enforced upstream by the trust and framing rules in
[`security.md`](security.md), and downstream by disabling project instructions here.

## `CANONICAL_HARNESS_PROFILE`

```text
id: "arbitra-canonical"   version: "1.0.0"   kind: "canonical"

readFiles                true      writeFiles               false
shell                    false     skills                   false
hooks                    false     mcp                      false
subagents                false     sandbox                  false
resumableSessions        false     structuredEvents         true
enforcesExternalPolicy   true      managesContextInternally false
reportsUsage             true
```

Read-only, no shell, no extensions, and — critically — it does **not** manage context
internally. `assertHarnessCompatible` throws `AUDIT_INTERNAL_CONTEXT_FORBIDDEN` for any
audit-mode profile that does, because a harness that decides for itself what the model sees
makes the context policy in `packages/workflow/src/context-policy.ts` a suggestion.

`assertHarnessCompatible` also enforces declared requirements: a mode that requires
`structuredEvents`, `enforcesExternalPolicy` or `reportsUsage` fails with
`HARNESS_CAPABILITY_REQUIRED:<capability>` against a profile that lacks it. Compatibility is
explicit and versioned — never inferred from protocol shape, and never assumed because a
model and a harness share a vendor.

## The adapter port

`packages/harness/src/adapter.ts` defines the boundary in terms the orchestrator owns
rather than any vendor's SDK:

```text
HarnessPrompt          text + hash
HarnessNode            id, modelId, maximumOutputTokens, maxToolTurns
HarnessToolDefinition  name, description, inputSchema
HarnessToolRuntime     invoke(name, args, context)
HarnessToolContext     protect(), moduleForPath(), riskSurfacesForPath(), byte caps
HarnessToolResult      ok, summary, content, artifact, truncated, trust: "untrusted"
HarnessModelRequest    messages, tools, maximumOutputTokens
HarnessModelResponse   text, toolCalls, refusal, usage
HarnessProviderRuntime invoke(request, { nodeId, turn, promptHash, signal })
HarnessRunPolicy       mode, round, requirements, signal, toolContext
```

Two details carry weight. `HarnessToolResult.trust` is the literal `"untrusted"` — a tool
result cannot be constructed as trusted. And `HarnessToolContext.protect` is the framing
hook, so untrusted content is wrapped at the point it enters the loop rather than
remembered about later.

`packages/harness/src/canonical/adapter.ts` (`CanonicalHarnessAdapter`) is the only
implementation. It owns the bounded tool loop: `maxToolTurns` and `toolLoopLimit` are
enforced, and `AbortSignal` makes cancellation real rather than advisory.

The CLI/server model Audit composes this adapter in `packages/runtime/src/model-harness.ts`.
Each model turn is a durable activity. Snapshot tools expose list, read, literal search
and stat operations; artifact reads are restricted to outputs from the current activity.
They provide no shell, writes or live repository access. Tool results preserve errors,
truncation and artifact references. Run artifacts retain compiled prompts, harness events
and inspection footprints.

## Context and output capacity

Every model stage is admitted against a bounded budget before any spend. The input budget
is 80% of `min(modelExecution.maximumContextTokens ?? 128000, profile.limits.contextTokens)`,
measured as a conservative UTF-8 byte estimate of the compiled prompt, tool definitions and
the full `maximumOutputTokens` reserve. Output capacity is
`min(maximumOutputTokens, profile.limits.maxOutputTokens)`. Both are computed by
`stageBudget` in `packages/runtime/src/context-budget.ts`.

Source files are always optional context: `allocateModelContext` keeps every decision and
evidence record whole and excerpts or omits repository files (recording `contextCoverage`),
which the model can still read through read-only snapshot tools. Mandatory records are never
truncated. When they do not fit, the stage is recomposed:

- **Batched records with global indexes.** Each batch carries complete records plus an
  index of every other record identity and relationship. Merged results are validated for
  exact coverage (every record decided exactly once).
- **Exhaustive pair coverage.** Record batches are followed by pair checks for every pair
  separated by the partition (`peerReviewBatches`). When two complete records cannot share a
  context, one stays complete and the other is read as exact consecutive segments of its
  canonical JSON (`segmentText`, at most 16 segments); concatenating the segments restores the
  record byte-for-byte.
- **One global planner.** `planWithContext` reads complete records in brief batches, owns a
  single global outline (validation, decomposition, dependencies, requirement links), then
  expands each task against its complete original records. Audit plans trace accepted issues;
  Feature and Testing plans trace requirement IDs (`PlannerRecordSet`,
  `requirement-records.ts`).
- **Atomic revision patches.** `reviseWithContext` applies one patch per blocking critique over
  the complete selected tasks and their neighbours, with mode-specific traceability.
- **Exact line windows.** Discovery reads a file larger than the whole budget as windows of
  original line numbers with a 20-line overlap; evidence is validated against the whole file.

Output capacity is handled twice. Before spend, stages that emit one decision per record cap
batch sizes with `OUTPUT_TOKENS_PER_RECORD` (peer review 160, critic 60, planner brief 400,
Testing selection 120, Feature review 150 tokens per record). After spend, every transport
maps a provider stop at the output ceiling (`max_tokens`, `incomplete/max_output_tokens`,
`length`, `MAX_TOKENS`) to a non-retryable `OUTPUT_LIMIT` error rather than accepting or
repairing a truncated prefix. `ModelHarness` records a durable `model-output-limit-*` marker
and throws `MODEL_OUTPUT_LIMIT_REACHED:<activityId>`. Staged compositions treat a marked
activity as not fitting and replan (`replanOnOutputLimit`); completed activities are durable
and reused, and a marked activity is never invoked again, including after restart.

Staged activity IDs are derived from record identities, so interrupted stages resume
without repeating completed model work. When the one-call request fits, the original
activity ID, prompt and context artifact are unchanged.

### Oversized-context inventory

| Stage | Before | Now |
|---|---|---|
| Discovery: file larger than budget | Whole file listed in `unexaminedDueToBudget` | Exact line windows; `file_context_split:<path>` limitation |
| Audit peer review: candidate pair too large | `PEER_PAIR_CONTEXT_LIMIT_EXCEEDED` | Segmented pair check; merges from segments of one pair deduplicated |
| Audit critic: record pair too large | `PEER_PAIR_CONTEXT_LIMIT_EXCEEDED` | Segmented pair check |
| Audit peer/critic/planner/revision output | Truncation reported as malformed JSON | Per-record output batching, truncation detection, durable replanning |
| Feature targeted review | Single call; `MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED` | Per-reviewer requirement batches merged into one validated review |
| Feature planner | Single call; `MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED` | Staged brief/outline/expansion over requirement records |
| Feature critic and re-review | Single call; `MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED` | Partitioned critic over tasks, validations, requirements and exploration surfaces |
| Feature plan revision | Single call; `MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED` | Atomic per-critique patches with scoped requirement records |
| Testing gap selection | `TESTING_SELECTION_CONTEXT_EXCEEDED` | Candidate batches with global candidate/surface indexes |
| Testing planner | Single call; `MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED` | Staged brief/outline/expansion over selected-gap records |

### Remaining explicit limits

These fail explicitly and name the record or stage. None is resolved by silent omission.

Irreducible with the current record model (a single mandatory unit exceeds the budget):

- `PEER_CANDIDATE_CONTEXT_LIMIT_EXCEEDED:<id>`: one complete peer candidate or critic record
  plus its global index does not fit. `PEER_PAIR_CONTEXT_LIMIT_EXCEEDED:<a>:<b>`: even 16
  segments of one record cannot share a context with the other complete record.
- `PLANNER_ISSUE_CONTEXT_LIMIT_EXCEEDED:<id>` and `PLANNER_TASK_CONTEXT_LIMIT_EXCEEDED:<task>`:
  one complete issue/requirement record, or one task expansion with its records and the global
  outline, does not fit. `PLANNER_REVISION_ITEM_CONTEXT_LIMIT_EXCEEDED:<critique>`: likewise
  for one atomic revision patch.
- `TESTING_SELECTION_CANDIDATE_CONTEXT_EXCEEDED:<gap>`, `FEATURE_REVIEW_REQUIREMENT_CONTEXT_EXCEEDED:<id>`:
  one candidate or requirement with its grounded context does not fit.
- `MODEL_OUTPUT_CAPACITY_INSUFFICIENT:<stage>`: output capacity is below the reserve for one
  record. `MODEL_OUTPUT_LIMIT_REACHED:<activityId>`: one record's output exceeded the ceiling.
- Discovery lines longer than the whole budget are reported as `unexaminedDueToBudget:
  <path>:<line>` with the `lines_exceed_discovery_context_budget` limitation.

Not yet staged (single mandatory global context):

- `PLANNER_GLOBAL_CONTEXT_LIMIT_EXCEEDED`: all record briefs plus the outline context must
  fit one outline request; a hierarchical outline is not implemented.
- Feature requirements generation, requirements revision and exploration, and Testing risk
  analysis each make one call whose mandatory input (request/contract/inventory) must fit and
  whose structured output must fit one response. They fail with
  `MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED` or `MODEL_OUTPUT_LIMIT_REACHED:<activityId>`.
  Merging independently explored surfaces and risk metrics is not yet defined.
- Audit semantic clustering, targeted verification and conflict resolution make one call per
  pair, candidate or conflict; their mandatory records must fit.
- Tool-history archival (`MODEL_HISTORY_REFERENCE_LIMIT_EXCEEDED`) requires the initial
  prompt and one archive reference to fit.
- Snapshot policy limits (`REPOSITORY_FILE_TOO_LARGE`, 512 KiB per file;
  `REPOSITORY_FILE_LIMIT_EXCEEDED`) and provider admission limits
  (`MODEL_CONTEXT_LIMIT_EXCEEDED`, `MODEL_OUTPUT_LIMIT_EXCEEDED`,
  `REQUEST_EXCEEDS_PROVIDER_TPM`) are configuration bounds, not composition failures.
- Guarded Testing execution writers keep their own bounded tool contexts.

Actions: raise `maximumContextTokens` or the profile's `contextTokens` when a single record
or global outline does not fit, raise `maximumOutputTokens` for output-capacity failures, or
narrow the source scope. Overlapping discovery windows may report one defect twice;
deterministic clustering merges findings with the same path, overlapping lines and matching
category, and any other duplicate remains visible rather than being dropped. Output reserves
are conservative estimates, not measured token counts. The staged Feature and Testing paths
are covered by injected-provider fixtures; live-provider behavior at real context limits
still requires P03 evidence.

## Model × harness

Model and harness are independently selectable where compatibility is known. A model does
not have to use its vendor's harness, and the canonical harness is the default for every
mode. `harness.profileId` in the run configuration selects a profile; `harness.mode`
selects `canonical` or `native`.

## Native mode is not implemented

`harness.mode: "native"` is accepted by `runConfigSchema` and **there is no native adapter
behind it**. No document in this set shows native mode as working. It is v1.1.

The restrictions it would have to satisfy for independent discovery are specified now, so
the deferred work is legible:

```text
projectInstructions  disabled
userMemory           disabled
skills               audit-approved-only
subagents            disabled
advisor              disabled
network              disabled
writeAccess          false
peerAccess           false
```

Guarded Testing execution already works through the canonical Testing harness.
Native Testing adapters and separate harness comparisons remain future work; no native
mode can bypass write authority or be silently mixed into canonical independence
measurements. Adapter implementation and live conformance are tracked in
[P12](completion-plan.md#p12--implement-native-harness-adapters).

Nesting orchestrators is a non-goal either way: the intended shape is
`arbitra → vendor CLI harness → model`, never `arbitra → another orchestration graph →
model`, unless that framework is deliberately integrated as a sub-runtime.
