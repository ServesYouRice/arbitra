# Verification evidence

Each folder here holds the evidence of one completion-plan item. It records the commit, platform, configuration,
commands, results and redacted run references. The audits of real projects since October 20, and what came of carrying
out their plans, are in [real-project runs](real-runs.md). What is still open is in [remaining work](../../WORK-REMAINING.md).
Item definitions and the deferred paid-API bundle are in the [completion plan](../completion-plan.md).
The history was rewritten on October 24, 2026; commit hashes in files written before then (the frozen protocols
and the recorded evidence) are the old ones, and [`commit-map-2026-10-24.txt`](commit-map-2026-10-24.txt) gives
each one's new hash.

- **Full check:** `pnpm run ci` and `pnpm build` ([setup](../setup.md)). They run locally, on the maintainer's machine
  and in a clean `node:22` Linux container. The latest Linux pass is 738a139 (x86_64), on October 25, 2026; the
  full check also passes on Windows since then, the native-harness suites included.
- **Docker:** the Docker boundary and the Testing repair cases ran against a real engine ([`p04`](p04/README.md)).
- **Browsers:** acceptance ran on macOS and Linux arm64 ([`p10`](p10/README.md), [`p10-linux`](p10-linux/README.md));
  the workflow editor is covered in [`p16`](p16/README.md). The latest run passed 69 of 69 tests in Chromium, Firefox
  and WebKit on Linux x86_64, on October 25, 2026 at 2d37c15.
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

Defects found by the P20 benchmark runs are listed in that file's history: `git show e917ec7:WORK-REMAINING.md`.
