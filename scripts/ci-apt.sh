#!/usr/bin/env bash
# Downloads and installs apt packages on a GitHub-hosted Ubuntu runner.
#
# A mirror can send data very slowly without stopping. apt moves to the next
# mirror only when no data arrives for 15 seconds, so it can stay on a slow
# mirror for 20 minutes: https://github.com/actions/runner-images/issues/14823
#
# This script gives every network step a time limit. When a step fails, it
# removes the mirror that apt tries first and runs the step again.
#
# Usage:
#   scripts/ci-apt.sh <package>...

set -euo pipefail

MIRROR_LIST=/etc/apt/apt-mirrors.txt
MAX_ATTEMPTS=3
UPDATE_TIMEOUT_SECONDS=180
DOWNLOAD_TIMEOUT_SECONDS=240

# Runs apt-get up to MAX_ATTEMPTS times, each attempt within $1 seconds.
retry_apt_get() {
  local seconds=$1
  shift
  local attempt
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    if sudo DEBIAN_FRONTEND=noninteractive timeout --kill-after=10 "$seconds" apt-get --quiet "$@"; then
      return 0
    fi
    echo "::warning::apt-get $1 failed or ran past ${seconds}s (attempt $attempt of $MAX_ATTEMPTS)"
    # The list is sorted by priority, so its first mirror is the one apt tries first.
    if [ "$(grep -c '^http' "$MIRROR_LIST")" -gt 1 ]; then
      sudo sed -i '0,/^http/{/^http/d}' "$MIRROR_LIST"
    fi
  done
  return 1
}

cat "$MIRROR_LIST"
retry_apt_get "$UPDATE_TIMEOUT_SECONDS" update
retry_apt_get "$DOWNLOAD_TIMEOUT_SECONDS" install --download-only --yes --no-install-recommends "$@"
# Every package file is downloaded now. This step has no time limit: stopping
# dpkg halfway leaves packages half installed.
sudo DEBIAN_FRONTEND=noninteractive apt-get --quiet install --no-download --yes --no-install-recommends "$@"
