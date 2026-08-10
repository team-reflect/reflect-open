#!/bin/bash
# Ad-hoc re-signing for skip-codesign archives of the RecordingWidget target.
# The rationale lives with the phase definition in ios.project.yml.
set -euo pipefail

ENV_LOCAL="$(dirname "${BASH_SOURCE[0]}")/../.xcode.env.local"
if [ -f "$ENV_LOCAL" ]; then
  . "$ENV_LOCAL"
fi

if [ "${CODE_SIGNING_ALLOWED:-YES}" = "NO" ]; then
  /usr/bin/codesign --force --sign - \
    --entitlements "${SRCROOT:?}/RecordingWidget/RecordingWidget.entitlements" \
    "${CODESIGNING_FOLDER_PATH:?}"
fi
