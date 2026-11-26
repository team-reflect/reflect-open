#!/usr/bin/env bash
# Turns off Spotlight indexing on every volume of a GitHub-hosted macOS runner.
#
# Spotlight indexes every file that the build writes. Right after the runner
# boots, a volume can be in the `kMDConfigSearchLevelTransitioning` state, and
# then `mdutil` exits with an error. This script runs `mdutil` again after a
# short wait. Spotlight only slows the build, so a final failure is a warning.

set -uo pipefail

MAX_ATTEMPTS=3
RETRY_DELAY_SECONDS=5

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if sudo mdutil -a -i off; then
    exit 0
  fi
  echo "::warning::mdutil failed (attempt $attempt of $MAX_ATTEMPTS)"
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    sleep "$RETRY_DELAY_SECONDS"
  fi
done

echo "::warning::Spotlight is still on for some volumes. The build continues."
