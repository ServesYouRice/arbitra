# Project assessment before model integration

Archived on September 24, 2026. The following is a historical snapshot. Its unchecked
tasks, availability claims, priorities and validation results describe earlier stages
and must not be read as current status or instructions.

See [current project status](../project-status.md) and the
[completion plan](../../WORK-REMAINING.md) for the maintained sources.

---

## Project status

**Arbitra is a well-developed architecture/prototype, but it is not yet the live multi-model orchestration product described by its design.** The important distinction is that most of the lower-level pieces already exist; the production composition root has not connected them together.

Today, the executable product supports **Audit mode using deterministic scripted auditors**. Configuring Feature/Testing execution, real model profiles, or a native harness is explicitly rejected with `RUNTIME_*_NOT_AVAILABLE`. The architecture documentation says this directly. 

More importantly, the production `Orchestrator` confirms it in code. Its model-node executor currently does this:

- discovery → calls local scripted detectors
- planner → calls a local deterministic `plan()` function
- critic → calls a local deterministic `critique()` function
- human node → automatically returns `{ acknowledged: true }`
- graph gate → automatically returns `{ passed: true }`
- checkpoints → always returns an empty array
- configuration rejects any configured real models

So although some graph nodes are classified as `"model"`, **they do not currently invoke an LLM**. 

The current auditors make this especially clear: they are regex/static-analysis rules looking for things such as empty catches, `any`, non-null assertions, work markers, etc. The source explicitly says they are “deterministic static checks, not model auditors” and that they do not test the central Arbitra premise of independent models discovering complementary defects. 

### What is already built

The good news is that this is **not a project where 80% of the architecture exists only in documentation**.

A substantial amount of the difficult infrastructure is already present.

The provider runtime already has production-oriented concepts for transport dispatch, rate limiting, token budgets, retries/backoff, cancellation, continuation state, timeout handling, usage accounting, and tracing. 

The canonical harness is also real code. It has a model/tool loop, invokes a provider runtime, emits model lifecycle events, processes tool calls, enforces maximum tool turns, and returns final model output. 

The intended Audit workflow is quite sophisticated:

> preflight → complexity routing → independent discovery → validation → clustering → issue board → peer review → verification → canonical issues → planner → critic → renderer

That architecture is already documented as the core loop. 

And there is an especially important piece of evidence in `packages/testing/src/fresh-executor.ts`: **almost that entire intended pipeline has already been assembled as an acceptance-test path**. It performs project-context preflight, discovery, validation, deterministic clustering, issue-board construction, peer-review rounds, consensus, deterministic verification, canonicalization, model-shaped planning, critic selection, revision handling, and rendering. 

The catch is that this acceptance path uses **fake model responses**, not real provider-backed execution.

That changes my assessment significantly:

> **Arbitra is primarily missing production integration/composition, not fundamental architecture.**

---

# What must be done to make it run as envisioned

I would prioritize the work in this order.

### P0 — Connect the actual model execution stack

This is the single biggest blocker.

Production `Orchestrator` needs a real model-node executor roughly like:

```text
WorkflowRunner model node
        ↓
resolve ModelProfile
        ↓
compile protocol + prompt + bounded context
        ↓
CanonicalHarnessAdapter
        ↓
ProviderInvocationRuntime
        ↓
provider transport
        ↓
OpenAI / Anthropic / Gemini / etc.
        ↓
normalized structured response
        ↓
schema validation / repair
        ↓
workflow artifact
```

At the moment production effectively does:

```text
WorkflowRunner model node
        ↓
if planner → local plan()
if critic  → local critique()
otherwise  → scripted regex auditor
```

That replacement is the most important piece of work in the entire repository. 

The nice part is that the bottom half of the desired stack already exists: the provider runtime and canonical harness do not need to be invented.  

---

## P0 — Move the full Audit workflow from acceptance testing into the real runtime

There are effectively **two levels of Audit implementation** right now.

Production has the simplified scripted path.

Testing has something substantially closer to the intended architecture.

The acceptance path already demonstrates:

```text
repository
   ↓
project context / preflight
   ↓
multiple discovery agents
   ↓
finding validation
   ↓
deterministic clustering
   ↓
issue board
   ↓
peer review round 1
   ↓
consensus
   ↓
verification
   ↓
peer review round 2 where required
   ↓
canonical issues
   ↓
planner
   ↓
critic
   ↓
revision
   ↓
renderer
```



I would **not build a second implementation of this**.

Instead, extract the orchestration demonstrated by `runAuditAcceptance()` into production workflow composition and make the test use that same production composition with fake providers injected.

That would eliminate one of the project's biggest current risks: divergence between the sophisticated tested architecture and the simpler executable runtime.

---

## P0 — Make discovery actually independent multi-model analysis

This is central to Arbitra's entire premise.

Today, `auditor-a`, `auditor-b`, and `auditor-c` are just different combinations of deterministic static rules. 

They need to become actual independent model executions with deliberately isolated contexts.

For example:

```text
Auditor A → GPT-family model
Auditor B → Claude-family model
Auditor C → Gemini-family model
```

or at least genuinely separate model profiles / independence groups.

Each receives:

- repository/project context
- assigned inspection scope
- audit protocol
- relevant source
- tool definitions
- evidence requirements
- strict output schema

but **not the findings of the other auditors during initial discovery**.

That is the product's differentiating behavior.

---

## P0 — Make Planner and Critic genuine model stages

Production currently labels Planner and Critic as model nodes, but the runner invokes ordinary TypeScript functions rather than the harness/provider stack. 

These should become:

```text
canonical issues
     ↓
Planner model
     ↓
PlanIR / ValidationContract / Task DAG
     ↓
independent Critic model
     ↓
blocking/non-blocking critique
     ↓
one bounded revision
     ↓
Renderer
```

The acceptance test is already much closer to this interface. 

The independence requirement matters: ideally the critic should not simply be the exact same model/configuration that generated the plan.

---

# P1 — Turn checkpoints and human intervention into real runtime concepts

This part currently looks like scaffolding.

`RunResource` declares:

```ts
checkpoints: readonly never[]
```

and every returned run resource contains:

```ts
checkpoints: []
```

The runner's human executor simply returns:

```ts
{ acknowledged: true }
```

 

For the intended control-plane experience, it needs something closer to:

```text
RUNNING
   ↓
checkpoint encountered
   ↓
SUSPENDED
   ↓
UI exposes:
   approve / reject / modify / continue
   ↓
decision persisted
   ↓
RESUMING
   ↓
workflow continues
```

This should be durable, because the rest of Arbitra is clearly designed around durable/replayable runs.

---

# P1 — Replace the placeholder graph gate

There are actually two concepts here.

The public `gate(runId)` method performs meaningful checks such as unresolved issues and incomplete coverage.

But the workflow runner's `gate` executor currently just returns:

```ts
{ passed: true }
```



Those need to converge into one authoritative policy mechanism.

Otherwise the graphical workflow can say one thing while the run-level quality gate says another.

---

# P1 — Wire budgets, usage and provider failures into workflow semantics

The provider runtime already has surprisingly good infrastructure:

- token reservation
- actual usage recording
- retries
- retry-after handling
- provider rate limiting
- continuation state
- timeout handling
- cancellation
- resumable provider failure
- per-attempt trace records



Once providers are connected to the runner, those conditions have to propagate properly upward.

For example:

```text
budget exhausted
→ SUSPENDED_BUDGET

provider temporarily unavailable
→ retry
→ if exhausted, preserve artifacts
→ resumable failure

operator cancel
→ abort active provider request
→ persist cancellation

context/token limit encountered
→ deterministic reduced scope or explicit degradation
```

This is much better than letting provider errors emerge as generic node exceptions.

---

# P1 — Real structured-output validation and repair

This is essential once fake model responses become live model responses.

Every AI-producing stage should behave roughly like:

```text
model output
   ↓
parse JSON/schema
   ↓
valid?
 ┌─┴───────────┐
yes            no
 ↓              ↓
persist      bounded repair
                ↓
            valid?
             ↓   ↓
           yes   no
            ↓     ↓
        persist  reject/fail/degrade
```

This is particularly important for:

- discovery findings
- peer-review operations
- verification escalation
- PlanIR
- critic output
- requirements output

The deterministic validation layer already gives the project a strong basis for this.

---

# P1 — Enable Feature mode

Feature-mode components exist, but production explicitly refuses every non-Audit run:

```ts
if (config.mode !== "audit")
    throw new Error(`RUNTIME_MODE_NOT_AVAILABLE:${config.mode}`);
```



So Feature is currently more of a library/schema capability than a usable product capability.

After the generic model-node executor exists, Feature should become much cheaper to enable because it can reuse:

```text
provider runtime
canonical harness
prompt/compiler
model profiles
planner
critic
renderer
durability
tracing
budgeting
```

The architecture also explicitly says Feature is not yet fully composed end to end. 

---

# P1/P2 — Enable Testing mode

Same basic situation: useful node/library work exists, but executable Testing mode is blocked.

There is an important scope distinction, though.

The architecture identifies **autonomous Testing execution**—actually modifying a worktree and running commands inside a write/egress sandbox—as a v1.1 extension rather than completed v1 functionality. 

So I would split this into:

```text
Testing analysis/planning        → reasonable near-term target
Autonomous test implementation   → later sandboxed execution work
```

Do not make writable autonomous execution a prerequisite for proving the core Arbitra idea.

---

# P1 — Run against actual providers and measure whether the premise works

The architecture lists the largest known gap very succinctly:

> **The premise is unmeasured on real models.**



This is arguably as important as finishing the code.

Arbitra's hypothesis is approximately:

> multiple independently operating models + deterministic reconciliation + verification produces more trustworthy analysis than one model doing everything.

That needs empirical proof.

I would create a corpus containing known defects and compare at least:

```text
A. Single strong model
B. Same model × 3 independent runs
C. Three heterogeneous models
D. Arbitra full consensus/verification pipeline
```

Measure:

- defect recall
- precision / false positives
- unique defects discovered
- severity correctness
- evidence correctness
- verification accuracy
- plan correctness
- token cost
- latency
- disagreement rate
- defects found only through multi-model diversity

Without that evaluation, it is possible to build the entire architecture and still not know whether the additional orchestration earns its cost.

---

# P2 — Real provider conformance should become routine

There is provider infrastructure, but live-provider operation should eventually become an automated readiness criterion.

For each supported provider/model combination, test:

```text
basic call
structured output
tool calling
refusal handling
timeouts
cancellation
rate limiting
retry behavior
usage accounting
continuation
context limits
schema violations
credential redaction
```

This doesn't necessarily belong in every normal PR CI run because of cost and credentials. A credentialed scheduled/nightly suite is appropriate.

---

# P2 — Native harness support

The canonical harness exists and is enough to get the first real product running.

The architecture explicitly says native harness adapters are not implemented; `canonical/adapter.ts` is currently the only implementation. 

So I would **not block the first production milestone on native harnesses**.

Get everything working through canonical first.

Then native harness integrations can be added where provider-specific capabilities justify them.

---

# The shortest route to a real Arbitra

I would resist trying to finish Feature, Testing, native harnesses, advisor runtime, batch APIs, and the UI simultaneously.

The shortest path is:

1. **Audit only.**
2. **Canonical harness only.**
3. Support one real provider first.
4. Replace scripted discovery with 2–3 genuine independent model profiles.
5. Move the rich Audit sequence demonstrated in `runAuditAcceptance()` into the production runtime.
6. Make Planner a real model call.
7. Make Critic a genuinely independent model call.
8. Keep clustering/validation/verification deterministic wherever possible.
9. Persist provider usage, model identity, prompt/protocol identity and traces.
10. Run it against a benchmark repository containing known defects.
11. Only then add additional providers.
12. After Audit is solid, unlock Feature and Testing.

That milestone would produce the first run that actually validates the project's thesis:

```text
                  Repository
                      │
                deterministic
                   preflight
                      │
            ┌─────────┼─────────┐
            ↓         ↓         ↓
        Model A    Model B    Model C
            │         │         │
            └─────────┼─────────┘
                      ↓
                Validation
                      ↓
                 Clustering
                      ↓
                 Issue Board
                      ↓
                Peer Review
                      ↓
             deterministic/
             tool verification
                      ↓
              Canonical Issues
                      ↓
                 Planner LLM
                      ↓
                 Critic LLM
                      ↓
                  Renderer
                      ↓
           implementation package
```

At that point, I would consider **Arbitra genuinely running according to its core vision**.

---

## My assessment of completeness

I would characterize the project approximately like this—not as percentages of source code, but of product capability:

| Area | Status |
|---|---|
| Schemas/contracts | **Strong** |
| Workflow primitives | **Strong** |
| Deterministic validation/clustering | **Strong** |
| Persistence/replay architecture | **Strong** |
| Provider runtime | **Substantially implemented** |
| Canonical harness | **Implemented** |
| Audit acceptance workflow | **Substantially implemented with fake models** |
| CLI/server/web control plane | **Implemented around current runtime** |
| Production real-model composition | **Missing — critical blocker** |
| Real multi-model Audit | **Not operational** |
| Real Planner/Critic | **Not operational in production** |
| Human checkpoints | **Scaffolding / incomplete** |
| Feature E2E | **Not operational** |
| Testing E2E | **Not operational** |
| Real-model effectiveness evidence | **Missing** |

So I would describe Arbitra as **an advanced pre-alpha / integration-stage system**, not an early toy and not yet a functioning version of the advertised multi-model product.

### The most important architectural insight

There is already enough code in this repository that I would **avoid another large build phase**.

The next phase should be a **composition phase**:

> **Make `packages/runtime` use the architecture that `packages/testing` is already proving.**

Specifically, the acceptance executor is currently much closer to the desired system than the production `Orchestrator`. 

Then substitute the fake model runtime with:

**CanonicalHarnessAdapter → ProviderInvocationRuntime → real transport.**

Those components already exist.  

That is the bridge between **“Arbitra has all these sophisticated pieces”** and **“Arbitra actually orchestrates multiple AI models on a real repository.”**

If I were deciding what to build next, the **#1 concrete deliverable** would be a single command such as:

```bash
arbitra audit --config real-audit.json --repo ./some-project
```

where the trace proves that three genuine independent model calls occurred, their findings were validated and reconciled, disputed findings were verified, a real planner produced PlanIR, a separate critic reviewed it, all usage/costs were persisted, and the final artifacts were rendered—**with no scripted auditors and no `RUNTIME_*_NOT_AVAILABLE` path involved**. That one milestone would transform the project from an architectural prototype into the first real version of the envisioned product.

