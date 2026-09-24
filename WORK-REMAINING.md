# Remaining work

Updated September 24, 2026 against commit 77149ef.

The maintained execution queue is the [completion plan](docs/completion-plan.md).
It contains 19 pending items with dependencies, implementation scope and acceptance
criteria covering every unfinished step from the previous queue.

See [project status](docs/project-status.md) for implemented capabilities and actual
verification evidence. Model-backed Audit, Feature planning, Testing planning, guarded
Testing execution and the trace browser are implemented. Live acceptance, remaining
recovery/scale/operator work and the listed extensions are still pending.

## Execution order

1. P01–P06: reliable tests, reproducible setup, live-provider/Docker acceptance,
   durable evaluation data and real-model premise measurement.
2. P07–P11: final-invalidation repair, oversized contexts, gates/checkpoints,
   web controls/browser QA and Feature/Testing replay.
3. P12–P18: native harnesses, advisors, incremental audits, provider batches,
   canvas editing, trace indexing and the embedding evaluation/decision.
4. P19: final defect review, acceptance evidence and documentation reconciliation.

The original 49-task completion count does not describe this queue. Historical notes,
including superseded availability claims and checkboxes, are preserved in the
[implementation log](docs/history/implementation-log-through-2026-09-23.md).
Update task status only in the completion plan, and update measured capabilities in
project status when the evidence changes.
