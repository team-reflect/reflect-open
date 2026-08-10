#!/bin/bash
# Ad-hoc re-signing for skip-codesign archives, shared by the ShareExtension
# and RecordingWidget targets. The rationale lives with the phase definitions
# in ios.project.yml.
set -euo pipefail

ENV_LOCAL="$(dirname "${BASH_SOURCE[0]}")/../.xcode.env.local"
if [ -f "$ENV_LOCAL" ]; then
  . "$ENV_LOCAL"
fi

# CODE_SIGN_ENTITLEMENTS is per-target and per-configuration (Debug selects
# the .dev entitlements with the dev App Group), so re-sign with the file the
# active build picked rather than hardcoding one.
if [ "${CODE_SIGNING_ALLOWED:-YES}" = "NO" ]; then
  /usr/bin/codesign --force --sign - \
    --entitlements "${SRCROOT:?}/${CODE_SIGN_ENTITLEMENTS:?}" \
    "${CODESIGNING_FOLDER_PATH:?}"
fi
