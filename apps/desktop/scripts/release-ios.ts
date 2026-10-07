// Builds the iOS app, checks it, and uploads it to TestFlight. See docs/ios-testflight.md.
//
//   pnpm release:ios --build-number=<digits> [--export-method=<name>]
//
//   --build-number=<digits>   Required
//   --export-method=<name>    Default: app-store-connect
//   --no-upload               Build and check only: no Sentry or TestFlight upload

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'
import {
  APP_DIR,
  INHERIT,
  log,
  resolveApiKey,
  runTauri,
  runWithTempDir,
  TAURI_SRC_DIR,
} from './helpers.ts'

const BUNDLE_IDENTIFIER = 'app.reflect.ios'
const APP_GROUP = 'group.app.reflect'
const SENTRY_DSN_PATTERN =
  /^https:\/\/[0-9a-f]{32}@o463484\.ingest\.us\.sentry\.io\/4511705649971200$/
const BUILD_DIR = join(TAURI_SRC_DIR, 'gen', 'apple', 'build')
const ARCHIVE_PATH = join(BUILD_DIR, 'reflect-open_iOS.xcarchive')
const IPA_PATH = join(BUILD_DIR, 'arm64', 'Reflect.ipa')

const APP_BINARY_PATH = join(ARCHIVE_PATH, 'Products', 'Applications', 'Reflect.app', 'Reflect')
const DSYM_BINARY_PATH = join(
  ARCHIVE_PATH,
  'dSYMs',
  'Reflect.app.dSYM',
  'Contents',
  'Resources',
  'DWARF',
  'Reflect',
)

interface Credentials {
  readonly altoolArgs: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

interface Options {
  readonly buildNumber: string
  readonly exportMethod: string
  readonly upload: boolean
}

/** The App Store Connect API key, as altool arguments and as the environment Tauri reads. */
function resolveCredentials(tempDir: string): Credentials {
  const apiKey = resolveApiKey(tempDir)
  if (!apiKey) {
    throw new Error('the App Store Connect API key is not set')
  }
  const { keyId, issuer, keyPath } = apiKey
  return {
    altoolArgs: ['--api-key', keyId, '--api-issuer', issuer, '--p8-file-path', keyPath],
    env: { APPLE_API_KEY_PATH: keyPath },
  }
}

/** Official builds must report to the production Sentry project or not at all. */
function assertSentryDsn(): void {
  const dsn = process.env.VITE_SENTRY_DSN
  if (dsn && !SENTRY_DSN_PATTERN.test(dsn)) {
    throw new Error('VITE_SENTRY_DSN is not the production Reflect Sentry project')
  }
}

async function readInfoValue(app: string, key: string): Promise<string> {
  const args = ['-extract', key, 'raw', '-o', '-', join(app, 'Info.plist')]
  return (await exec('plutil', args, { throwOnError: true })).stdout.trim()
}

/**
 * Export re-signs the share extension. Without its App Group entitlement the
 * build installs and launches, but every share fails.
 */
async function assertAppexEntitlements(app: string): Promise<void> {
  const plugInsDir = join(app, 'PlugIns')
  const appexes = existsSync(plugInsDir) ? readdirSync(plugInsDir) : []
  if (appexes.length === 0) {
    throw new Error('the IPA contains no app extension')
  }
  for (const appex of appexes) {
    const display = ['-d', '--entitlements', ':-', join(plugInsDir, appex)]
    const entitlements = (await exec('codesign', display, { throwOnError: true })).stdout
    if (!entitlements.includes(APP_GROUP)) {
      throw new Error(`${appex} is signed without the ${APP_GROUP} App Group entitlement`)
    }
  }
}

async function assertIpa(): Promise<void> {
  await runWithTempDir(async (tempDir) => {
    await exec('unzip', ['-q', IPA_PATH, 'Payload/*', '-d', tempDir], { throwOnError: true })
    const payloadDir = join(tempDir, 'Payload')
    const appName = readdirSync(payloadDir).find((name) => name.endsWith('.app'))
    if (!appName) {
      throw new Error('the IPA contains no app')
    }
    const app = join(payloadDir, appName)

    const identifier = await readInfoValue(app, 'CFBundleIdentifier')
    if (identifier !== BUNDLE_IDENTIFIER) {
      throw new Error(`IPA bundle identifier is ${identifier}, expected ${BUNDLE_IDENTIFIER}`)
    }
    if ((await readInfoValue(app, 'ITSAppUsesNonExemptEncryption')) !== 'false') {
      throw new Error('ITSAppUsesNonExemptEncryption must be false')
    }
    await assertAppexEntitlements(app)
  })
}

async function readUuids(binary: string): Promise<string> {
  const output = (await exec('xcrun', ['dwarfdump', '--uuid', binary], { throwOnError: true }))
    .stdout
  return [...output.matchAll(/^UUID: ([0-9A-F-]{36})/gim)]
    .map((match) => match[1])
    .toSorted()
    .join(',')
}

/** A crash report can only be symbolicated with the dSYM of the exact shipped executable. */
async function assertArchiveSymbols(): Promise<void> {
  const uuids = await readUuids(APP_BINARY_PATH)
  if (!uuids || uuids !== (await readUuids(DSYM_BINARY_PATH))) {
    throw new Error('the archive executable and its dSYM do not have the same UUIDs')
  }
  // The archive strips the executable's symbol table, so look in the dSYM.
  const symbols = await exec('xcrun', ['nm', '-gUj', DSYM_BINARY_PATH], { throwOnError: true })
  if (!symbols.stdout.includes('_reflect_start_native_diagnostics')) {
    throw new Error('the app binary does not contain the native diagnostics entry point')
  }
}

async function uploadDebugFiles(): Promise<void> {
  const project = ['--org', 'reflect-64', '--project', 'reflect-open']
  const upload = ['--type', 'dsym', '--no-sources', '--wait-for', '60', ARCHIVE_PATH]
  const sentryCli = join(APP_DIR, 'node_modules', '.bin', 'sentry-cli')
  await exec(sentryCli, ['debug-files', 'upload', ...project, ...upload], INHERIT)
}

async function build(
  { buildNumber, exportMethod, upload }: Options,
  credentials: Credentials,
): Promise<void> {
  const config = JSON.stringify({ bundle: { iOS: { bundleVersion: buildNumber } } })
  await runTauri(['ios', 'build', '--export-method', exportMethod, '--ci', '--config', config], {
    // Without line tables the dSYM cannot symbolicate Rust frames.
    CARGO_PROFILE_RELEASE_DEBUG: 'line-tables-only',
    ...credentials.env,
  })
  await assertIpa()
  await assertArchiveSymbols()
  if (upload) {
    await uploadDebugFiles()
  }
  log(`built ${IPA_PATH} (build ${buildNumber})`)
}

async function runAltool(args: readonly string[], credentials: Credentials): Promise<void> {
  const allArgs = ['altool', ...args, ...credentials.altoolArgs, '--output-format', 'json']
  await exec('xcrun', allArgs, {
    throwOnError: true,
    nodeOptions: { env: credentials.env, stdio: 'inherit' },
  })
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'build-number': { type: 'string', default: '' },
      'export-method': { type: 'string', default: 'app-store-connect' },
      'no-upload': { type: 'boolean', default: false },
    },
  })
  const buildNumber = values['build-number']
  if (!/^\d+$/.test(buildNumber)) {
    throw new Error(`invalid build number "${buildNumber}"`)
  }
  assertSentryDsn()

  await runWithTempDir(async (tempDir) => {
    const credentials = resolveCredentials(tempDir)
    const upload = !values['no-upload']
    await build({ buildNumber, exportMethod: values['export-method'], upload }, credentials)
    if (upload) {
      // --wait blocks until App Store Connect has processed the build.
      await runAltool(['--upload-package', IPA_PATH, '--show-progress', '--wait'], credentials)
    }
  })
}

await main()
