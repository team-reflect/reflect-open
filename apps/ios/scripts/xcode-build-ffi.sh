#!/bin/bash
# The "Build Rust core" phase of Reflect.xcodeproj: builds
# target/apple/ReflectCore.xcframework through scripts/build-ffi.ts for the
# SDK of the current build. A Debug build uses the dev profile.
#
# The Reflect scheme also runs this script as a build pre-action: Xcode reads
# the xcframework and its header while it plans the build, before any build
# phase runs.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

# Xcode launched from the Dock runs script phases with the minimal launchd
# PATH. This file adds node, cargo and the mise shims to it.
if [ ! -f apps/ios/.xcode.env.local ]; then
  echo "error: apps/ios/.xcode.env.local is missing; run \`pnpm install\` once from a terminal" >&2
  exit 1
fi
source apps/ios/.xcode.env.local

args=(--sdk "${PLATFORM_NAME:?}")
if [ "${CONFIGURATION:?}" = "Debug-Dev" ]; then
  args+=(--debug)
fi

# A clean environment: Xcode's SDKROOT and deployment target variables would
# otherwise leak into the host build scripts that cargo compiles for macOS.
#
# - DEVELOPER_DIR stays, so the Rust build uses the Xcode that runs this build.
# - CARGO_INCREMENTAL stays, so cargo reuses the crates that an earlier build
#   with the same value compiled.
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  ${DEVELOPER_DIR:+DEVELOPER_DIR="$DEVELOPER_DIR"} \
  ${CARGO_INCREMENTAL:+CARGO_INCREMENTAL="$CARGO_INCREMENTAL"} \
  ${CARGO_PROFILE_RELEASE_DEBUG:+CARGO_PROFILE_RELEASE_DEBUG="$CARGO_PROFILE_RELEASE_DEBUG"} \
  node scripts/build-ffi.ts "${args[@]}"
