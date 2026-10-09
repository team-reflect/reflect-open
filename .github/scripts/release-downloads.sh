#!/usr/bin/env bash
# Prints the download section of the release notes: one badge per installer,
# each linked to that installer.
#
# Usage: release-downloads.sh --repo <owner/name> --tag <tag> --version <version> --asset <prefix> [asset-name ...]
#
#   --repo     repository that holds the release, for example team-reflect/reflect-open
#   --tag      release tag, for example v0.15.0-beta.5
#   --version  version shown on each badge, for example 0.15.0-beta.5
#   --asset    asset name prefix, for example Reflect.Beta
#
# The remaining arguments are the asset names of the release. An installer
# that is not in this list gets no badge.
set -euo pipefail

repo='' tag='' version='' asset=''
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --tag) tag="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --asset) asset="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
if [ -z "$repo" ] || [ -z "$tag" ] || [ -z "$version" ] || [ -z "$asset" ]; then
  echo 'usage: release-downloads.sh --repo <owner/name> --tag <tag> --version <version> --asset <prefix> [asset-name ...]' >&2
  exit 2
fi

badge() {
  local file="$1" label="$2" color="$3" icon="$4"
  if grep -qxF -- "$file" <<< "$published"; then
    printf '[![%s](https://badgen.net/badge/%s/v%s/%s?icon=%s&style=flat)](https://github.com/%s/releases/download/%s/%s) ' \
      "$label" "${label// /%20}" "$version" "$color" "$icon" "$repo" "$tag" "$file"
  fi
}

section() {
  local title="$1" badges="$2"
  if [ -n "$badges" ]; then
    printf '\n### %s\n\n%s\n' "$title" "${badges% }"
  fi
}

published="$(printf '%s\n' "$@")"
macos="$(badge "${asset}_aarch64.dmg" 'macOS Apple Silicon' 7C3AED apple)$(badge "${asset}_x86_64.dmg" 'macOS Intel' D97706 apple)"
windows="$(badge "${asset}_${version}_x64-setup.exe" 'Windows x64' 2563EB windows)$(badge "${asset}_${version}_arm64-setup.exe" 'Windows ARM64' 0D9488 windows)"

if [ -n "$macos$windows" ]; then
  printf '## Download\n'
  section macOS "$macos"
  section Windows "$windows"
fi
