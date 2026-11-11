// Builds `reflect-ffi` for the iOS device and simulator and packs both static
// libraries with the C header into target/apple/ReflectCore.xcframework. It
// regenerates the committed header crates/ffi/include/reflect_core.h, so a
// stale header shows up as a git diff.
//
//   pnpm build:ffi [--debug]
//
//   --debug   Dev profile, simulator only

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'

const ROOT_DIR = join(import.meta.dirname, '..')
const TARGET_DIR = join(ROOT_DIR, 'target')
const APPLE_DIR = join(TARGET_DIR, 'apple')
const TOOLS_DIR = join(APPLE_DIR, 'tools')
const INCLUDE_DIR = join(APPLE_DIR, 'include')
// A subdirectory keeps this `module.modulemap` apart from the ones of other
// libraries that Xcode copies into the same include directory.
const MODULE_DIR = join(INCLUDE_DIR, 'ReflectCoreFFI')
const XCFRAMEWORK_PATH = join(APPLE_DIR, 'ReflectCore.xcframework')
const CRATE_DIR = join(ROOT_DIR, 'crates', 'ffi')
// The committed C header and the module map that declares it.
const CRATE_INCLUDE_DIR = join(CRATE_DIR, 'include')

const CBINDGEN_VERSION = '0.29.4'
const DEVICE_TARGET = 'aarch64-apple-ios'
const SIMULATOR_TARGET = 'aarch64-apple-ios-sim'

/** `tinyexec` options for a command that prints straight to the terminal. */
const INHERIT = { throwOnError: true, nodeOptions: { stdio: 'inherit' } } as const

function log(message: string): void {
  console.log(`[build-ffi] ${message}`)
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
    // FIXME: do not use `cargo install` to install `cbindgen`. Use the root mise.toml instead.
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
  await exec(
    cbindgen,
    [
      '--config',
      join(CRATE_DIR, 'cbindgen.toml'),
      '--output',
      join(CRATE_INCLUDE_DIR, 'reflect_core.h'),
      CRATE_DIR,
    ],
    INHERIT,
  )
  rmSync(INCLUDE_DIR, { recursive: true, force: true })
  mkdirSync(MODULE_DIR, { recursive: true })
  for (const file of ['reflect_core.h', 'module.modulemap']) {
    copyFileSync(join(CRATE_INCLUDE_DIR, file), join(MODULE_DIR, file))
  }

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
