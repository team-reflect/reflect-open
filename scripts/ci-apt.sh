#!/usr/bin/env bash
# Installs apt packages on a GitHub-hosted Ubuntu runner.
#
# A mirror can send data very slowly without stopping. apt moves to the next
# mirror only when no data arrives for 15 seconds, so it can stay on a slow
# mirror for 20 minutes: https://github.com/actions/runner-images/issues/14823
#
# This script gives every network step a time limit. When a step fails, it
# removes the mirror that apt tries first and runs the step again.
#
# Usage:
#   scripts/ci-apt.sh <archives-dir> <package>...
#
# <archives-dir> holds the downloaded package files, so CI can cache it.

set -euo pipefail

MIRROR_LIST=/etc/apt/apt-mirrors.txt
MAX_ATTEMPTS=3
UPDATE_TIMEOUT_SECONDS=90
DOWNLOAD_TIMEOUT_SECONDS=120

# Runs apt-get as root and stops it after $1 seconds.
run_apt() {
  local seconds=$1
  shift
  sudo DEBIAN_FRONTEND=noninteractive \
    timeout --kill-after=10 "$seconds" \
    apt-get --quiet "$@"
}

# Runs apt-get up to MAX_ATTEMPTS times, each attempt within $1 seconds.
# After a failed attempt, apt moves to the next mirror.
run_apt_with_retry() {
  local seconds=$1
  shift

  local attempt
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    if run_apt "$seconds" "$@"; then
      return 0
    fi

    echo "::warning::apt-get $1 failed or ran past ${seconds}s (attempt $attempt of $MAX_ATTEMPTS)"
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      drop_first_mirror
    fi
  done

  return 1
}

# Prints the lines of the mirror list that name a mirror.
# Each line is "<url><tab>priority:<number>".
list_mirrors() {
  grep -v -E '^[[:space:]]*(#|$)' "$MIRROR_LIST" || true
}

# Removes the mirror that apt tries first: the one with the lowest priority number.
drop_first_mirror() {
  if ! grep -q -r -F "mirror+file:$MIRROR_LIST" \
    /etc/apt/sources.list /etc/apt/sources.list.d; then
    echo "The apt sources do not use $MIRROR_LIST. Trying the same mirror again."
    return
  fi

  local mirror_count
  mirror_count=$(list_mirrors | wc -l)
  if [ "$mirror_count" -le 1 ]; then
    echo "Only one mirror is left. Trying the same mirror again."
    return
  fi

  local url options priority
  local first_url=""
  local first_priority=999999
  while read -r url options; do
    priority=999999
    if [[ "$options" =~ priority:([0-9]+) ]]; then
      priority=${BASH_REMATCH[1]}
    fi
    if [ "$priority" -lt "$first_priority" ] || [ -z "$first_url" ]; then
      first_url=$url
      first_priority=$priority
    fi
  done < <(list_mirrors)

  local new_list
  new_list=$(mktemp)
  # Keeps every line whose first field is not the dropped URL.
  awk -v url="$first_url" '$1 != url' "$MIRROR_LIST" > "$new_list"
  sudo cp "$new_list" "$MIRROR_LIST"
  rm "$new_list"

  echo "::warning::apt: removed the mirror $first_url"
  echo "Mirrors left:"
  list_mirrors
}

# Downloads the package lists.
update_package_lists() {
  echo "Mirrors in $MIRROR_LIST:"
  cat "$MIRROR_LIST"
  run_apt_with_retry "$UPDATE_TIMEOUT_SECONDS" update
}

# Downloads the packages into $1, installs them, and removes old package files from $1.
install_packages() {
  local archives_dir=$1
  shift
  local options=(--yes --no-install-recommends -o "Dir::Cache::Archives=$archives_dir")

  mkdir -p "$archives_dir"
  run_apt_with_retry "$DOWNLOAD_TIMEOUT_SECONDS" install --download-only "${options[@]}" "$@"

  # Every package file is in the archives directory now, so this step needs no network.
  # It has no time limit: stopping dpkg halfway leaves packages half installed.
  sudo DEBIAN_FRONTEND=noninteractive apt-get --quiet install --no-download "${options[@]}" "$@"

  # Removes the package files whose versions are no longer in the package lists,
  # so the cache keeps only the current versions.
  sudo apt-get --quiet autoclean -o "Dir::Cache::Archives=$archives_dir"
}

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <archives-dir> <package>..." >&2
  exit 2
fi

update_package_lists
install_packages "$@"
