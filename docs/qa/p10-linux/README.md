# P10 and P16 browser acceptance on Linux: results

These results come from one recorded run of `pnpm --filter @arbitra/web e2e` on 2026-09-25, in a
Linux container on an arm64 Mac. The run built the server fixture and the web app inside the
container, then ran every spec in all three browser engines. That covers the 14 P10 scenarios
(`feature`, `lifecycle`, `testing` and `views` specs) and the 3 P16 editor scenarios
(`workflow-editor.spec.ts`). The macOS evidence is in `docs/qa/p10/` and `docs/qa/p16/`.
Screenshots from this run are in `p10/<browser>/` and `p16/<browser>/`, under the same names
as the macOS captures.

| Item | Value |
|---|---|
| Image | `mcr.microsoft.com/playwright:v1.61.1-noble` at `sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48` (Ubuntu 24.04.4 LTS) |
| Platform | `linux/arm64`, kernel 7.0.12-linuxkit (Docker Desktop 29.8.0 engine on macOS arm64) |
| Node | 22.23.2 (linux-arm64 tarball from nodejs.org). The image ships Node 24.17.0, and the repository's `engine-strict` range is `>=22 <23`. |
| Harness | `@playwright/test` 1.61.1, installed in the container with `pnpm install --frozen-lockfile`. The host `node_modules` was not mounted. |
| Browsers | The image's own builds: Chromium 149.0.7827.0 (chromium-1228), Firefox 151.0 (firefox-1532), WebKit 26.5 (webkit-2311). All headless. |
| Viewport | 1600×1000 at device scale 1 |
| Server | Real control plane from `apps/server/fixtures/e2e-server.ts`, over a temporary state directory in the container |
| Source | beta at 527ff4e plus the two fixes below (e569b44, 8f07980) |
| Result | **51 passed, 0 failed, 0 flaky, 0 skipped** (17 scenarios × 3 browsers, 3.9 min, `retries: 0`) |

## Per-browser results

| Suite | Chromium | Firefox | WebKit |
|---|---|---|---|
| P10: `feature.spec.ts` (3) | 3 passed | 3 passed | 3 passed |
| P10: `lifecycle.spec.ts` (2) | 2 passed | 2 passed | 2 passed |
| P10: `testing.spec.ts` (4) | 4 passed | 4 passed | 4 passed |
| P10: `views.spec.ts` (5) | 5 passed | 5 passed | 5 passed |
| **P10 total (14)** | **14 passed** | **14 passed** | **14 passed** |
| **P16: `workflow-editor.spec.ts` (3)** | **3 passed** | **3 passed** | **3 passed** |

Every scenario passed on its first attempt. The scenario matrices in `docs/qa/p10/README.md` and
`docs/qa/p16/README.md` describe what each scenario checks. The checks are the same on Linux,
with one keyboard difference. WebKit on Linux has no macOS full-keyboard-access setting, so both
keyboard passes (`views.spec.ts` and `workflow-editor.spec.ts`) drive WebKit with plain Tab.
Option+Tab is used only on macOS.

## Command

The worktree was mounted read-only at `/src`. The script copied it into the container without
`node_modules`, `dist`, `.git` or `test-results`, and deleted the copied macOS screenshots so
only this run's captures were collected.

```sh
docker run --rm --platform linux/arm64 --ipc=host --entrypoint /run.sh \
  -v "$WORKTREE:/src:ro" -v "$PWD/run.sh:/run.sh:ro" -v "$PWD/out:/out" \
  mcr.microsoft.com/playwright:v1.61.1-noble
```

Inside the container, `run.sh` did the following:

```sh
curl -fsSL https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.gz | tar -xz -C /opt/node --strip-components=1
export PATH=/opt/node/bin:$PATH
tar -C /src --exclude=node_modules --exclude=dist --exclude=.git --exclude=test-results -cf - . | tar -C /work -xf -
cd /work && corepack enable && CI=true pnpm install --frozen-lockfile
cd apps/web && pnpm e2e    # builds @arbitra/server..., runs vite build, then playwright test
```

## Defects found and fixed during this QA

- **Run status could lag its own event log (product bug).** Before the fix, one of the two full
  Linux runs failed 2 of 51 scenarios. Those were `feature.spec.ts` "revision proposal…" on
  Chromium and "blocked approval…" on Firefox. In both, the Feature view showed
  `CREATED · resumable` after a resume, even though the SSE feed had delivered `BLOCKED` or
  `COMPLETED`. The trace showed the cause. `GET /runs/:id`, fetched when the stopped transition
  arrived, returned `state: CREATED`. `WorkflowRunner` updated a handle's live state only after
  the journal append resolved. But `RunStore.appendEvent` makes the line readable before it
  syncs, and `Orchestrator.status()` prefers the live handle's state over the log. The browser's
  refresh-on-stop then overwrote the correct state with the older one. The container
  filesystem's slower fsync widened the window. Fixed in e569b44
  (`packages/core/src/runner/workflow-runner.ts`): the live state is published before the
  durable write, so it never trails the log. A regression test in
  `packages/core/test/runner/workflow-runner.test.ts` fails without the fix.
- **The editor keyboard test used Option+Tab for WebKit on every platform.** That setting only
  exists on macOS, and the keyboard pass in `views.spec.ts` already limited it to macOS. Fixed in
  8f07980, so Linux WebKit is now tested with plain Tab. The spec passed on Linux both before
  and after this change.

## Not covered here

- This was one post-fix run. An earlier post-fix attempt ran while the shared host was
  overloaded (load average about 40). Its scenarios hit their 90 s timeouts, taking 1 to 2
  minutes each against about 5 s normally, and it was stopped partway and not counted. The same
  build then passed 51 of 51 once the load dropped.
- Only headless browsers on `linux/arm64` were run. `linux/amd64` and Windows were not run.
- The limits in the macOS READMEs also apply here. The providers and sandbox are scripted,
  contrast is not measured, and the narrow layouts are not screenshotted.
