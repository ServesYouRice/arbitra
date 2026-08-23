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

Native mode is permitted in principle for Testing execution and whole-ecosystem
benchmarking — both also v1.1.

Nesting orchestrators is a non-goal either way: the intended shape is
`arbitra → vendor CLI harness → model`, never `arbitra → another orchestration graph →
model`, unless that framework is deliberately integrated as a sub-runtime.
