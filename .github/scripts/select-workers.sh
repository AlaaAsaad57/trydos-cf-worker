#!/usr/bin/env bash
# Decide which Workers to deploy from a list of changed files.
#
# Reads changed paths on stdin, one per line. Writes two key=value lines so
# the caller can append the result straight to $GITHUB_OUTPUT:
#
#     proxy=true|false
#     ingest=true|false
#
# Pass --all to skip stdin and select both. The workflow uses that when it
# cannot work out a base commit to diff against, for example after a force
# push. Over-deploying is harmless; under-deploying leaves stale code live.

set -euo pipefail

proxy=false
ingest=false

if [ "$#" -gt 0 ]; then
  case "$1" in
    --all)
      echo "proxy=true"
      echo "ingest=true"
      exit 0
      ;;
    *)
      echo "select-workers.sh: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
fi

while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    workers/proxy/*)
      proxy=true
      ;;
    workers/ingest/*)
      ingest=true
      ;;
    # Shared code and root config affect both Workers.
    packages/shared/* | package.json | pnpm-lock.yaml | pnpm-workspace.yaml | tsconfig.json)
      proxy=true
      ingest=true
      ;;
  esac
done

echo "proxy=$proxy"
echo "ingest=$ingest"
