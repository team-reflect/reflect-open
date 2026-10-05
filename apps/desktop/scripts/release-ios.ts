// Builds the iOS app and uploads it to TestFlight. See docs/ios-testflight.md.
//
//   pnpm release:ios [build]      Build and check the IPA
//   pnpm release:ios preflight    Check the tools, credentials, and app record
//   pnpm release:ios testflight   Build, then upload
//   pnpm release:ios upload       Upload an existing IPA
//   pnpm release:ios validate     Validate an existing IPA // FIXME: remove any scripts that do not use in GitHub Actions. Apply this rule to all scripts in apps/desktop/scripts/*.ts, not only release-ios.ts
//
//   --build-number=<digits>   Default: BUILD_NUMBER, else a UTC timestamp
//   --export-method=<name>    Default: app-store-connect
//   --ipa=<path>              Default: the newest built IPA
//   --wait                    Wait for App Store Connect processing

import { existsSync, globSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'
import { z } from 'zod'
import {
  APP_DIR,
  log,
  resolveApiKey,
  resolveAppleId,
  ROOT_DIR,
  tauri,
  TAURI_SRC_DIR,
  withTempDir,
} from './helpers.ts'

const INHERIT = { throwOnError: true, nodeOptions: { stdio: 'inherit' } } as const
const BUNDLE_IDENTIFIER = 'app.reflect.ios'
const APP_GROUP = 'group.app.reflect'
const SENTRY_DSN_PATTERN =
  /^https:\/\/[0-9a-f]{32}@o463484\.ingest\.us\.sentry\.io\/4511705649971200$/
const buildDir = join(TAURI_SRC_DIR, 'gen', 'apple', 'build')
const archive = join(buildDir, 'reflect-open_iOS.xcarchive')
const appBinary = join(archive, 'Products', 'Applications', 'Reflect.app', 'Reflect')
const dsymBinary = join(
  archive,
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
  readonly ipa: string | undefined
  readonly wait: boolean
}

/** Credentials for altool: the App Store Connect API key, else an Apple ID. */
function resolveCredentials(tempDir: string): Credentials {
  const apiKey = resolveApiKey(tempDir)
  if (apiKey) {
    const keyFile = apiKey.keyPath ? ['--p8-file-path', apiKey.keyPath] : []
    const altoolArgs = ['--api-key', apiKey.keyId, '--api-issuer', apiKey.issuer, ...keyFile]
    return { altoolArgs, env: apiKey.keyPath ? { APPLE_API_KEY_PATH: apiKey.keyPath } : {} }
  }
  const appleId = resolveAppleId()
  if (!appleId)
    throw new Error('no App Store Connect credentials: set APPLE_API_KEY and APPLE_API_ISSUER')
  return {
    altoolArgs: ['--username', appleId.account, '--password', '@env:APPLE_PASSWORD'],
    env: { APPLE_PASSWORD: appleId.password },
  }
}

/** Official builds must report to the production Sentry project or not at all. */
function assertSentryDsn(): void {
  const dsn = process.env.VITE_SENTRY_DSN
  if (dsn && !SENTRY_DSN_PATTERN.test(dsn)) {
    throw new Error('VITE_SENTRY_DSN is not the production Reflect Sentry project')
  }
}

function findNewestIpa(): string {
  const ipas = globSync('**/*.ipa', { cwd: buildDir }).map((path) => join(buildDir, path))
  const newest = ipas.toSorted((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
  if (!newest) throw new Error(`no .ipa under ${buildDir}`)
  return newest
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
  if (appexes.length === 0) throw new Error('the IPA contains no app extension')
  for (const appex of appexes) {
    const display = ['-d', '--entitlements', ':-', join(plugInsDir, appex)]
    const entitlements = (await exec('codesign', display, { throwOnError: true })).stdout
    if (!entitlements.includes(APP_GROUP)) {
      throw new Error(`${appex} is signed without the ${APP_GROUP} App Group entitlement`)
    }
  }
}

async function assertIpa(ipa: string): Promise<void> {
  await withTempDir(async (tempDir) => {
    await exec('unzip', ['-q', ipa, 'Payload/*', '-d', tempDir], { throwOnError: true })
    const payloadDir = join(tempDir, 'Payload')
    const appName = readdirSync(payloadDir).find((name) => name.endsWith('.app'))
    if (!appName) throw new Error('the IPA contains no app')
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
  const uuids = await readUuids(appBinary)
  if (!uuids || uuids !== (await readUuids(dsymBinary))) {
    throw new Error('the archive executable and its dSYM do not have the same UUIDs')
  }
  // The archive strips the executable's symbol table, so look in the dSYM.
  const symbols = await exec('xcrun', ['nm', '-gUj', dsymBinary], { throwOnError: true })
  if (!symbols.stdout.includes('_reflect_start_native_diagnostics')) {
    throw new Error('the app binary does not contain the native diagnostics entry point')
  }
}

async function uploadDebugFiles(): Promise<void> {
  if (!process.env.SENTRY_AUTH_TOKEN)
    return log('SENTRY_AUTH_TOKEN is not set, skipping dSYM upload')
  const project = ['--org', 'reflect-64', '--project', 'reflect-open']
  const upload = ['--type', 'dsym', '--no-sources', '--wait-for', '60', archive]
  const sentryCli = join(APP_DIR, 'node_modules', '.bin', 'sentry-cli')
  await exec(sentryCli, ['debug-files', 'upload', ...project, ...upload], {
    throwOnError: true,
    nodeOptions: { cwd: APP_DIR, stdio: 'inherit' },
  })
}

async function build({ buildNumber, exportMethod }: Options, tempDir: string): Promise<string> {
  assertSentryDsn()
  const apiKey = resolveApiKey(tempDir)
  const config = JSON.stringify({ bundle: { iOS: { bundleVersion: buildNumber } } })
  await tauri(['ios', 'build', '--export-method', exportMethod, '--ci', '--config', config], {
    // Without line tables the dSYM cannot symbolicate Rust frames.
    CARGO_PROFILE_RELEASE_DEBUG: process.env.CARGO_PROFILE_RELEASE_DEBUG ?? 'line-tables-only',
    CI: 'true',
    ...(apiKey?.keyPath ? { APPLE_API_KEY_PATH: apiKey.keyPath } : {}),
  })
  const ipa = findNewestIpa()
  await assertIpa(ipa)
  await assertArchiveSymbols()
  await uploadDebugFiles()
  log(`built ${ipa} (build ${buildNumber})`)
  return ipa
}

async function altool(args: readonly string[], credentials: Credentials): Promise<void> {
  const allArgs = ['altool', ...args, ...credentials.altoolArgs, '--output-format', 'json']
  await exec('xcrun', allArgs, {
    throwOnError: true,
    nodeOptions: { env: credentials.env, stdio: 'inherit' },
  })
}

async function upload(ipa: string, wait: boolean, credentials: Credentials): Promise<void> {
  const waitArgs = wait ? ['--wait'] : []
  await altool(['--upload-package', ipa, '--show-progress', ...waitArgs], credentials)
}

async function preflight(tempDir: string): Promise<void> {
  assertSentryDsn()
  const credentials = resolveCredentials(tempDir)
  await exec('xcodebuild', ['-version'], INHERIT)
  const listArgs = ['altool', '--list-apps', '--filter-bundle-id', BUNDLE_IDENTIFIER]
  const allArgs = [...listArgs, ...credentials.altoolArgs, '--output-format', 'json']
  const { stdout: output } = await exec('xcrun', allArgs, {
    throwOnError: true,
    nodeOptions: { env: credentials.env },
  })
  const apps = z
    .array(z.unknown())
    .parse(JSON.parse(output.slice(output.indexOf('['), output.lastIndexOf(']') + 1)))
  if (apps.length !== 1) {
    throw new Error(
      `expected one App Store Connect app for ${BUNDLE_IDENTIFIER}, found ${apps.length}`,
    )
  }
}

function createTimestampBuildNumber(): string {
  return new Date().toISOString().replaceAll(/\D/g, '').slice(0, 12)
}

function parseOptions(): { command: string; options: Options } {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'build-number': { type: 'string' },
      'export-method': { type: 'string', default: 'app-store-connect' },
      ipa: { type: 'string' },
      wait: { type: 'boolean', default: false },
    },
  })
  const buildNumber =
    values['build-number'] ?? process.env.BUILD_NUMBER ?? createTimestampBuildNumber()
  if (!/^\d+$/.test(buildNumber)) throw new Error(`invalid build number "${buildNumber}"`)
  const options = {
    buildNumber,
    exportMethod: values['export-method'],
    ipa: values.ipa,
    wait: values.wait,
  }
  return { command: positionals[0] ?? 'build', options }
}

function resolveIpa(path: string | undefined): string {
  if (!path) return findNewestIpa()
  return existsSync(path) ? resolve(path) : resolve(ROOT_DIR, path)
}

async function runCommand(command: string, options: Options, tempDir: string): Promise<void> {
  if (command === 'build') {
    await build(options, tempDir)
    return
  }
  if (command === 'preflight') return await preflight(tempDir)
  // Resolved before the build, so missing credentials fail in seconds.
  const credentials = resolveCredentials(tempDir)
  switch (command) {
    case 'testflight':
      return await upload(await build(options, tempDir), options.wait, credentials)
    case 'upload': {
      const ipa = resolveIpa(options.ipa)
      await assertIpa(ipa)
      return await upload(ipa, options.wait, credentials)
    }
    case 'validate':
      return await altool(['--validate-app', resolveIpa(options.ipa)], credentials)
    default:
      throw new Error(`unknown command "${command}"`)
  }
}

async function main(): Promise<void> {
  // FIXME:
  // For better reaablity, alwyas use {} in the apps/desktop/scripts/*.ts
  // good: if (xxx) { throw new Error() }
  // bad: if (xxx) throw new Error()
  // good: if (xxx) { return await yyy() }
  // bad: if (xxx) return await yyy()
  if (process.platform !== 'darwin') throw new Error('iOS releases only run on macOS')
  const { command, options } = parseOptions()
  await withTempDir((tempDir) => runCommand(command, options, tempDir))
}

await main()
