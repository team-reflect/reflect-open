#!/bin/sh
# The "Build Rust core" phase of Reflect.xcodeproj: builds
# target/apple/ReflectCore.xcframework through `build:core` for the current
# configuration and SDK. A Debug simulator build compiles only the simulator
# slice with the dev profile; every other build compiles the release profile.
#
# Xcode launched from the Dock runs script phases with the minimal launchd
# PATH, so node comes from apps/desktop/src-tauri/.xcode.env.local (written by
# `pnpm install`) and cargo from rustup's fixed install location.
set -eu

cd "$(dirname "$0")/.."

if [ -f ../desktop/src-tauri/.xcode.env.local ]; then
  . ../desktop/src-tauri/.xcode.env.local
fi
PATH="$PATH:$HOME/.cargo/bin"

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
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  node scripts/build-core.ts $args
