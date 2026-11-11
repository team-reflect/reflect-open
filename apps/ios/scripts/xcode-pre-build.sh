#!/bin/bash
# The pre-action of the Reflect scheme's build.
#
# Xcode checks that ReflectCore.xcframework has a library for the current SDK
# before any build phase runs. The xcframework holds only the slice of the
# last build, so this script builds the Rust core when the xcframework is
# incomplete or that slice is missing: on the first build, after a restored
# build cache, and when the SDK changes between device and simulator.
# The "Build Rust core" phase keeps the slice up to date after that.

set -euo pipefail

scripts_dir="$(dirname "${BASH_SOURCE[0]}")"
xcframework="$scripts_dir/../../../target/apple/ReflectCore.xcframework"

if [ "${PLATFORM_NAME:?}" = "iphonesimulator" ]; then
  slice="ios-arm64-simulator"
else
  slice="ios-arm64"
fi

if [ ! -f "$xcframework/Info.plist" ] || [ ! -d "$xcframework/$slice" ]; then
  "$scripts_dir/xcode-build-ffi.sh"
fi
