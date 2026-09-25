# Harness

A *harness* is whatever owns the tool loop around a model call. arbitra's default is the
canonical harness. One native adapter (Claude Code, headless) implements the same port for
the Testing writer only; see [Native harness adapters](#native-harness-adapters).

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

`packages/harness/src/canonical/adapter.ts` (`CanonicalHarnessAdapter`) is the canonical
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
Testing selection 120, Feature review 150, Testing risk 250 per path, requirements record 200,
Feature exploration 300 tokens per record). After spend, every transport
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
| Global planner outline (all modes) | `PLANNER_GLOBAL_CONTEXT_LIMIT_EXCEEDED` | Hierarchical outline: section outlines, one header pass, cross-section link passes, scoped expansions |
| Feature requirements draft output | `MODEL_OUTPUT_LIMIT_REACHED:feature/requirements` | Durable requirement index, then complete record batches |
| Feature exploration | Single call; `MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED` | Requirement-record batches merged by surface identity |
| Testing risk analysis | Single call; `MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED` | Path partitions with complete files, merged verbatim |

How the four newer paths compose:

- **Hierarchical outline.** When `planner/outline` cannot fit (input or output), briefs are
  grouped into `planner/outline/section/<ids>` requests over disjoint record groups. Each section
  is a `plannerOutlineSchema` outline with local `TASK`/`VAL` IDs that addresses, validates and
  links only its own records and keeps each supplied brief question verbatim. Sections that break
  scope, references or questions are rejected. The merge renumbers IDs globally and scopes new
  question IDs to their section. One `planner/outline/header` pass writes the plan header; section
  strategies and concerns are kept alongside it. `planner/outline/links` passes add cross-section
  dependencies: one pass over all sections when they fit, otherwise one pass per section pair so
  every pair is checked. The merged outline then goes through the usual traceability, cycle and
  question checks. If the full outline does not fit a task expansion, that expansion reads a
  scoped outline: the task's dependency neighbourhood, its validation and links, its section's
  questions, and a complete task index (`planner/expand/<task>/scoped`).
- **Requirements drafting.** If the one-call draft is output-limited, `requirements/index`
  records every requirement ID, kind and scope exclusion. `requirements/records/<ids>` batches,
  sized by `OUTPUT_TOKENS_PER_RECORD.requirementsRecord` (200), then write complete records for
  exactly their indexed IDs. The kinds must match and every ID must be answered exactly once. The
  merged draft follows index order.
- **Exploration.** Assumptions, ambiguities and acceptance records are explored in batches
  (`exploration/batch/<ids>`, 300 output tokens per record). Every batch keeps the request, scope
  exclusions and a complete requirement index. Surfaces with the same ID merge by union of paths,
  risk categories and requirement links. Exact evidence is deduplicated, never dropped, and
  re-validated against the snapshot. Batch metrics merge as upper bounds so routing never
  under-reports risk: migration is OR, breadth and testing complexity are summed, and the
  sensitive-surface count is summed and capped at the surface count.
- **Risk analysis.** Source and test paths are partitioned in path order, 250 output tokens per
  path (`testing/risk/<fingerprint>/batch-<paths>`). A multi-path partition must carry every
  assigned file whole. A single path larger than the budget is admitted alone with excerpted
  source and read-only tools. Each partition sees its scoped inventory and global counts, and may
  claim only its own paths as reviewed. Surfaces, evidence, reviewed paths and limitations merge
  verbatim. A surface ID repeated in another partition gets a `<id>@<partition digest>` suffix
  instead of being merged. Gap-selection batches now scope source-path lists to their own
  surfaces, so a large inventory no longer blocks selection.

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
- `PLANNER_OUTLINE_RECORD_CONTEXT_LIMIT_EXCEEDED:<id>`: one brief plus the outline context does
  not fit a section. `PLANNER_OUTLINE_SECTION_PAIR_CONTEXT_LIMIT_EXCEEDED:<a>:<b>`: the task
  outlines of two sections cannot share one link pass. `PLANNER_OUTLINE_HEADER_CONTEXT_LIMIT_EXCEEDED`:
  the compact section headers (titles, strategies, concerns and task titles) do not fit one
  header pass.
- `FEATURE_REQUIREMENTS_RECORD_CONTEXT_EXCEEDED:<id>`, `FEATURE_EXPLORATION_REQUIREMENT_CONTEXT_EXCEEDED:<id>`
  and `TESTING_RISK_PATH_CONTEXT_EXCEEDED:<path>`: one requirement record or path does not fit
  with the stage's global context (request, index or scoped inventory).
- `FEATURE_REQUEST_CONTEXT_LIMIT_EXCEEDED`: the feature request itself does not fit one context.
  The request is mandatory global context in every Feature stage (requirements, review,
  exploration, planning, criticism), so splitting it for drafting alone would not let the run
  finish. If the requirements index itself is output-limited
  (`MODEL_OUTPUT_LIMIT_REACHED:feature/requirements/requirements/index`), the IDs and titles of
  all requirements do not fit one response. Both fail explicitly.
- `MODEL_OUTPUT_CAPACITY_INSUFFICIENT:<stage>`: output capacity is below the reserve for one
  record. `MODEL_OUTPUT_LIMIT_REACHED:<activityId>`: one record's output exceeded the ceiling.
- Discovery lines longer than the whole budget are reported as `unexaminedDueToBudget:
  <path>:<line>` with the `lines_exceed_discovery_context_budget` limitation.

Not yet staged (single mandatory global context):

- Feature requirements revision still makes one call. Its mandatory input (contract, blocking
  decisions and exploration) must fit, and its structured output must fit one response. It fails
  with `MODEL_REQUIRED_CONTEXT_LIMIT_EXCEEDED` or `MODEL_OUTPUT_LIMIT_REACHED:<activityId>`.
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
or outline index (section, header or section pair) does not fit, raise `maximumOutputTokens`
for output-capacity failures, or
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

## Native harness adapters

`harness.mode: "native"` delegates **only the stages listed in the support matrix** to a
native harness. Every other stage keeps running canonical, explicitly. Configuration,
host setup and diagnostics are in [setup.md](setup.md#native-mode).

### Support matrix

`packages/harness/src/native/support.ts` (`NATIVE_HARNESS_SUPPORT`):

| Harness | Versions | Stages | Status | Executable | Credential |
|---|---|---|---|---|---|
| `claude-code` (headless `claude -p --output-format stream-json`) | `>=2.0.0 <3.0.0` | `testing-writer` | `declared_unverified` | `ARBITRA_CLAUDE_CODE_EXECUTABLE` (host env, absolute path) | `apiKeyEnvVar` → `ANTHROPIC_API_KEY` |

`declared_unverified` means the adapter is implemented and tested against a scripted
stand-in process that emits the documented event stream (`native/stand-in.ts`), but no run
against the actual CLI has been recorded. The opt-in conformance test
(`packages/runtime/test/native-harness.conformance.test.ts`, gated by
`ARBITRA_NATIVE_HARNESS_CONFORMANCE=1`) is that run; it is skipped otherwise, never passed.
Anything not in the matrix is refused before a run exists: Audit
(`NATIVE_HARNESS_DISCOVERY_FORBIDDEN`), Feature and planning-only Testing
(`NATIVE_HARNESS_MODE_UNSUPPORTED`), other harnesses, stages or versions
(`NATIVE_HARNESS_UNSUPPORTED`, `NATIVE_HARNESS_STAGE_UNSUPPORTED`,
`NATIVE_HARNESS_VERSION_UNSUPPORTED` from the pre-run `--version` probe), and any tool that
cannot be bounded (`NATIVE_HARNESS_TOOL_UNENFORCEABLE`: shell, network, subagent, MCP or
unknown tools). Permitted tools are Read, Glob, Grep, LS, Edit, MultiEdit and Write.

The native profile (`native:claude-code`) declares `managesContextInternally: true` and
`writeFiles: true`, so the port itself rejects it for Audit (`AUDIT_INTERNAL_CONTEXT_FORBIDDEN`)
and round zero (`ROUND_ZERO_POLICY_VIOLATION`). Canonical independent discovery keeps its
strict baseline unchanged.

### Translation layer

`packages/harness/src/native/claude-code/translation.ts` holds every Claude Code-specific
assumption — flags, environment variables, `--version` format, stream-json event shapes,
usage buckets and tool names — as numbered checkpoints A1–A8. It is marked
`verified: false`. The adapter (`claude-code/adapter.ts`) maps the stream to the shared
`HarnessEvent`s: `harness_started` (session and reported model), `model_turn_started` /
`model_turn_completed` per assistant message, `tool_call` / `tool_result` (results are
`trust: "untrusted"` and framed), and `completed` with the harness-reported total usage.
Invalid JSON or a known event with the wrong shape is `NATIVE_HARNESS_MALFORMED_EVENT`;
unknown event types are ignored.

### Shape of a native run

The native CLI is an activity under the existing Testing writer node, not a second
orchestrator: `arbitra → Testing writer activity → claude -p → model`. For each attempt,
`nativeTestingWriter` (`packages/runtime/src/native-testing-writer.ts`):

1. Validates the matrix, stage, tools, writer model provider and lease (harness control
   paths such as `CLAUDE.md`, `.claude/` and `.mcp.json` can never be leased).
2. Pins its input (redacted snapshot, omitting harness control files) and probes the
   executable's version.
3. Reserves `maximumTokensPerRun` against the shared run token budget, then durably records
   the dispatch and its scratch directory **before** launching anything.
4. Runs the CLI in a fresh scratch copy under the system temp directory — never the Testing
   worktree or the source checkout — with a sanitized environment (PATH, a scratch
   `HOME`/`CLAUDE_CONFIG_DIR`/`TMPDIR`, non-essential traffic disabled, and the one
   configured credential). The prompt goes on stdin. Write tools are allowed only as
   `Tool(./<leased path>)`.
5. Checks every streamed event: a tool not granted, a tool path outside the scratch copy, a
   write tool targeting a non-leased path, more tool calls than `maximumToolCalls`, more
   turns than `maximumTurns`, streamed usage above `maximumTokensPerRun`, an active MCP
   server, a subagent message or a malformed event stops the **whole process tree**.
   Timeout and cancellation do the same.
6. After the process exits, diffs the scratch copy against its seed. Any change outside the
   lease, any deletion, symlink, non-UTF-8 or oversize file rejects the whole run. Otherwise
   the changes are journaled and admitted only through `TestingWorkspace.write` under the
   task's lease, with stable operation IDs.
7. Removes the scratch directory on every path.

A failed run (crash, timeout, violation, rejected change, cancellation) admits nothing
and returns the limitation `native_harness_failure:<code>`, so verification records the
attempt as `incomplete`; it consumes the attempt and never promotes. Cancellation also
propagates. Independent sandbox verification is unchanged.

### Recovery

The run journal (`native-writer-run-*`) is written before launch. On restart, a run still
marked dispatched is treated as interrupted: its scratch copy is removed
(`recoverNativeWriterResources` also sweeps them before a Testing batch dispatches), nothing
is admitted, and the attempt ends with `NATIVE_HARNESS_INTERRUPTED`. A run that was
collected but not fully admitted is admitted exactly once from its journal without
restarting the CLI. An orphaned CLI process from an abrupt host exit is not killed by
recovery (its PID is not trusted across restarts); it can only write into its deleted
scratch copy.

### Identity, usage and measurement separation

Each run records a model-activity trace with `harnessId: "native:claude-code"`, the probed
CLI version as `harnessVersion`, a policy hash covering the profile, tools, bounds and
translation version, and `transportId: "native:claude-code-stream-json"`. Usage is the
harness-reported total when complete, otherwise `null` (unknown). The budget reservation
stays charged at `maximumTokensPerRun` until measured usage replaces it; partial usage never
lowers it. The harness's own cost figure is kept in the run's event artifact only;
`costUsd` stays `null`.

`packages/harness/src/measurement.ts` classifies any `native:` identity as a native
measurement. Premise scoring refuses native auditors
(`NATIVE_MEASUREMENT_NOT_POOLABLE:premise:…`), evaluation rows carry `measurementClass`, and
the evaluation corpus already refuses to aggregate across harness identities unless grouped.

### Limits of enforcement

The native process runs as the host user without an OS sandbox (`sandbox: false`). Writes
cannot reach the worktree: they are collected from the scratch copy and admitted only
through the lease. Reads are confined by the harness's own permission rules and detected
from tool events; a read outside the scratch copy stops the run, but it is detected after
the tool call is announced, not prevented. Tool arguments other than `file_path`,
`notebook_path` and `path` (for example a Glob `pattern`) are not inspected. Managed
enterprise settings installed on the host still apply to the CLI.

Nesting orchestrators is a non-goal either way: the intended shape is
`arbitra → vendor CLI harness → model`, never `arbitra → another orchestration graph →
model`, unless that framework is deliberately integrated as a sub-runtime.
