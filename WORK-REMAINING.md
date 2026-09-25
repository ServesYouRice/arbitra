# Remaining work

Updated September 25, 2026 against commit 0c6fb12 (branch `beta`).

The maintained execution queue is the [completion plan](docs/completion-plan.md). Every item is recorded in its [status table](docs/completion-plan.md#status-september-25-2026).

- **Complete:** P01, P02, P04, P05, P07, P09–P11, P13, P14, P16 and P17.
- **Implemented, evidence still outstanding:** P08, P12 and P15.
- **Partially accepted live:** P03.
- **Interim result (insufficient evidence; resumable plan in [docs/qa/p06](docs/qa/p06/README.md)):** P06.
- **Decided provisionally (reject), to be rerun on P06 data:** P18.
- **Pending:** P19.

## What is left, by what it needs

1. **Funded provider accounts.** The OpenAI and Anthropic keys have no API credit, and the Gemini key is free tier.
   - The Gemini free tier limits flash-lite to 500 requests per day per model and flash to 20; it has no Pro access and no Batch.
   - Credit on any account unlocks the rest of P03: the other protocols, a mixed-provider run, live Audit, interactive Feature and the executor handoff.
   - It also unlocks each P15 batch driver, a heterogeneous-family P06 and the P12 conformance run. P12 needs Anthropic credit, or instead a subscription token from `claude setup-token` with `credentialKind: oauth_token`.
2. **The next Gemini quota window**, for the remaining live Audit/Feature runs and P06 conditions, if no paid key is added.
3. **After live data:** rerun P18 on P06 findings, then the P19 final review.

See [project status](docs/project-status.md) for implemented capabilities and measured evidence.
Evidence per item is in [docs/qa](docs/qa/). Update task status only in the completion plan.
