#!/bin/bash
# Installs what .claude/hooks/check.sh needs, so every Claude web session can
# run the full checks. Runs only in Claude web (cloud) sessions.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

# REPO-SPECIFIC: install dependencies and start services the checks need.
pnpm install --frozen-lockfile

# Browsers for the web app's Playwright acceptance (Chromium, Firefox, WebKit):
# system libraries via apt (retried: another apt process can hold the dpkg
# lock), then the browser builds from cdn.playwright.dev. If the network does
# not allow that host, warn and continue; the browser checks then fail.
for attempt in 1 2 3 4 5 6; do
  pnpm --filter @arbitra/web exec playwright install-deps chromium firefox webkit && break
  [ "$attempt" = 6 ] && exit 1
  sleep 20
done
pnpm --filter @arbitra/web exec playwright install chromium firefox webkit ||
  echo "WARNING: Playwright browsers not installed (is cdn.playwright.dev allowed?). Browser checks will fail; tell the user." >&2
