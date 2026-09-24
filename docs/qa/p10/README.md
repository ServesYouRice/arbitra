# P10 browser acceptance: results

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

## Scenario matrix

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

## How the checks work

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

## Defects found and fixed during this QA

- **Resume and cancel failed in every browser.** `RunApi` sent `content-type: application/json`
  on bodiless POSTs, and Fastify rejects that with 400. Mocked unit tests did not catch it.
  Fixed in `apps/web/src/api/runs.ts`, with a regression test in `apps/web/test/run-api.test.ts`.
- **Run controls were missing for a run opened by link without a saved configuration.** Cancel,
  resume and checkpoint responses were unreachable. Run controls now render for any open run.
  Estimate and start stay disabled until a configuration exists.
- **Visual fixes.** Graph canvas nodes now carry their six-kind glyph. The canvas has more
  height. Table headers no longer break mid-word. The persisted-artifact list is a plain
  hairline list.

## Not covered here

- The narrow-layout breakpoints (1180px overlay, 900px tabs) were not screenshotted in this pass.
  The existing unit suite covers their CSS.
- Contrast ratios and screen-reader output were not measured.
- Only macOS was exercised. No Linux or Windows browser runs were recorded.
