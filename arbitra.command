#!/usr/bin/env bash
# Double-click (macOS) or run (Linux) to start arbitra: checks Node.js, installs and builds when missing or out of
# date, then opens http://127.0.0.1:4178. Everything it installs or builds stays inside this folder.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
runtime="$root/.arbitra-runtime"; mkdir -p "$runtime/logs"
port="${ARBITRA_PORT:-4178}"; url="http://127.0.0.1:$port"
say() { echo "arbitra: $*"; }
fail() { echo "arbitra: $*" >&2; exit 1; }

# Node.js 22 or newer must be installed; arbitra does not install it.
command -v node >/dev/null 2>&1 || fail "arbitra needs Node.js 22 or newer, and none was found. Install it from https://nodejs.org and start arbitra again."
major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
[ "$major" -ge 22 ] || fail "arbitra needs Node.js 22 or newer (found $(node --version)). Install it from https://nodejs.org and start arbitra again."
say "node $(node --version)"

# pnpm: corepack's (shipped with Node up to 24) in a folder of our own, else one already on PATH. The build calls pnpm
# from inside pnpm, so it has to be on PATH.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if command -v corepack >/dev/null 2>&1; then
  mkdir -p "$runtime/bin"; corepack enable --install-directory "$runtime/bin"; export PATH="$runtime/bin:$PATH"
fi
command -v pnpm >/dev/null 2>&1 || fail "arbitra needs pnpm 10. Run: npm install -g pnpm@10, then start arbitra again."

cd "$root"
current="$(git rev-parse HEAD 2>/dev/null || stat -f %m pnpm-lock.yaml 2>/dev/null || stat -c %Y pnpm-lock.yaml)"
built="$(cat "$runtime/built-from" 2>/dev/null || true)"
if [ ! -f apps/server/dist/src/serve.js ] || [ ! -f apps/web/dist/index.html ] || [ "$built" != "$current" ]; then
  say "installing (first start or after an update: a few minutes)"; pnpm install --frozen-lockfile
  say "building"; pnpm build
  echo "$current" > "$runtime/built-from"
fi

log="$runtime/logs/arbitra-$(date +%Y-%m-%d-%H%M%S).log"
say "starting on $url (log: $log)"
node apps/server/dist/src/serve.js >"$log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT INT TERM
for _ in $(seq 1 60); do sleep 0.5; curl -fs "$url/runs" >/dev/null 2>&1 && break; kill -0 $server 2>/dev/null || { tail -20 "$log"; exit 1; }; done
if command -v open >/dev/null 2>&1; then open "$url"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"; fi
say "running. Keep this window open; close it or press Ctrl+C to stop arbitra."
wait $server
