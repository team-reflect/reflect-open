#!/usr/bin/env bash
# Runs one shard of the WebKit browser tests. A WebKit page crash ends the
# whole Vitest run, so the shard runs once more after a crash. Test failures
# are not retried.
set -uo pipefail

shard=$1
log=$(mktemp)

for attempt in 1 2; do
  pnpm run test run --project '*browser*' --shard="$shard" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ "$status" -eq 0 ] || ! grep -q VITEST_BROWSER_CONNECTION_CLOSED "$log"; then
    exit "$status"
  fi
  echo "::warning::The WebKit page crashed in shard $shard (attempt $attempt)."
done

exit "$status"
