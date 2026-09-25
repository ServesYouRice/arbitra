#!/usr/bin/env bash
# Resume a live-acceptance run from a fresh process: tooling/live/resume.sh <config-name> <run-id>
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"; name="$1"; run="$2"; work="$root/.runs/live/work/$name"
cd "$work/repo"; set -a; . "$root/.env"; set +a
status=0
node "$root/apps/cli/dist/src/bin.js" resume "$run" --json 2>>"$work/stderr.log" >"$work/result.json" || status=$?
python3 - "$work" "$status" "$run" <<'PY'
import json, re, sys
work, status, run = sys.argv[1:]
result = json.load(open(f"{work}/result.json")); body = result.get("result") or {}
print(json.dumps({"exit": int(status), "policy": result.get("policy"), "runId": body.get("runId"), "state": body.get("state")}))
reasons = sorted(set(re.findall(r'"error":"([^"]{0,300})', open(f"{work}/repo/.runs/runs/{run}/journal.jsonl").read())))
if reasons: print("failures so far:", reasons)
PY
