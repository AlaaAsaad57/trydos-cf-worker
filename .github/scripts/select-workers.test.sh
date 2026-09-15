#!/usr/bin/env bash
# Tests for select-workers.sh. Run with: bash .github/scripts/select-workers.test.sh
#
# Each case feeds a changed-file list on stdin and compares the two output
# lines, joined by a space, against what we expect.

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/select-workers.sh"
fails=0
ran=0

# check <name> <expected> <stdin-content>
check() {
  local name="$1" expected="$2" input="$3" actual
  ran=$((ran + 1))
  actual="$(printf '%s' "$input" | bash "$SCRIPT" | tr '\n' ' ' | sed 's/ *$//')"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $name"
  else
    echo "  FAIL  $name"
    echo "          expected: [$expected]"
    echo "          actual:   [$actual]"
    fails=$((fails + 1))
  fi
}

# check_args <name> <expected> <arg...>
check_args() {
  local name="$1" expected="$2"; shift 2
  local actual
  ran=$((ran + 1))
  actual="$(bash "$SCRIPT" "$@" </dev/null | tr '\n' ' ' | sed 's/ *$//')"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $name"
  else
    echo "  FAIL  $name"
    echo "          expected: [$expected]"
    echo "          actual:   [$actual]"
    fails=$((fails + 1))
  fi
}

echo "select-workers.sh"

# --- one Worker only ---
check "proxy source changed"  "proxy=true ingest=false"  'workers/proxy/src/index.ts
'
check "ingest source changed" "proxy=false ingest=true" 'workers/ingest/src/index.ts
'
check "proxy wrangler config changed" "proxy=true ingest=false" 'workers/proxy/wrangler.jsonc
'

# --- shared code and root config deploy both ---
check "shared package changed"  "proxy=true ingest=true" 'packages/shared/src/guards.ts
'
check "root package.json"       "proxy=true ingest=true" 'package.json
'
check "lockfile"                "proxy=true ingest=true" 'pnpm-lock.yaml
'
check "workspace file"          "proxy=true ingest=true" 'pnpm-workspace.yaml
'
check "root tsconfig"           "proxy=true ingest=true" 'tsconfig.json
'

# --- things that must deploy nothing ---
check "docs only"     "proxy=false ingest=false" 'CLAUDE.md
'
check "terraform only" "proxy=false ingest=false" 'infra/waf.tf
'
check "workflow only" "proxy=false ingest=false" '.github/workflows/ci.yml
'
check "empty input"   "proxy=false ingest=false" ''

# --- prefixes must be real directory prefixes, not substrings ---
check "path merely containing workers/proxy" "proxy=false ingest=false" 'docs/workers/proxy/notes.md
'
check "packages/sharedextra is not packages/shared" "proxy=false ingest=false" 'packages/sharedextra/x.ts
'

# --- combinations ---
check "proxy plus docs" "proxy=true ingest=false" 'workers/proxy/src/index.ts
CLAUDE.md
'
check "both Workers" "proxy=true ingest=true" 'workers/proxy/src/index.ts
workers/ingest/src/index.ts
'
check "docs plus shared still deploys both" "proxy=true ingest=true" 'REMAINING.md
packages/shared/src/ingest.ts
'

# --- the force-push fallback ---
check_args "--all ignores stdin" "proxy=true ingest=true" --all

echo
if [ "$fails" -eq 0 ]; then
  echo "All $ran checks passed."
else
  echo "$fails of $ran checks FAILED."
fi
exit "$fails"
