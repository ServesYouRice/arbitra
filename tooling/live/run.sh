#!/usr/bin/env bash
# Run one live-acceptance configuration through the public CLI against a fresh copy of the
# fixture repository (completion plan P03). API credentials come from the repository's .env when present;
# subscription CLI endpoints use the CLI's own login on this host.
#   tooling/live/run.sh <configs-dir> <config-name> [cli args after the config path...]
# ARBITRA_LIVE_FIXTURE names another fixture repository to copy (default: tooling/live/fixture-repo).
# Prints the CLI policy, the run state and, for a failed run, the recorded failure reason.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
configs="$(cd "$1" && pwd)"; name="$2"; shift 2
work="$root/.runs/live/work/$name"
fixture="${ARBITRA_LIVE_FIXTURE:-$root/tooling/live/fixture-repo}"
rm -rf "$work" && mkdir -p "$work" && cp -R "$fixture" "$work/repo"
cd "$work/repo" && git init -q && git add -A && git -c user.email=live@arbitra.invalid -c user.name=live commit -qm fixture
if [ -f "$root/.env" ]; then set -a; . "$root/.env"; set +a; fi
# A sleeping Mac freezes the run: stage timeouts count only awake time, so wall-clock durations
# stretch by the time asleep (observed live: a 10-minute stage timeout took 27 minutes). Keep it awake.
awake=(); if command -v caffeinate >/dev/null 2>&1; then awake=(caffeinate -is); fi
status=0
${awake[@]+"${awake[@]}"} node "$root/apps/cli/dist/src/bin.js" run "$configs/$name.json" "$@" --json 2>"$work/stderr.log" >"$work/result.json" || status=$?
python3 - "$work" "$status" <<'PY'
import glob, json, re, sys
work, status = sys.argv[1], sys.argv[2]
result = json.load(open(f"{work}/result.json"))
run = result.get("result") or {}
print(json.dumps({"exit": int(status), "policy": result.get("policy"), "runId": run.get("runId"), "state": run.get("state")}))
for journal in glob.glob(f"{work}/repo/.runs/runs/*/journal.jsonl"):
    reasons = sorted(set(re.findall(r'"error":"([^"]{0,300})', open(journal).read())))
    if reasons: print("failure:", reasons)
PY
