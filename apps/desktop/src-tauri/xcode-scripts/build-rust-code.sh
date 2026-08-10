#!/bin/bash
# The "Build Rust Code" phase of the generated Xcode project: compiles the
# Rust crate into Externals/<arch>/<config>/libapp.a through the tauri CLI,
# which in dev builds also connects back to the running `tauri ios dev`
# process for the dev-server options. The phase itself is defined in
# ios.project.yml / gen/apple/project.yml.
#
# Xcode launched from the Dock runs script phases with the minimal launchd
# PATH (no Homebrew, no cargo), so nothing here may rely on the caller's
# PATH: the tauri CLI is addressed through the package's own node_modules,
# node comes from the generated src-tauri/.xcode.env.local (written by
# xcode-scripts/generate-xcode-env.mjs on `pnpm install`), and cargo from
# rustup's fixed install location.
set -euo pipefail

# apps/desktop, resolved from this script's own location (src-tauri/xcode-scripts).
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
echo "build-rust-code.sh: working directory: $(pwd)"

# The node toolchain recorded at `pnpm install` time; see the header.
if [ -f src-tauri/.xcode.env.local ]; then
  . src-tauri/.xcode.env.local
fi

echo "PATH: $PATH"

if ! node --version >/dev/null 2>&1; then
  echo "error: no working node found; run \`pnpm install\` once from a terminal to regenerate src-tauri/.xcode.env.local" >&2
  exit 1
fi
echo "build-rust-code.sh: node $(node --version) at $(command -v node)"

# The tauri CLI spawns `cargo` for the Rust build.
if ! command -v cargo >/dev/null 2>&1; then
  PATH="$PATH:$HOME/.cargo/bin"
fi
export PATH
if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found on PATH or in \$HOME/.cargo/bin; install rustup" >&2
  exit 1
fi
echo "build-rust-code.sh: $(cargo --version) at $(command -v cargo)"

# Expansion quoting mirrors the previous inline script exactly; ${ARCHS:?}
# stays unquoted on purpose (Xcode passes a space-separated list).
CI=true exec ./node_modules/.bin/tauri ios xcode-script -v --platform ${PLATFORM_DISPLAY_NAME:?} --sdk-root ${SDKROOT:?} --framework-search-paths "${FRAMEWORK_SEARCH_PATHS:?}" --header-search-paths "${HEADER_SEARCH_PATHS:?}" --gcc-preprocessor-definitions "${GCC_PREPROCESSOR_DEFINITIONS:-}" --configuration ${CONFIGURATION:?} ${FORCE_COLOR:-} ${ARCHS:?}
