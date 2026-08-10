#!/bin/bash
# Ad-hoc re-signing for skip-codesign archives, shared by the ShareExtension
# and RecordingWidget targets (each passes its own entitlements file). The
# rationale lives with the phase definition in ios.project.yml.
#
# Usage: preserve-entitlements.sh <path-to-entitlements-file>
set -euo pipefail

ENV_LOCAL="$(dirname "${BASH_SOURCE[0]}")/../.xcode.env.local"
if [ -f "$ENV_LOCAL" ]; then
  . "$ENV_LOCAL"
fi

if [ "${CODE_SIGNING_ALLOWED:-YES}" = "NO" ]; then
  /usr/bin/codesign --force --sign - \
    --entitlements "${1:?usage: preserve-entitlements.sh <entitlements-file>}" \
    "${CODESIGNING_FOLDER_PATH:?}"
fi
