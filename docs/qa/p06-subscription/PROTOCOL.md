# P06 premise evaluation on subscription models: prespecified protocol

Protocol `arbitra-p06-premise@2.0.0`. It was written and committed before any run of this version. The machine-readable version is [protocol.json](protocol.json), and the driver (`packages/testing/src/premise-evaluation/`) runs exactly that file.

Version 1 ([docs/qa/p06](../p06/PROTOCOL.md)) stays as it was. Its interim results are never pooled with this version's.

**Why a new version.** The owner tests only on subscription models, through the vendors' own CLIs. Version 1 was prespecified with Gemini API models on a free-tier key, and cannot finish under that policy. Moving to other models changes the protocol, so it needs a new version.

| Input | sha256 |
|---|---|
| `docs/qa/p06-subscription/protocol.json` | `52314dd505e109877ca23e2430fc5550046368beec5ca604dab0ed617794aa7b` |
| `docs/qa/p06-subscription/configs/audit-mixed-providers.json` | `f7573e30aad431e343892f9ee96d39cc7169ab6e387f7bb58faa2af037fcfd76` |
| `docs/qa/p06-subscription/bindings.json` | `99b9cb627ccc2c45f8745454067d83f355090968143ed634216f5511045fa369` |
| `docs/qa/p06/ground-truth/live-fixture-v1.json` | `3464c1df7a792acffe95017f7b86311ef469e280626d10c32415effb9d4d83a6` |
| `packages/testing/corpora/premise/ground-truth.json` | `fbc179b1a5bc3dc945c067b98dc244a75b71d17522e697b2ef3751bb8d29576c` |
| `packages/testing/corpora/expanded/ground-truth.json` | `a12c1fe9fdf9439cc0c1cc89bba0c48531cd88c2025cebc9f36abeacfee81226` |

## What is unchanged from version 1

Everything that decides what is scored and how is identical to [version 1](../p06/PROTOCOL.md), and `protocol.json` carries it verbatim:

- the question and the three comparisons (C − B, B − A, D − A_pipeline);
- the fixtures, their ground truth and rubric (10 defects, 6 decoys), and the checkout isolation and leak check;
- the conditions A, A_pipeline, B, C, D and D_not_rejected;
- the 15-run schedule and its order;
- the matching rule, the `PROMPT_INJECTION` exclusion and the unlisted-findings review;
- the metrics and Wilson intervals, the paired bootstrap (10,000 iterations, seed 20260925, 95%), and the decision rule;
- the persistence of each run and the corpus import;
- the single-auditor derivation: auditor-a alone on `diff-fast`, as planner and verifier.

## What changes

### Models, and the scope limit

This version can test the multi-family premise, which version 1 could not. The three auditors are three different model families:

| Profile | Model | Family | Transport (subscription login) | Independence group |
|---|---|---|---|---|
| auditor-a | Claude Sonnet 5 (`claude-sonnet-5`) | claude | `claude-code-cli` (Claude) | `anthropic-sonnet` |
| auditor-b | `gpt-5.6-luna` | gpt | `codex-cli` (ChatGPT) | `openai` |
| auditor-c | `gemini-3.8-flash-low` | gemini | `antigravity-cli` (Google AI) | `google` |

auditor-a is the strong single model of conditions A and B.

**Scope limit, stated in advance.** The families are not matched for strength or cost. auditor-c is a flash model at low effort, and each Antigravity call also carries about 24k tokens of the CLI's own agent prompt. Condition C therefore compares one strong model plus two lighter models from other families against three runs of the strong model. It is not a comparison of equally capable families. A positive C − B is evidence that other families add defects the strong model misses; a null or negative result does not show that equally strong families would not.

### Roles

The roles are planner auditor-a, verifier auditor-a and critic auditor-c. In version 1 the verifier was auditor-b. auditor-a verifies here because the Codex and Antigravity subscriptions have lower usage limits: they carry only discovery, peer review and (auditor-c) criticism.

### Configuration and execution limits

The configuration comes from `tooling/live/configure.mjs` with [bindings.json](bindings.json), applied to `examples/model-backed/audit-mixed-providers.json`. Preset, depth, consensus policy, rounds and verification settings are unchanged: `audit-deep`, `deep`, `full`, 2 rounds, 2 model questions per round, canonical harness.

The execution limits for every run are:

- `maximumRetries` 2 and `maximumOutputRepairs` 2;
- `maximumOutputTokens` 32000 and `timeoutMs` 600000, as the subscription CLIs need;
- per provider: Anthropic 10 rpm with 2 concurrent requests; OpenAI and Google 6 rpm with 1 concurrent request each;
- per-run `maximumTokens` 3,000,000.

### Budget

The global budget covers all runs:

- at most 400 provider attempts, counting every retry and repair;
- at most 8,000,000 known tokens;
- at most 4 hours of summed run wall-clock time.

The subscriptions have no per-token price. The token limit is a guard against runaway loops, sized from the live subscription Audit runs (257k–385k tokens per three-auditor run). USD cost is reported as unavailable.

The rest of the budget handling is as in version 1:

- No run starts once a limit is reached.
- A run that ends without `COMPLETED` is resumed by the next driver invocation, from a fresh process. It is never restarted.
- The driver stops at the first incomplete run.
- A subscription usage-limit refusal counts as an incomplete run to resume after the limit resets.

### State and evidence

- **Ledger and run state:** `.runs/p06-subscription`, local only and not committed.
- **Evidence:** `docs/qa/p06-subscription/evidence`, in the same layout as version 1.
- **Results:** reported in this directory's README.

## Commands

```bash
pnpm build
caffeinate -is node packages/testing/dist/src/premise-evaluation/cli.js run \
  --protocol docs/qa/p06-subscription/protocol.json \
  --state .runs/p06-subscription --evidence docs/qa/p06-subscription/evidence
node packages/testing/dist/src/premise-evaluation/cli.js analyse \
  --protocol docs/qa/p06-subscription/protocol.json --evidence docs/qa/p06-subscription/evidence
```
