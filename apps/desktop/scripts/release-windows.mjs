// Build the Windows NSIS installer (experimental: unsigned, x64 only).
//
// Usage:
//   pnpm release:windows build [--artifact-dir=<path>]
//
// The installer is not signed and is never uploaded to a GitHub release; CI
// keeps it as a workflow artifact only. See docs/windows-builds.md.

import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mergePatch, STABLE_UPDATER_ENDPOINT } from './release-macos.mjs'

const WINDOWS_TARGET = 'x86_64-pc-windows-msvc'
const BETA_OVERLAY = 'src-tauri/tauri.beta.conf.json'

const here = import.meta.dirname
const appDir = join(here, '..')
const repoRoot = join(here, '..', '..', '..')

function log(message) {
  console.log(`release-windows: ${message}`)
}

function fail(message) {
  console.error(`release-windows: error: ${message}`)
  process.exit(1)
}

/** The app version, from apps/desktop/package.json — the single version source. */
function readAppVersion() {
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    fail('apps/desktop/package.json has no "version"')
  }
  return pkg.version
}

/** Prerelease versions build the beta flavor, mirroring release-macos.mjs. */
export function resolveWindowsFlavor(version) {
  return version.includes('-') ? 'beta' : 'stable'
}

/**
 * Tauri CLI args for the Windows build. NSIS only: WiX rejects prerelease
 * versions like 0.11.0-beta, and the MSI template is per-machine anyway.
 */
export function createWindowsBuildArgs({ flavor }) {
  const args = ['build', '--target', WINDOWS_TARGET, '--bundles', 'nsis']
  if (flavor === 'beta') args.push('--config', BETA_OVERLAY)
  // Same reasoning as release-macos.mjs: the base config commits the beta
  // updater endpoint, so stable builds pin the stable feed at build time.
  if (flavor === 'stable') {
    args.push(
      '--config',
      JSON.stringify({ plugins: { updater: { endpoints: [STABLE_UPDATER_ENDPOINT] } } }),
    )
  }
  return args
}

/**
 * The resolved config for a flavor on Windows: base + tauri.windows.conf.json
 * + flavor overlay, merged like `tauri build --config` does. Only used for
 * the productName in logs and artifact metadata.
 */
function readWindowsFlavorConf(flavor) {
  const read = (name) => {
    const path = join(appDir, 'src-tauri', name)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  }
  let conf = mergePatch(read('tauri.conf.json'), read('tauri.windows.conf.json'))
  if (flavor === 'beta') conf = mergePatch(conf, read('tauri.beta.conf.json'))
  conf.version = readAppVersion()
  return conf
}

/** Find the single NSIS installer in a bundle directory listing. */
export function findSetupExe(fileNames) {
  const installers = fileNames.filter((name) => name.endsWith('-setup.exe'))
  if (installers.length !== 1) {
    throw new Error(
      `expected exactly one *-setup.exe in the NSIS bundle dir, found ${installers.length}`,
    )
  }
  return installers[0]
}

function nsisBundleDir() {
  const metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
  )
  return join(metadata.target_directory, WINDOWS_TARGET, 'release', 'bundle', 'nsis')
}

function build({ artifactDir }) {
  if (process.platform !== 'win32') fail('this command only runs on Windows')
  const version = readAppVersion()
  const flavor = resolveWindowsFlavor(version)
  const conf = readWindowsFlavorConf(flavor)
  log(`building ${conf.productName} ${version} (${flavor}, ${WINDOWS_TARGET}, NSIS, unsigned)`)

  // node_modules/.bin shims are .cmd files on Windows; Node refuses to spawn
  // them without a shell (CVE-2024-27980), and a shell would mangle the JSON
  // --config argument. Invoke the Tauri CLI's JS entry point directly.
  const tauriCli = join(appDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
  const result = spawnSync(process.execPath, [tauriCli, ...createWindowsBuildArgs({ flavor })], {
    cwd: appDir,
    stdio: 'inherit',
  })
  if (result.status !== 0) fail('tauri build failed')

  const bundleDir = nsisBundleDir()
  let installer
  try {
    installer = findSetupExe(readdirSync(bundleDir))
  } catch (error) {
    fail(`${error instanceof Error ? error.message : error} (${bundleDir})`)
  }
  log(`installer: ${join(bundleDir, installer)}`)

  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true })
    copyFileSync(join(bundleDir, installer), join(artifactDir, installer))
    writeFileSync(
      join(artifactDir, 'windows-x64.json'),
      `${JSON.stringify(
        {
          version,
          productName: conf.productName,
          flavor,
          target: WINDOWS_TARGET,
          installer,
          signed: false,
        },
        null,
        2,
      )}\n`,
    )
    log(`exported release artifacts to ${artifactDir}`)
  }
}

const USAGE = `Usage: pnpm release:windows [command] [flags]

Commands:
  build       Build the unsigned Windows x64 NSIS installer (default)

Flags:
  --artifact-dir=<path>  Export the installer and metadata after build
  --help                 Show this help

Docs: docs/windows-builds.md`

async function main() {
  const argv = process.argv.slice(2)
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const command = argv.find((arg) => !arg.startsWith('--')) ?? 'build'
  const artifactDir = flags
    .find((flag) => flag.startsWith('--artifact-dir='))
    ?.slice('--artifact-dir='.length)
  const unknownFlag = flags.find((flag) => flag !== '--help' && !flag.startsWith('--artifact-dir='))
  if (unknownFlag) fail(`unknown flag "${unknownFlag}"\n\n${USAGE}`)
  if (flags.includes('--help')) {
    console.log(USAGE)
    return
  }
  if (command !== 'build') fail(`unknown command "${command}"\n\n${USAGE}`)
  build({ artifactDir })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
