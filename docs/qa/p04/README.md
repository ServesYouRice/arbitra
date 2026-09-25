# P04 and P07: the Docker boundary against a real engine

Recorded September 25, 2026 on beta commit `98e285f`. Host: macOS 26 (arm64), Node 22.23.2.
Engine: Docker Desktop 29.8.0, `linux/arm64`, containerd image store, reached through the
current context's socket (`unix://$HOME/.docker/run/docker.sock`).

Image: `arbitra-sandbox-node@sha256:6403e233eb1ba30ae3529f48940dd1134f9f31cba556a8bac3cf08b396be5873`,
built from [tooling/sandbox-image](../../../tooling/sandbox-image/Dockerfile). That file
starts from `node:22-bookworm-slim@sha256:43ac6c60…b772c` and adds `vitest@4.1.10`.

```bash
export ARBITRA_DOCKER_ACCEPTANCE=1 ARBITRA_DOCKER_IMAGE=arbitra-sandbox-node@sha256:6403e233…5873
pnpm --filter @arbitra/runtime exec vitest run test/docker-sandbox.acceptance.test.ts test/testing-repair.test.ts
```

Without those variables, the acceptance file is skipped and the repair cases use the injected sandbox.

## Defects the real engine exposed (fixed)

| Defect | Effect before | Fix |
|---|---|---|
| The empty Docker CLI configuration also dropped the operator's context. | Docker Desktop, Colima and OrbStack do not serve `/var/run/docker.sock`, so the sandbox reported the engine unavailable on this host. | The local socket is resolved from `DOCKER_HOST` or the current context and passed as `--host`. `tcp://` and `ssh://` engines are refused. |
| `docker run` exit 125/126/127 from the engine was recorded as a finished check. | An absent image or entrypoint became a *failed test*, and repair would then try to fix it. | It is recorded as `unavailable`, which makes the check incomplete, never failed or passed. |

## Real-container results (all run against the engine above)

| Case | Result |
|---|---|
| Preflight probe: engine and pinned image present; absent image reported absent | passed |
| Passing check (`npm run test` → vitest, exit 0) and failing check (exit 1); containers removed | passed |
| Isolation probe inside the container | passed |
| Memory and process limits | passed |
| Timeout (3 s), cancellation, output limit (4 KiB); containers removed | passed |
| Command-binding drift | passed |
| Absent image; missing executable | passed |
| Host "dies" mid-check; a fresh adapter recovers the orphaned container and scratch directory, idempotently | passed |
| Four parallel checks | passed |
| Public Testing executor with a scripted model writer: task check and fresh final check in containers, then `apply-changes` | passed |
| Real check fails, so the gate fails and there is no handoff; source checkout unchanged | passed |

Details for the cases whose short name does not say what was checked:

- **Isolation probe:** uid/gid 65534; `EROFS` when writing to `/workspace` or `/`; `/tmp` writable; only `lo` exists; DNS and TCP fail; no host credential or `DOCKER*` variables (a canary secret set in the host process did not cross); `CapEff` is 0 and `NoNewPrivs` is 1; `memory.max` is 512 MiB, `pids.max` 64, `cpu.max` 1 CPU; the Docker socket is absent; the host checkout path is not visible; the source checkout bytes are unchanged.
- **Memory and process limits:** allocating 2 GiB is killed with exit 137; spawning 100 processes fails for more than 30 of them.
- **Command-binding drift:** changed arguments or executable are refused with `VERIFICATION_CHECK_NOT_ALLOWLISTED` before any container is created.
- **Absent image; missing executable:** both are recorded as `unavailable` (exit 125 with `No such image`, and 127 respectively), not as failed checks.
- **Public Testing executor:** `apply-changes` wrote the exact bytes to a separate matching checkout; a diverged destination was rejected, with nothing written; applying a second time was rejected as stale.

### P07 repair cases in real containers

With the variables set, every case in `testing-repair.test.ts` runs its checks in real
containers. Each check is a script in the snapshot that applies the case's pass/fail rule to
the mounted files and exits with the result.

These 10 cases passed:

- repair of an invalidated earlier task (exact final bytes exported);
- a shared-fixture closure;
- oscillation;
- rounds exhausted;
- unrecoverable;
- shared run budget;
- interrupted repair;
- cancelled repair;
- a writer stopped at the tool-turn limit;
- closure derivation.

The **reopen-interrupted** case exceeded its timeout once while the host load average was about 20–50 (other agents). It passed when rerun alone. It is recorded here as a load-induced timeout, not a defect.

## Live model writer

A live Testing execution also ran end to end: Gemini `gemini-3.1-flash-lite` as the writer,
checks in this image, then `apply-changes` to a matching checkout and rejection of a stale
one. It is recorded in [P03](../p03/README.md).

## Not covered

- **Other platforms:** a Linux host engine (as opposed to Docker Desktop's Linux VM), rootless Docker, and Windows named pipes. The `npipe://` endpoint is accepted by resolution but was not exercised.
- **Image-store differences:** the image was referenced by containerd image ID. The classic image store needs a registry digest (see the Dockerfile header).
