# P06 premise evaluation on subscription models: prespecified protocol 2.1.0

Protocol `arbitra-p06-premise@2.1.0`. It was written and committed on September 28, 2026, before any run of this version. The machine-readable version is [protocol-2.1.0.json](protocol-2.1.0.json), and the driver (`packages/testing/src/premise-evaluation/`) runs exactly that file.

Version 2.0.0 ([PROTOCOL.md](PROTOCOL.md)) stays as it was. Its two runs stay on record in the [README](README.md) and are never pooled with this version's. Version 1 ([docs/qa/p06](../p06/PROTOCOL.md)) is not pooled either.

**Why a new version.** Under 2.0.0, the critic's review of a revised plan did not fit under the configuration's context cap (`maximumContextTokens` 128,000). It split into 2 review batches and 152 pair checks. Each check was a separate Antigravity call carrying about 24k tokens of the CLI's own agent prompt, and run 2 spent its 3,000,000-token cap after 60 of them. At that cost the global budget would have stopped the schedule after about 6 of its 15 runs, before any comparison could be computed. On September 28 the owner chose to amend the protocol rather than continue 2.0.0. The two runs also exposed a validation defect that dropped a correct finding from the single-model condition in both runs; the runtime this version uses fixes it.

| Input | sha256 |
|---|---|
| `docs/qa/p06-subscription/protocol-2.1.0.json` | `e53d753505e641a970d8e4187bb859fbc6b75bbefe0ba8ed72d0b1f7572c20df` |
| `docs/qa/p06-subscription/configs-2.1.0/audit-mixed-providers.json` | `d9eea18bafe846906a6d898bda2bc42fa1eb0ce544088879bc762e9eb2dfb33a` |
| `docs/qa/p06-subscription/bindings-2.1.0.json` | `69d856d883e1dc50d234b98d8bb1e03138cabf1538ba7aa864f7c7c365f3dafb` |
| `docs/qa/p06/ground-truth/live-fixture-v1.json` | `3464c1df7a792acffe95017f7b86311ef469e280626d10c32415effb9d4d83a6` |
| `packages/testing/corpora/premise/ground-truth.json` | `fbc179b1a5bc3dc945c067b98dc244a75b71d17522e697b2ef3751bb8d29576c` |
| `packages/testing/corpora/expanded/ground-truth.json` | `a12c1fe9fdf9439cc0c1cc89bba0c48531cd88c2025cebc9f36abeacfee81226` |

The ground-truth hashes are the same as in 2.0.0.

## What is unchanged from 2.0.0

Everything that decides what runs and how it is scored is identical to [2.0.0](PROTOCOL.md), and `protocol-2.1.0.json` carries it verbatim:

- the question and the three comparisons (C − B, B − A, D − A_pipeline);
- the fixtures, their ground truth and rubric (10 defects, 6 decoys), and the checkout isolation and leak check;
- the conditions A, A_pipeline, B, C, D and D_not_rejected;
- the 15-run schedule and its order;
- the matching rule, the `PROMPT_INJECTION` exclusion and the unlisted-findings review;
- the metrics and Wilson intervals, the paired bootstrap (10,000 iterations, seed 20260925, 95%), and the decision rule;
- the persistence of each run and the corpus import;
- the single-auditor derivation: auditor-a alone on `diff-fast`, as planner and verifier;
- the models, families, transports and independence groups, and the roles (planner and verifier auditor-a, critic auditor-c);
- every execution limit except the context cap, including the per-run cap of 3,000,000 tokens;
- the scope limit: the three families are not matched for strength or cost.

## What changes

### Context cap

`maximumContextTokens` goes from 128,000 to 1,000,000 ([bindings-2.1.0.json](bindings-2.1.0.json)). The runtime uses 80% of the smaller of this cap and each model's own limit, so the per-call limits become:

| Model | 2.0.0 | 2.1.0 |
|---|---|---|
| Claude Sonnet 5 (200,000) | 102,400 | 160,000 |
| GPT-5.6 Luna (272,000) | 102,400 | 217,600 |
| Gemini 3.8 Flash (1,000,000) | 102,400 | 800,000 |

Input is still estimated from bytes, with the same 32,000-token output reserve. The generated configuration differs from 2.0.0's in this one value.

### Budget

The budget is sized from 2.0.0's run 2 without the fan-out. Before the critic's review of the revision, that three-auditor run used about 0.8M known tokens and 32 attempts, and that review is now expected to take one call. The single-auditor run used about 15k known tokens and 4 attempts. The schedule is therefore expected to use about 5.5M known tokens, about 260 attempts and about 3 hours of run time. The global budget is about twice that:

- at most 500 provider attempts, counting every retry and repair (was 400);
- at most 12,000,000 known tokens (was 8,000,000);
- at most 8 hours of summed run wall-clock time (was 4 hours).

The rest of the budget handling is unchanged: no run starts once a limit is reached; a run that ends without `COMPLETED` is resumed, never restarted, by the next driver invocation; the driver stops at the first incomplete run; and a subscription usage-limit refusal counts as an incomplete run to resume after the limit resets.

### Runtime

Runs use the runtime at commit 1e5011d or later. It includes three fixes found through 2.0.0:

- **cfc1cc8** repairs a staged plan-revision patch that breaks a rule, instead of failing the run.
- **e87b2da** repairs a discovery finding marked as a production blocker below high severity, instead of dropping it. In 2.0.0 this dropped Claude's correct migration finding in both runs, which lowered condition A's recall.
- **1e5011d** makes the analysis report state the model families it tests.

None of them changes what is scored or the decision rule.

### State and evidence

- **Ledger and run state:** `.runs/p06-subscription-2.1.0`, local only and not committed.
- **Evidence:** `docs/qa/p06-subscription/evidence-2.1.0`, in the same layout as before.
- **Results:** reported in this directory's [README](README.md), separately from 2.0.0.

Runs are paced on the owner's Claude five-hour window: no run starts above 80% of it, and the next one waits for the reset. This affects only when runs start, not what they do.

## Commands

```bash
pnpm build
caffeinate -is node packages/testing/dist/src/premise-evaluation/cli.js run \
  --protocol docs/qa/p06-subscription/protocol-2.1.0.json \
  --state .runs/p06-subscription-2.1.0 --evidence docs/qa/p06-subscription/evidence-2.1.0
node packages/testing/dist/src/premise-evaluation/cli.js analyse \
  --protocol docs/qa/p06-subscription/protocol-2.1.0.json --evidence docs/qa/p06-subscription/evidence-2.1.0
```
