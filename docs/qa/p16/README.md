# P16 browser acceptance: results

These results come from one recorded run of `pnpm --filter @arbitra/web e2e` on 2026-09-25,
after merging beta at 5d054d9. The run built the server fixture and the web app, then ran
every spec in all three browser engines. That covers the P10 specs and the new
`apps/web/e2e/workflow-editor.spec.ts`. Screenshots are in `chromium/`, `firefox/` and
`webkit/`. They are full-page captures of the editor and the saved-graph run.

| Item | Value |
|---|---|
| Platform | macOS 26.6.2, arm64, Node 22.23.2 |
| Harness | `@playwright/test` 1.61.1, cached browser builds (nothing downloaded) |
| Viewport | 1600×1000 at device scale 1 |
| Server | Real control plane from `apps/server/fixtures/e2e-server.ts`, over a temporary state directory. `POST /__fixture/repositories/audit` exists only in the fixture. It creates a source tree for a run the browser starts itself. |
| Runs | Real orchestrator, runner, saved-graph store, validator and checkpoints. Audit discovery uses the credential-free scripted auditors, so no provider is called. |
| Result | **51 passed, 0 failed, 0 flaky** (17 scenarios × 3 browsers, 2.9 min). The P16 scenarios are 3 × 3 = 9 passed. |

## P16 scenario matrix

| Scenario | Acceptance clause | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| Add a node, then undo and redo it with the buttons, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z and Ctrl+Y. The unsaved-changes marker follows the edits. `beforeunload` is cancelled only while there are unsaved changes. Leaving through a view tab or the run-view toggle opens the in-page guard, with focus on "keep editing". Escape keeps editing. Discarding leaves the editor. | undo/redo, dirty state | pass | pass | pass |
| Keyboard-only editing. The Tab order reaches the add-node controls; WebKit uses Option+Tab, the platform's full keyboard access. Rename the graph, add and rename a human node, edit its prompt, remove and connect edges, delete with the Delete key and undo, and save with Ctrl/⌘+S. The server rejects an edge back to the entry (`EDGE_INTO_ENTRY`, `UNBOUNDED_CYCLE`) and a model node whose role the configuration does not bind (`MODEL_ROLE_UNAVAILABLE`). Both show as diagnostics, and the save is refused with HTTP 422. The unchanged preset ID and a write-authority key are refused (`UNAUTHORIZED_CHANGE`, `write_authority`). The accessibility audit passes, and the untrusted prompt stays inert. | keyboard interaction; invalid edges, unbounded loops, missing roles, unauthorized changes | pass | pass | pass |
| Edit and save a graph that has a human sign-off. Save a configuration that references `workflow.graph {id, version}` through the configuration editor. Start the run from the run controls. The graph view reports the executed graph as the saved version. A later version of the same graph is then saved. Approve, then resume to COMPLETED. `GET /runs/:id` reports `workflowGraph.version == executedVersion ==` the saved version, and `workflow` equals the saved graph. | a saved edited graph is the graph that executes and resumes | pass | pass | pass |

Screenshots: `editor-01-unsaved-guard`, `editor-02-edited`, `editor-03-invalid-cycle`,
`editor-04-keyboard-saved`, `editor-05-saved-graph-blocked` and `editor-06-saved-graph-completed`.

## Limits

- The runs use scripted auditors. They exercise dispatch, checkpoints and resume, not model
  quality. Live providers are P03.
- Saved graphs run in audit mode. Feature and Testing keep their shipped presets, because
  their executors bind stages by preset.
