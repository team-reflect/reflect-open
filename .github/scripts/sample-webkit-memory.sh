#!/usr/bin/env bash
# Prints the system memory, the largest processes, and the footprint of each
# Playwright WebKit content process every 5 seconds, until killed.
set -u

while true; do
  echo "== $(date -u +%FT%TZ) $(memory_pressure -Q | tail -1)"
  ps -Ao rss=,pid=,ucomm= -m | head -8
  for pid in $(pgrep -f 'ms-playwright/webkit.*WebContent'); do
    footprint -p "$pid" 2>/dev/null | grep -m1 'Footprint:'
  done
  sleep 5
done
