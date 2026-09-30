# P10 browser acceptance: results

## Rerun after the interface restructure (2026-09-29)

The operator interface was restructured on branch `ui-restructure` (see
[Pages, not columns](../../DESIGN-LANGUAGE.md#pages-not-columns)): a run list, one page per
run with a decision banner, per-mode tabs and a details panel, a new-run form over the
orchestrator's preflight, and the workflow editor on its own page. Every scenario below was
rewritten against the new pages and rerun, and a new `navigation.spec.ts` covers what the old
single screen could not do. **The screenshots in this folder are from this rerun.** The
original 2026-09-24 record follows below.

| Item | Value |
|---|---|
| Platform | macOS 27.0, arm64 (Apple silicon), Node 22.23.2 |
| Harness | `@playwright/test` 1.61.1, cached browser builds chromium-1228, firefox-1532 and webkit-2311 (nothing downloaded) |
| Command | `E2E_PORT=4193 pnpm --filter @arbitra/web e2e` (builds the server fixture and the web app first) |
| Viewport | 1600×1000 at device scale 1, except the width checks below |
| Result | **69 passed, 0 failed, 0 flaky, 0 skipped** (23 scenarios × 3 browsers, 3.0 min, `retries: 0`), including the P16 editor scenarios ([`qa/p16`](../p16/README.md)) |

| Spec | Chromium | Firefox | WebKit |
|---|---|---|---|
| `feature.spec.ts` (3) | 3 passed | 3 passed | 3 passed |
| `lifecycle.spec.ts` (2) | 2 passed | 2 passed | 2 passed |
| `testing.spec.ts` (5) | 5 passed | 5 passed | 5 passed |
| `views.spec.ts` (5) | 5 passed | 5 passed | 5 passed |
| `navigation.spec.ts` (5, new) | 5 passed | 5 passed | 5 passed |
| `workflow-editor.spec.ts` (3, P16) | 3 passed | 3 passed | 3 passed |

What changed in the scenarios, clause by clause:

- **Blocked and stale approvals, reload and resume.** Approvals are made on the Requirements
  tab, beside the defaults they approve; the decision banner above every tab lists what is
  pending and holds the only resume. Stale refusals, reloads and the handoff download are
  checked as before. A generic human checkpoint is approved and resumed from the banner.
- **Cancellation.** A live run is cancelled from its header, which then offers resume; the
  state is read from the header chip (words and code, such as `cancelled CANCELLED`).
- **Issues, plan, evaluation, traces.** An issue opens its full record in the details panel
  (dissent first, the untrusted claim marked, source findings with their evidence), and the
  selection is part of the address. Plan traceability runs in the details panel with its
  trail. Model attempts live on the Activity tab and open in the details panel.
- **Keyboard.** Run tabs are links, reached with Tab and followed with Enter; the approval
  checkbox is followed directly by the decision it enables.
- **New (`navigation.spec.ts`).** The run list opens a run; tabs are history steps and
  selections are not; a reload keeps the tab and the open issue; a scripted run is checked
  and started from the new-run page; a model-backed template lists its six placeholders and
  is refused by preflight until they are filled; and at 1100px and 800px no control on the
  overview, issues, activity or new-run pages is covered by another element, with the
  details panel as a modal drawer that takes focus and closes on Escape.

Defects found and fixed during this rerun:

- **Every decision blanked the run page.** Answering a checkpoint, cancelling or resuming
  re-subscribes to the run, and the rehydration hook reset the run to "unknown" while it
  re-read it, which unmounted the open tab and lost its confirmation notice. The last known
  state now stays on screen until the new read answers (`apps/web/src/api/runs.ts`, regression
  test in `apps/web/test/api.test.tsx`). The issue board, plan, Feature and Testing views no
  longer flash empty on each run event for the same reason.
- **A browser quirk, not an app defect:** Firefox under Playwright keeps no earlier history
  entry across a reload, so back-navigation is checked before the reload.

## Original acceptance (2026-09-24)

These results come from one recorded run of `pnpm --filter @arbitra/web e2e` on 2026-09-24.
The run built the server fixture and the web app, then ran every scenario in all three browser
engines. JSON results were written to `apps/web/test-results/e2e-results.json` (not tracked).
Screenshots are in `chromium/`, `firefox/` and `webkit/`.

| Item | Value |
|---|---|
| Platform | macOS 26.6.2, arm64 (Apple silicon), Node 22.23.2 |
| Harness | `@playwright/test` 1.61.1, using cached browser builds chromium-1228, firefox-1532 and webkit-2311 (nothing downloaded) |
| Browsers | Chromium 149.0.7827.55, Firefox 151.0, WebKit 26.5 |
| Viewport | 1600×1000 at device scale 1. The four-column shell is at full width. |
| Server | Real control plane (`buildServer(controlPlaneCore(orchestrator))`) from `apps/server/fixtures/e2e-server.ts`, over a temporary state directory |
| Runs | Real orchestrator, runner, stores, checkpoints, Testing executor and repair. Provider and Docker sandbox ports are scripted (`apps/server/fixtures/scripted-runs.ts`). |
| Result | **42 passed, 0 failed, 0 flaky, 0 skipped** (14 scenarios × 3 browsers, 206 s) |

Scripted providers and sandbox do not establish model quality or real Docker behavior.
Live-provider and Docker acceptance remain separate items (P03 and P04).

### Scenario matrix

| Scenario (spec) | Acceptance clause | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| Blocked approval, stale refusal, reload, explicit resume, handoff download (`feature.spec.ts`) | blocked/stale approvals, reload/resume, handoff retrieval | pass | pass | pass |
| Revision proposal inspected, applied, re-approved, resumed (`feature.spec.ts`) | proposal application, resume | pass | pass | pass |
| Operator draft revision clears approvals (`feature.spec.ts`) | draft revision | pass | pass | pass |
| Cancel a live run, reload, resume (`lifecycle.spec.ts`) | cancellation, reload/resume | pass | pass | pass |
| Generic human checkpoint approved; second decision refused with 409; resume (`lifecycle.spec.ts`) | blocked/stale approvals | pass | pass | pass |
| Authority review, plan versus execution, verified change download with hash check (`testing.spec.ts`) | Testing review, handoff retrieval | pass | pass | pass |
| Failed checks withhold the handoff; change-set route returns 404 (`testing.spec.ts`) | failed checks | pass | pass | pass |
| Bounded repair lineage, repaired bytes downloaded, execution subgraph expanded from the keyboard (`testing.spec.ts`) | repair, subgraph expansion | pass | pass | pass |
| No-work result stays explicit (`testing.spec.ts`) | no-work results | pass | pass | pass |
| Issue board severity filter, clear, keyboard expansion, untrusted evidence, accessibility audit (`views.spec.ts`) | issues, filters, untrusted text | pass | pass | pass |
| Plan traceability from the keyboard, accessibility audit (`views.spec.ts`) | plan | pass | pass | pass |
| Evaluation shows unknown cost and precision as `unavailable` (`views.spec.ts`) | evaluation, unknown measurements | pass | pass | pass |
| Trace browser: 27 attempts over 2 pages, activity and outcome filters, unknown cost, historical input/output artifacts (`views.spec.ts`) | trace browser, pagination, historical artifacts | pass | pass | pass |
| Keyboard-only navigation across all seven views, visible focus outline, per-view accessibility audit, graph stage selection (`views.spec.ts`) | keyboard QA | pass | pass | pass |

### How the checks work

- **Untrusted text.** The scripted runs put model-authored markup in contract assumptions, plan
  task titles, risk summaries, sandbox output, audit evidence and a checkpoint prompt. That
  markup is `<img src=x onerror=…><script>…</script>`. Each scenario checks that the markup
  appears as literal text. It also checks that no matching element exists, the injected global
  is still unset, and no dialog opened.
- **Unknown measurements.** No pricing is configured and no ground truth exists. Cost, cache
  and precision fields must read `unavailable`, never `0`.
- **Accessibility.** The audit is a dependency-free in-page check in `apps/web/e2e/support.ts`.
  It checks that every visible control has an accessible name, form controls are labelled and
  images have alt text. It also checks that IDs are unique, ARIA ID references resolve, and the
  page has a main landmark, a heading and a document language. It ran on the issue board, plan,
  evaluation and trace views, and on every view during the keyboard pass. It found no problems.
  It is not a full WCAG audit. In particular, contrast is not measured.
- **Keyboard.** Tab order across the view tabs, visible `:focus-visible` outline, Enter/Space
  activation, checkbox toggling, and graph stage expansion and selection are all driven from
  the keyboard. WebKit on macOS follows the platform default, where Tab moves only between form
  fields, so the WebKit pass uses Option+Tab, which reaches every control.

### Defects found and fixed during this QA

- **Resume and cancel failed in every browser.** `RunApi` sent `content-type: application/json`
  on bodiless POSTs, and Fastify rejects that with 400. Mocked unit tests did not catch it.
  Fixed in `apps/web/src/api/runs.ts`, with a regression test in `apps/web/test/run-api.test.ts`.
- **Run controls were missing for a run opened by link without a saved configuration.** Cancel,
  resume and checkpoint responses were unreachable. Run controls now render for any open run.
  Estimate and start stay disabled until a configuration exists.
- **Visual fixes.** Graph canvas nodes now carry their six-kind glyph. The canvas has more
  height. Table headers no longer break mid-word. The persisted-artifact list is a plain
  hairline list.

### Not covered here

- The narrow-layout breakpoints (1180px overlay, 900px tabs) were not screenshotted in this pass.
  The existing unit suite covers their CSS.
- Contrast ratios and screen-reader output were not measured.
- Only macOS was exercised. No Linux or Windows browser runs were recorded.
