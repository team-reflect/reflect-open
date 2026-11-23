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
# PATH. This file adds node and cargo to it.
if [ ! -f apps/ios/.xcode.env.local ]; then
  echo "error: apps/ios/.xcode.env.local is missing; run \`pnpm install\` once from a terminal" >&2
  exit 1
fi
source apps/ios/.xcode.env.local

args=(--sdk "${PLATFORM_NAME:?}")
if [ "${CONFIGURATION:?}" = "Debug-Dev" ]; then
  args+=(--debug)
fi

keep=(
  # The Xcode that runs this build.
  DEVELOPER_DIR
  ORT_CACHE_DIR
)
# cargo, rustc and rustup settings, mise's `cargo` wrapper (MISE_*), mbx
# (MBX_*), and its S3 bucket (AWS_*) and GitHub Actions cache (ACTIONS_*).
for name in $(compgen -e); do
  case "$name" in
    CARGO_* | RUSTC_* | RUSTUP_* | MISE_* | MBX_* | SCCACHE_* | AWS_* | ACTIONS_*)
      keep+=("$name")
      ;;
  esac
done
env_args=()
for name in "${keep[@]}"; do
  if [ -n "${!name:-}" ]; then
    env_args+=("$name=${!name}")
  fi
done

# A clean environment: Xcode's SDKROOT and deployment target variables would
# otherwise leak into the host build scripts that cargo compiles for macOS.
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  ${env_args[@]+"${env_args[@]}"} \
  node scripts/build-ffi.ts "${args[@]}"
