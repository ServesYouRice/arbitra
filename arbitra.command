#!/usr/bin/env bash
# Double-click (macOS) or run (Linux) to start arbitra: downloads Node 22 if needed, installs, builds and opens
# http://127.0.0.1:4178. Everything it downloads or builds stays inside this folder (.arbitra-runtime).
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
runtime="$root/.arbitra-runtime"; mkdir -p "$runtime/logs"
version="22.23.2"; port="${ARBITRA_PORT:-4178}"; url="http://127.0.0.1:$port"
say() { echo "arbitra: $*"; }

if command -v node >/dev/null 2>&1 && node --version | grep -q '^v22\.'; then node_bin="$(command -v node)"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform="darwin-arm64" ;; Darwin-x86_64) platform="darwin-x64" ;;
    Linux-x86_64) platform="linux-x64" ;; Linux-aarch64) platform="linux-arm64" ;;
    *) echo "arbitra · no Node 22 for $(uname -s) $(uname -m); install Node 22 from https://nodejs.org" >&2; exit 1 ;;
  esac
  private="$runtime/node-v$version-$platform"
  if [ ! -x "$private/bin/node" ]; then
    say "downloading Node $version (once, about 30 MB)"
    curl -fsSL "https://nodejs.org/dist/v$version/node-v$version-$platform.tar.gz" | tar -xz -C "$runtime"
  fi
  export PATH="$private/bin:$PATH"; node_bin="$private/bin/node"
fi
say "node $("$node_bin" --version)"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# The build calls pnpm from inside pnpm, so pnpm has to be on PATH: corepack puts its shims in this folder.
"$(dirname "$node_bin")/corepack" enable --install-directory "$runtime/bin"
export PATH="$runtime/bin:$PATH"

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
"$node_bin" apps/server/dist/src/serve.js >"$log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT INT TERM
for _ in $(seq 1 60); do sleep 0.5; curl -fs "$url/runs" >/dev/null 2>&1 && break; kill -0 $server 2>/dev/null || { tail -20 "$log"; exit 1; }; done
if command -v open >/dev/null 2>&1; then open "$url"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"; fi
say "running. Keep this window open; close it or press Ctrl+C to stop arbitra."
wait $server
