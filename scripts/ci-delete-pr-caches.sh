#!/usr/bin/env bash
# Deletes the largest GitHub Actions caches of a pull request.
#
# Only the 100 largest caches are deleted: they hold most of the size, and
# each delete is one API request against a limit of 1000 requests per hour.
#
# Usage:
#   scripts/ci-delete-pr-caches.sh <pr-number>
#
# Needs GH_TOKEN and GH_REPO, or a gh login inside a checkout.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <pr-number>" >&2
  exit 2
fi

ref="refs/pull/$1/merge"

gh cache list --ref "$ref" --sort size_in_bytes --order desc --limit 100 \
  --json id,key,sizeInBytes \
  --jq '.[] | [.id, .sizeInBytes, .key] | @tsv' |
  while IFS=$'\t' read -r id size key; do
    echo "Deleting $key ($((size / 1024 / 1024)) MiB)"
    # A failed delete must not stop the others.
    gh cache delete "$id" || true
    # GitHub asks for one mutating request per second.
    sleep 1
  done
