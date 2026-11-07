#!/bin/bash
# Runs every check for this repo. On success it records the exact code that
# passed, which unlocks `git push` and pull requests (see require-checks.sh).
# Shared template from ServesYouRice/handbook (templates/claude-cloud).
# Only the run_checks function is repo-specific.
set -uo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

run_checks() {
  # The full check (docs/qa/README.md): `pnpm run ci` (typecheck, lint,
  # tests, lint-rule tests, example validation, design integrity, privacy) and
  # `pnpm build`, plus the web app's Playwright acceptance on Chromium,
  # Firefox and WebKit (kept out of `pnpm test` because it needs browsers).
  # Left out: the Docker sandbox acceptance (ARBITRA_DOCKER_ACCEPTANCE, needs
  # a running Docker engine) and the live-provider suites (need funded API
  # keys); both are environment-gated and skip by default.
  # Every step runs; any failure fails the whole check.
  local failed=()
  step() { echo "== $*"; "$@" || failed+=("$*"); }
  step pnpm run ci
  step pnpm build
  step env E2E_PORT=4545 pnpm --filter @arbitra/web e2e
  if [ ${#failed[@]} -gt 0 ]; then
    printf 'FAILED: %s\n' "${failed[@]}" >&2
    return 1
  fi
}

# Hash of the working tree as it would be committed (tracked + new, not ignored).
tree_now() {
  local idx; idx=$(mktemp)
  cp "$(git rev-parse --git-dir)/index" "$idx" 2>/dev/null || rm -f "$idx"
  GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1
  GIT_INDEX_FILE="$idx" git write-tree
  rm -f "$idx"
}

before=$(tree_now)
if ! run_checks; then
  echo "CHECKS FAILED" >&2
  exit 1
fi
after=$(tree_now)
if [ "$before" != "$after" ]; then
  echo "Checks passed but changed files (formatter or generated output)." >&2
  echo "Review the changes and run this script again." >&2
  exit 1
fi
echo "$after" > "$(git rev-parse --git-dir)/claude-checks-passed"
echo "ALL CHECKS PASSED (recorded for tree $after)"
