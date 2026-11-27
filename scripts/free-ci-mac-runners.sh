#!/usr/bin/env bash
# Cancels pull request CI runs that use a macOS runner while a master job
# waits for one, so that the macOS runners go to master.
#
# GitHub cancels a whole run, not one job, so the Linux jobs of these runs stop
# too. Re-run them from the pull request when master is done.
#
# Usage: scripts/free-ci-mac-runners.sh [--dry-run]
set -euo pipefail

MAC_LABEL=xcode-27

cd "$(dirname "${BASH_SOURCE[0]}")/.."

dry_run=false
case "${1:-}" in
  '') ;;
  --dry-run) dry_run=true ;;
  *)
    echo "usage: scripts/free-ci-mac-runners.sh [--dry-run]" >&2
    exit 2
    ;;
esac

# Prints `<id> <event> <branch> <url>` for every queued or in-progress run.
list_active_runs() {
  for status in queued in_progress; do
    gh api --paginate "repos/{owner}/{repo}/actions/runs?status=$status&per_page=100" \
      --jq '.workflow_runs[] | "\(.id) \(.event) \(.head_branch) \(.html_url)"'
  done | sort -u -k1,1
}

# Prints the status of every job of run $1 that runs on a macOS runner.
list_mac_job_statuses() {
  gh api --paginate "repos/{owner}/{repo}/actions/runs/$1/jobs?filter=latest&per_page=100" \
    --jq ".jobs[] | select(.labels | index(\"$MAC_LABEL\")) | .status"
}

runs=$(list_active_runs)

master_waits=false
while read -r id event branch url; do
  [[ -n $id && $event != pull_request && $branch == master ]] || continue
  if list_mac_job_statuses "$id" | grep -q -x queued; then
    echo "master waits for a macOS runner: $url"
    master_waits=true
  fi
done <<<"$runs"

if [[ $master_waits == false ]]; then
  echo "No master job waits for a macOS runner."
  exit 0
fi

cancelled=0
while read -r id event branch url; do
  [[ -n $id && $event == pull_request ]] || continue
  if list_mac_job_statuses "$id" | grep -q -x -E 'queued|in_progress|waiting|pending'; then
    if [[ $dry_run == true ]]; then
      echo "Would cancel ($branch): $url"
    else
      echo "Cancel ($branch): $url"
      gh api --silent -X POST "repos/{owner}/{repo}/actions/runs/$id/cancel" ||
        echo "  Could not cancel run $id." >&2
    fi
    cancelled=$((cancelled + 1))
  fi
done <<<"$runs"

echo "Pull request runs to cancel: $cancelled"
