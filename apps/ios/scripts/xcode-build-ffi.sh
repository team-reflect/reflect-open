#!/bin/sh
# The "Build Rust core" phase of Reflect.xcodeproj: builds
# target/apple/ReflectCore.xcframework through scripts/build-ffi.ts for the current
# configuration and SDK. A Debug simulator build compiles only the simulator
# slice with the dev profile; every other build compiles the release profile.
#
# The Reflect scheme also runs this script as a build pre-action when the
# xcframework is missing: Xcode looks for it while it plans the build, before
# any build phase runs.
#
# Xcode launched from the Dock runs script phases with the minimal launchd
# PATH, so node comes from apps/desktop/src-tauri/.xcode.env.local (written by
# `pnpm install`), cargo from rustup's fixed install location, and cbindgen
# from the mise shims.
set -eu

cd "$(dirname "$0")/../../.."

if [ -f apps/desktop/src-tauri/.xcode.env.local ]; then
  . apps/desktop/src-tauri/.xcode.env.local
fi
PATH="$HOME/.local/share/mise/shims:$PATH:$HOME/.cargo/bin"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found; run \`pnpm install\` once from a terminal" >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found on PATH or in \$HOME/.cargo/bin; install rustup" >&2
  exit 1
fi

args=""
if [ "${CONFIGURATION:?}" = "Debug-Dev" ] && [ "${PLATFORM_NAME:?}" = "iphonesimulator" ]; then
  args="--debug"
fi

# A clean environment: Xcode's SDKROOT and deployment target variables would
# otherwise leak into the host build scripts that cargo compiles for macOS.
# DEVELOPER_DIR stays, so the Rust build uses the Xcode that runs this build.
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  ${DEVELOPER_DIR:+DEVELOPER_DIR="$DEVELOPER_DIR"} \
  node scripts/build-ffi.ts $args
