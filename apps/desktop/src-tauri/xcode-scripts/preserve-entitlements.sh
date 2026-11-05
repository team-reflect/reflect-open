#!/bin/bash
# Ad-hoc re-signing for skip-codesign archives, shared by the ShareExtension
# and RecordingWidget targets. The rationale lives with the phase definitions
# in ios.project.yml.
set -euo pipefail

ENV_LOCAL="$(dirname "${BASH_SOURCE[0]}")/../.xcode.env.local"
if [ -f "$ENV_LOCAL" ]; then
  . "$ENV_LOCAL"
fi

# The path comes from REFLECT_CODE_SIGN_ENTITLEMENTS rather than
# $CODE_SIGN_ENTITLEMENTS: skip-codesign builds are exactly the flow where
# tauri blanks that setting on the xcodebuild command line (cargo-mobile2
# src/apple/target.rs passes CODE_SIGN_ENTITLEMENTS="" when skipping
# codesign), and a command-line override beats every target setting. Each
# configuration sets REFLECT_CODE_SIGN_ENTITLEMENTS to its flavor's file.
if [ "${CODE_SIGNING_ALLOWED:-YES}" = "NO" ]; then
  /usr/bin/codesign --force --sign - \
    --entitlements "${SRCROOT:?}/${REFLECT_CODE_SIGN_ENTITLEMENTS:?}" \
    "${CODESIGNING_FOLDER_PATH:?}"
fi
