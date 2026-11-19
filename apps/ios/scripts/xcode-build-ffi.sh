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
# - MISE_TRUSTED_CONFIG_PATHS stays, so the mise shims load mise.toml, whose
#   [settings] block needs trust.
# - The CI variables that .github/actions/setup-rust sets stay, so the Rust
#   build runs through sccache and its GitHub Actions cache.
keep=(
  DEVELOPER_DIR
  CARGO_INCREMENTAL
  MISE_TRUSTED_CONFIG_PATHS
  CARGO_PROFILE_RELEASE_DEBUG
  CARGO_HTTP_MULTIPLEXING
  ORT_CACHE_DIR
  RUSTC_WRAPPER
  SCCACHE_PATH
  SCCACHE_CONF
  SCCACHE_DIR
  SCCACHE_CACHE_SIZE
  SCCACHE_CACHE_ZSTD_LEVEL
  SCCACHE_IDLE_TIMEOUT
  SCCACHE_SERVER_PORT
  SCCACHE_LOG
  SCCACHE_ERROR_LOG
  SCCACHE_GHA_ENABLED
  SCCACHE_GHA_RW_MODE
  SCCACHE_GHA_VERSION
  SCCACHE_MULTILEVEL_CHAIN
  SCCACHE_MULTILEVEL_WRITE_ERROR_POLICY
  SCCACHE_SKIP_CACHE_CHECK
  ACTIONS_CACHE_URL
  ACTIONS_CACHE_SERVICE_V2
  ACTIONS_RESULTS_URL
  ACTIONS_RUNTIME_TOKEN
)
env_args=()
for name in "${keep[@]}"; do
  if [ -n "${!name:-}" ]; then
    env_args+=("$name=${!name}")
  fi
done
exec env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  ${env_args[@]+"${env_args[@]}"} \
  node scripts/build-ffi.ts "${args[@]}"
