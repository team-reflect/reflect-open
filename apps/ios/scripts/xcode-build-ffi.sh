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
  # cargo and build script settings. A changed CARGO_INCREMENTAL rebuilds
  # every crate.
  CARGO_HTTP_MULTIPLEXING
  CARGO_INCREMENTAL
  CARGO_PROFILE_RELEASE_DEBUG
  CARGO_PROFILE_DEV_DEBUG
  ORT_CACHE_DIR
  # sccache, set by .github/actions/setup-rust.
  RUSTC_WRAPPER
  SCCACHE_CACHE_SIZE
  SCCACHE_CACHE_ZSTD_LEVEL
  SCCACHE_CONF
  SCCACHE_DIR
  SCCACHE_ERROR_LOG
  SCCACHE_GHA_ENABLED
  SCCACHE_GHA_RW_MODE
  SCCACHE_GHA_VERSION
  SCCACHE_IDLE_TIMEOUT
  SCCACHE_LOG
  SCCACHE_MULTILEVEL_CHAIN
  SCCACHE_MULTILEVEL_WRITE_ERROR_POLICY
  SCCACHE_PATH
  SCCACHE_SERVER_PORT
  SCCACHE_SKIP_CACHE_CHECK
  # The GitHub Actions cache service that sccache writes to.
  ACTIONS_CACHE_SERVICE_V2
  ACTIONS_CACHE_URL
  ACTIONS_RESULTS_URL
  ACTIONS_RUNTIME_TOKEN
)
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
