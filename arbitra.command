#!/usr/bin/env bash
# Double-click (macOS) or run (Linux) to start arbitra: checks Node.js, sets up pnpm, installs and builds when missing
# or out of date, then opens http://127.0.0.1:4178. Everything it installs or builds stays inside this folder.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
runtime="$root/.arbitra-runtime"; mkdir -p "$runtime/logs"
port="${ARBITRA_PORT:-4178}"; url="http://127.0.0.1:$port"
say() { echo "arbitra: $*"; }
fail() { echo "arbitra: $*" >&2; exit 1; }

# Node.js 22.13 or newer must be installed (any later version, current or LTS); arbitra does not install it.
# Started from Finder, the window may lack the folders Homebrew and the Node installer use; they go last on PATH.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v node >/dev/null 2>&1 || fail "arbitra needs Node.js 22.13 or newer, and none was found. Install the current LTS from https://nodejs.org and start arbitra again."
version="$(node --version | sed -E 's/^v//')"; major="${version%%.*}"; minor="$(echo "$version" | cut -d. -f2)"
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
  fail "arbitra needs Node.js 22.13 or newer (found $version). Install the current LTS from https://nodejs.org and start arbitra again."
fi
say "node $version"

# pnpm 10, pinned, installed once into this folder with the npm that comes with every Node: no root rights and no
# corepack, which Node 25 and later no longer ship. The build calls pnpm from inside pnpm, so it goes first on PATH.
pnpm_home="$runtime/pnpm"
if [ ! -x "$pnpm_home/node_modules/.bin/pnpm" ]; then
  say "installing pnpm (once)"
  npm install --prefix "$pnpm_home" --no-audit --no-fund --loglevel=error pnpm@10.24.0 || fail "pnpm could not be installed"
fi
export PATH="$pnpm_home/node_modules/.bin:$PATH"

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
open_url() { if command -v open >/dev/null 2>&1; then open "$url"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"; fi; }
# Wait for this server, not whatever answers on the port: an older arbitra left running there must not be opened.
ours=""
for _ in $(seq 1 60); do
  sleep 0.5
  kill -0 $server 2>/dev/null || break
  curl -fs "$url/diagnostics/server" 2>/dev/null | grep -Eq "\"pid\":$server[,}]" && { ours=1; break; }
done
if [ -z "$ours" ] && ! kill -0 $server 2>/dev/null; then
  # It exits 0 when this build already runs there, and names another build when one does.
  if wait $server; then say "already running on $url; opening it"; open_url; exit 0; fi
  tail -20 "$log"; exit 1
fi
open_url
say "running. Keep this window open; close it or press Ctrl+C to stop arbitra."
wait $server
