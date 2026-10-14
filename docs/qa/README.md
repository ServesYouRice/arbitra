# Verification evidence

Each folder here holds the evidence of one completion-plan item. It records the commit, platform, configuration,
commands, results and redacted run references. What is still open is in [remaining work](../../WORK-REMAINING.md).
Item definitions and the deferred paid-API bundle are in the [completion plan](../completion-plan.md).

- **Full check:** `pnpm run ci` and `pnpm build` ([setup](../setup.md)). They run locally, on the owner's machine
  and in a clean `node:22` Linux container. The latest is 6578af6 on October 14, 2026.
- **Docker:** the Docker boundary and the Testing repair cases ran against a real engine ([`p04`](p04/README.md)).
- **Browsers:** acceptance ran on macOS and Linux arm64 ([`p10`](p10/README.md), [`p10-linux`](p10-linux/README.md));
  the workflow editor is covered in [`p16`](p16/README.md).
- **Live providers:**
  - Gemini native and the OpenAI-compatible chat protocol passed transport conformance ([`p03`](p03/README.md)).
  - On subscriptions, every public workflow passed through the CLIs.
  - Two exported Feature plans were accepted by fresh Claude Code executors.
  - A three-vendor Audit found every seeded defect.

  Evidence: [`p03-subscription`](p03-subscription/README.md) and [`subscription-cli`](subscription-cli/README.md).
- **Native harness:** the Claude Code writer passed conformance against the real CLI on a subscription login
  ([`p12`](p12/README.md)).
- **Advisors:** the live advisor path is in [`p13-live`](p13-live/README.md).
- **Batch drivers:** every driver was refused before a job was created ([`p15-live`](p15-live/README.md)). Live
  validation waits for the paid-API bundle.
- **Premise evaluation (P06):** protocol 2.1.0 ran 15 runs on three model families, and every prespecified
  comparison was insufficient evidence ([`p06-subscription`](p06-subscription/README.md)). Version 1 is in
  [`p06`](p06/README.md).
- **Embedding decision (P18):** do not adopt the local embedding candidate ([`p18`](p18/README.md)).
- **Final review (P19):** eight findings fixed, and the affected live acceptance passed ([`p19`](p19/README.md)).

The live runs found defects, and each was fixed with a regression test:

| Runs | Defects | Listed in |
|---|---|---|
| Gemini live runs | 13 | [`p03`](p03/README.md) |
| Subscription runs | 12 | [`p03-subscription`](p03-subscription/README.md) |
| Real Docker engine | 2 | [`p04`](p04/README.md) |
| Linux browsers | 1 | [`p10-linux`](p10-linux/README.md) |

Defects found by the P20 benchmark runs are listed in [remaining work](../../WORK-REMAINING.md).
