// Builds `reflect-ffi` for the iOS device and simulator and packs both static
// libraries with the C header into target/apple/ReflectCore.xcframework. It
// regenerates the committed header crates/ffi/include/reflect_core.h, so a
// stale header shows up as a git diff.
//
//   pnpm build:ffi [--debug] [--sdk <sdk>]
//
//   --debug   Dev profile
//   --sdk     Build one slice only: `iphoneos` or `iphonesimulator`
//
// The xcframework is packed again only when a library, a header or the set of
// slices changed, so an unchanged build leaves Xcode nothing to relink.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'

const ROOT_DIR = join(import.meta.dirname, '..')
const TARGET_DIR = join(ROOT_DIR, 'target')
const APPLE_DIR = join(TARGET_DIR, 'apple')
const INCLUDE_DIR = join(APPLE_DIR, 'include')
// A subdirectory keeps this `module.modulemap` apart from the ones of other
// libraries that Xcode copies into the same include directory.
const MODULE_DIR = join(INCLUDE_DIR, 'ReflectCoreFFI')
const XCFRAMEWORK_PATH = join(APPLE_DIR, 'ReflectCore.xcframework')
// Describes the inputs of the packed xcframework.
const STAMP_PATH = join(APPLE_DIR, 'ReflectCore.xcframework.stamp')
const CRATE_DIR = join(ROOT_DIR, 'crates', 'ffi')
// The committed C header and the module map that declares it.
const CRATE_INCLUDE_DIR = join(CRATE_DIR, 'include')

const TARGET_BY_SDK: Record<string, string> = {
  iphoneos: 'aarch64-apple-ios',
  iphonesimulator: 'aarch64-apple-ios-sim',
}

/** `tinyexec` options for a command that prints straight to the terminal. */
const INHERIT = { throwOnError: true, nodeOptions: { stdio: 'inherit' } } as const

function log(message: string): void {
  console.log(`[build-ffi] ${message}`)
}

/** The Rust targets to build: the one of `sdk`, or every target. */
function selectTargets(sdk: string | undefined): string[] {
  if (sdk === undefined) {
    return Object.values(TARGET_BY_SDK)
  }
  const target = Object.hasOwn(TARGET_BY_SDK, sdk) ? TARGET_BY_SDK[sdk] : undefined
  if (target === undefined) {
    throw new Error(`--sdk must be one of: ${Object.keys(TARGET_BY_SDK).join(', ')}`)
  }
  return [target]
}

/** The paths and modification times of the files that go into the xcframework. */
function stampOf(files: string[]): string {
  return files.map((file) => `${file} ${statSync(file).mtimeMs}`).join('\n')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { debug: { type: 'boolean', default: false }, sdk: { type: 'string' } },
  })
  const profile = values.debug ? 'debug' : 'release'
  const targets = selectTargets(values.sdk)

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

  await exec(
    'cbindgen',
    [
      '--config',
      join(CRATE_DIR, 'cbindgen.toml'),
      '--output',
      join(CRATE_INCLUDE_DIR, 'reflect_core.h'),
      CRATE_DIR,
    ],
    INHERIT,
  )
  const libraryPaths = targets.map((target) => {
    return join(TARGET_DIR, target, profile, 'libreflect_ffi.a')
  })
  const headerPaths = ['reflect_core.h', 'module.modulemap'].map((file) => {
    return join(CRATE_INCLUDE_DIR, file)
  })
  const stamp = stampOf([...libraryPaths, ...headerPaths])
  const isFresh =
    existsSync(join(XCFRAMEWORK_PATH, 'Info.plist')) &&
    existsSync(STAMP_PATH) &&
    readFileSync(STAMP_PATH, 'utf8') === stamp
  if (isFresh) {
    log(`up to date: ${XCFRAMEWORK_PATH}`)
    return
  }

  rmSync(INCLUDE_DIR, { recursive: true, force: true })
  mkdirSync(MODULE_DIR, { recursive: true })
  for (const header of headerPaths) {
    copyFileSync(header, join(MODULE_DIR, basename(header)))
  }

  rmSync(STAMP_PATH, { force: true })
  rmSync(XCFRAMEWORK_PATH, { recursive: true, force: true })
  const libraries = libraryPaths.flatMap((library) => [
    '-library',
    library,
    '-headers',
    INCLUDE_DIR,
  ])
  await exec(
    'xcodebuild',
    ['-create-xcframework', ...libraries, '-output', XCFRAMEWORK_PATH],
    INHERIT,
  )
  writeFileSync(STAMP_PATH, stamp)
  log(`wrote ${XCFRAMEWORK_PATH}`)
}

await main()
