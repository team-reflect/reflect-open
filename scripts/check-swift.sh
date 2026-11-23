#!/bin/bash
# Checks the format and lint of every tracked Swift file. With `--fix`, formats
# the files in place instead.
#
# Usage: scripts/check-swift.sh [--fix]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

fix=false
case "${1:-}" in
  '') ;;
  --fix) fix=true ;;
  *)
    echo "usage: scripts/check-swift.sh [--fix]" >&2
    exit 2
    ;;
esac

swift --version
swift format --version

if [ "$fix" = true ]; then
  git ls-files -z '*.swift' | xargs -0 swift format format --parallel --in-place
else
  # Lint mode also reports every line that `swift format format` would change.
  git ls-files -z '*.swift' | xargs -0 swift format lint --strict --parallel
fi
