// Builds `reflect-ffi` for the iOS device and simulator and packs both static
// libraries with the C header into target/apple/ReflectCore.xcframework.
//
//   pnpm --filter @reflect/ios build:core [--debug]
//
//   --debug   Dev profile, simulator only

// FIXME: 1. move this script into reflect-open/scripts/
// FIXME: 2. add a new reflect-open/scripts/tsconfig.json and link it to the root reflect-open/tsconfig.json
// FIXME: 3. check if apps/ios/tsconfig.json is still needed. If not, remove it.
// FIXME: 4. rename this script to build-ffi.ts

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'

const ROOT_DIR = join(import.meta.dirname, '..', '..', '..')
const TARGET_DIR = join(ROOT_DIR, 'target')
const APPLE_DIR = join(TARGET_DIR, 'apple')
const TOOLS_DIR = join(APPLE_DIR, 'tools')
const INCLUDE_DIR = join(APPLE_DIR, 'include')
// A subdirectory keeps this `module.modulemap` apart from the ones of other
// libraries that Xcode copies into the same include directory.
const MODULE_DIR = join(INCLUDE_DIR, 'ReflectCoreFFI')
const XCFRAMEWORK_PATH = join(APPLE_DIR, 'ReflectCore.xcframework')

const CBINDGEN_VERSION = '0.29.4'
const DEVICE_TARGET = 'aarch64-apple-ios'
const SIMULATOR_TARGET = 'aarch64-apple-ios-sim'

/** `tinyexec` options for a command that prints straight to the terminal. */
const INHERIT = { throwOnError: true, nodeOptions: { stdio: 'inherit' } } as const

// The system libraries and frameworks that the static library links against,
// from `cargo rustc -p reflect-ffi --target aarch64-apple-ios --lib
// --crate-type staticlib -- --print native-static-libs`. The `link` lines let
// Xcode link them with no list in the app target.
const MODULE_MAP = `module ReflectCoreFFI {
    header "reflect_core.h"
    link "iconv"
    link "objc"
    link "z"
    link framework "CoreFoundation"
    link framework "Foundation"
    link framework "Security"
    link framework "UIKit"
    export *
}
`

function log(message: string): void {
  console.log(`[build-core] ${message}`)
}

/** Installs the pinned cbindgen into target/apple/tools and returns its path. */
async function installCbindgen(): Promise<string> {
  const binary = join(TOOLS_DIR, 'bin', 'cbindgen')
  if (existsSync(binary)) {
    const { stdout } = await exec(binary, ['--version'], { throwOnError: true })
    if (stdout.trim() === `cbindgen ${CBINDGEN_VERSION}`) {
      return binary
    }
  }
  await exec(
    'cargo',
    ['install', 'cbindgen', '--version', CBINDGEN_VERSION, '--locked', '--root', TOOLS_DIR],
    INHERIT,
  )
  return binary
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { debug: { type: 'boolean', default: false } } })
  const profile = values.debug ? 'debug' : 'release'
  const targets = values.debug ? [SIMULATOR_TARGET] : [DEVICE_TARGET, SIMULATOR_TARGET]

  const cargoArgs = [
    'build',
    '-p',
    'reflect-ffi',
    ...targets.flatMap((target) => ['--target', target]),
  ]
  if (!values.debug) {
    cargoArgs.push('--release')
  }
  await exec('cargo', cargoArgs, {
    ...INHERIT,
    nodeOptions: {
      ...INHERIT.nodeOptions,
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        // Without line tables the app's dSYM cannot symbolicate Rust frames.
        CARGO_PROFILE_RELEASE_DEBUG: 'line-tables-only',
        // The app's minimum iOS. rustc, the cc crate, and the vendored
        // OpenSSL build otherwise target the SDK version.
        IPHONEOS_DEPLOYMENT_TARGET: '16.0',
      },
    },
  })

  const cbindgen = await installCbindgen()
  rmSync(INCLUDE_DIR, { recursive: true, force: true })
  mkdirSync(MODULE_DIR, { recursive: true })
  const crateDir = join(ROOT_DIR, 'crates', 'ffi')
  await exec(
    cbindgen,
    [
      '--config',
      join(crateDir, 'cbindgen.toml'),
      '--output',
      join(MODULE_DIR, 'reflect_core.h'),
      crateDir,
    ],
    INHERIT,
  )
  writeFileSync(join(MODULE_DIR, 'module.modulemap'), MODULE_MAP)

  rmSync(XCFRAMEWORK_PATH, { recursive: true, force: true })
  const libraries = targets.flatMap((target) => [
    '-library',
    join(TARGET_DIR, target, profile, 'libreflect_ffi.a'),
    '-headers',
    INCLUDE_DIR,
  ])
  await exec(
    'xcodebuild',
    ['-create-xcframework', ...libraries, '-output', XCFRAMEWORK_PATH],
    INHERIT,
  )
  log(`wrote ${XCFRAMEWORK_PATH}`)
}

await main()
