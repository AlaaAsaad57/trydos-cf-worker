#!/usr/bin/env bash
# Push the seven backend base URLs to the Worker as secrets.
#
# Reads them from trydos's env file so nobody has to copy values by hand, and
# pipes each one to `wrangler secret put` over stdin so it is never printed,
# never echoed, and never lands in shell history. Only the NAME of each secret
# is logged.
#
# Requires `wrangler login` first — this writes to your Cloudflare account.
#
# Usage:  bash scripts/put-secrets.sh [path-to-env-file]

set -euo pipefail

# Resolve everything relative to THIS script, not the caller's cwd, so the
# command works from the repo root or anywhere else. wrangler also needs to run
# beside wrangler.jsonc, so cd there explicitly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(dirname "$SCRIPT_DIR")"
cd "$WORKER_DIR"

ENV_FILE="${1:-$WORKER_DIR/../../../trydos/.env.production}"

if [ ! -f "$ENV_FILE" ]; then
  echo "env file not found: $ENV_FILE" >&2
  echo "pass the path explicitly: bash scripts/put-secrets.sh /path/to/.env" >&2
  exit 1
fi

SECRETS=(
  BACKEND_URL
  GO_BACKEND_URL
  ELASTIC_BACKEND_URL
  NEXT_PUBLIC_CHAT_BACKEND_URL
  STORIES_BACKEND_URL
  COMMENT_BACKEND_URL
  WALLET_BACKEND_URL
)

# Read one KEY=value from the env file. Takes the LAST match, which is what a
# dotenv loader does when a key is repeated, and strips surrounding quotes,
# inline whitespace and CRLF line endings.
read_env() {
  grep -E "^[[:space:]]*${1}=" "$ENV_FILE" \
    | tail -n 1 \
    | sed -e "s/^[[:space:]]*${1}=//" \
          -e 's/[[:space:]]*$//' \
          -e 's/\r$//' \
          -e 's/^"\(.*\)"$/\1/' \
          -e "s/^'\(.*\)'\$/\1/"
}

missing=0
for name in "${SECRETS[@]}"; do
  value="$(read_env "$name" || true)"
  if [ -z "$value" ]; then
    echo "  MISSING  $name  (not in $ENV_FILE)" >&2
    missing=1
    continue
  fi
  # Value goes over stdin; only the name is ever visible.
  printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null
  echo "  set      $name"
done

if [ "$missing" -ne 0 ]; then
  echo >&2
  echo "Some secrets were not found. The Worker treats a missing base URL as a" >&2
  echo "proxy failure (503), so fix these before cutting any traffic over." >&2
  exit 1
fi

echo
echo "All seven set. Verify with: npx wrangler secret list"
