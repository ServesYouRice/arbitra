# Remaining work

Updated September 25, 2026 against commit 64f887e (branch `beta`).

The maintained execution queue is the [completion plan](docs/completion-plan.md); its
[status table](docs/completion-plan.md#status-september-25-2026) records every item.
P02, P05, P09, P14, P16 and P17 are complete. P01, P07, P08, P10–P13 and P15 are
implemented, with the evidence listed there still outstanding. P03, P04, P06, P18 and
P19 are pending.

## What is left, by what it needs

1. **Provider credentials and bounded spend:** P03 live conformance and public workflow
   acceptance, then P06 real-model premise evaluation, the live advisor path (P13) and
   each batch driver (P15).
2. **A local Linux Docker engine and pinned image:** P04, then P07's real-sandbox repair cases.
3. **A Claude Code binary and key:** P12 conformance (`ARBITRA_NATIVE_HARNESS_CONFORMANCE=1`).
4. **Other platforms:** Linux CI for P01 and non-macOS browser runs for P10.
5. **Implementation:** the remaining oversized stages in P08, end-to-end protocol/scope
   replay in P11, and an operator command for uncertain batch submissions in P15.
6. **After live data:** the P18 embedding decision and the P19 final review.

See [project status](docs/project-status.md) for implemented capabilities and measured
evidence. Historical notes are in the
[implementation log](docs/history/implementation-log-through-2026-09-23.md).
Update task status only in the completion plan.
