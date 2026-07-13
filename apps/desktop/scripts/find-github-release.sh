#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "find-github-release: error: expected one release tag" >&2
  exit 1
fi

repository="${GITHUB_REPOSITORY:-}"
tag="$1"

if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "find-github-release: error: GITHUB_REPOSITORY must be an owner/repository name" >&2
  exit 1
fi
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "find-github-release: error: invalid release tag ${tag}" >&2
  exit 1
fi

# GitHub's releases/tags/<tag> endpoint does not return draft releases. List
# every page and select the exact tag so release-please drafts are visible.
matches="$(
  gh api --paginate "repos/${repository}/releases?per_page=100" |
    jq -cs --arg tag "$tag" '
      if all(.[]; type == "array") then
        [.[][] | select(type == "object" and .tag_name == $tag)]
      else
        error("GitHub releases response contained a non-array page")
      end
    '
)"
match_count="$(jq 'length' <<< "$matches")"

if [ "$match_count" -eq 0 ]; then
  echo null
elif [ "$match_count" -eq 1 ]; then
  jq -c '.[0]' <<< "$matches"
else
  echo "find-github-release: error: multiple releases use tag ${tag}" >&2
  exit 1
fi
