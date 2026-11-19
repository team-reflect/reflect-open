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

# Runs apt-get up to 3 times, each attempt within 240 seconds.
retry_apt_get() {
  local attempt
  for attempt in 1 2 3; do
    if sudo DEBIAN_FRONTEND=noninteractive timeout --kill-after=10 240 apt-get --quiet "$@"; then
      return 0
    fi
    echo "::warning::apt-get $1 failed or ran past 240s (attempt $attempt of 3)"
    # The list is sorted by priority, so its first mirror is the one apt tries first.
    if [ "$(grep -c '^http' "$MIRROR_LIST")" -gt 1 ]; then
      sudo sed -i '0,/^http/{/^http/d}' "$MIRROR_LIST"
    fi
  done
  return 1
}

cat "$MIRROR_LIST"
retry_apt_get update
retry_apt_get install --download-only --yes --no-install-recommends "$@"
# Every package file is downloaded now. This step has no time limit: stopping
# dpkg halfway leaves packages half installed.
sudo DEBIAN_FRONTEND=noninteractive apt-get --quiet install --no-download --yes --no-install-recommends "$@"
