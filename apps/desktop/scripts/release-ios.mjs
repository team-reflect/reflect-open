// Build and upload Reflect's iOS app to TestFlight.
//
// Usage:
//   pnpm release:ios build --build-number=123
//   pnpm release:ios testflight --wait
//   pnpm release:ios upload --ipa=apps/desktop/src-tauri/gen/apple/build/arm64/Reflect.ipa
//
// The App Store Connect API key is used twice when present:
//   1. Tauri/xcodebuild provisioning auth via APPLE_API_KEY* env vars
//   2. altool IPA upload auth via --api-key/--api-issuer
//
// Set APPLE_API_KEY, APPLE_API_ISSUER, and either APPLE_API_KEY_CONTENT or
// APPLE_API_KEY_PATH. See docs/ios-testflight.md.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_EXPORT_METHOD = 'app-store-connect'
const EXPORT_METHODS = new Set(['app-store-connect', 'release-testing', 'debugging', 'validation'])
const IOS_BUNDLE_IDENTIFIER = 'app.reflect.ios'
const OLD_CAPACITOR_BUNDLE_IDENTIFIER = 'app.reflect.ReflectMobile'
const NON_EXEMPT_ENCRYPTION_KEY = 'ITSAppUsesNonExemptEncryption'
const KEYCHAIN_SERVICE = 'reflect-notary'
const SHARE_EXTENSION_APP_GROUP = 'group.app.reflect'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const repoRoot = join(here, '..', '..', '..')
const iosBuildDir = join(appDir, 'src-tauri', 'gen', 'apple', 'build')

function log(message) {
  console.log(`release-ios: ${message}`)
}

function fail(message) {
  console.error(`release-ios: error: ${message}`)
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function capture(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' })
}

/** Build the altool authentication args for an App Store Connect API key. */
export function createApiKeyAltoolArgs({ issuerId, keyId, keyPath }) {
  const args = ['--api-key', keyId, '--api-issuer', issuerId]
  if (keyPath) args.push('--p8-file-path', keyPath)
  return args
}

/** Build the Tauri iOS archive/export command. */
export function createTauriIosBuildArgs({
  buildNumber = null,
  exportMethod = DEFAULT_EXPORT_METHOD,
  verbose = false,
}) {
  const args = ['tauri', 'ios', 'build', '--export-method', exportMethod, '--ci']
  if (buildNumber) args.push('--config', JSON.stringify({ bundle: { iOS: { bundleVersion: buildNumber } } }))
  if (verbose) args.push('--verbose')
  return args
}

/** Build the environment Tauri's iOS signing layer needs for API-key auth. */
export function createTauriIosBuildEnv({ apiKeyCredentials = null, baseEnv = process.env } = {}) {
  return { ...baseEnv, CI: 'true', ...(apiKeyCredentials?.env ?? {}) }
}

/** Build the altool command that uploads an IPA to App Store Connect/TestFlight. */
export function createAltoolUploadArgs({ authArgs, ipa, wait }) {
  const args = ['altool', '--upload-package', ipa, ...authArgs, '--output-format', 'json', '--show-progress']
  if (wait) args.push('--wait')
  return args
}

/** Build the altool command that validates an IPA before upload. */
export function createAltoolValidateArgs({ authArgs, ipa }) {
  return ['altool', '--validate-app', ipa, ...authArgs, '--output-format', 'json']
}

/** Build the altool command that checks for an App Store Connect app record. */
export function createAltoolListAppsArgs({ authArgs, bundleIdentifier }) {
  return ['altool', '--list-apps', '--filter-bundle-id', bundleIdentifier, ...authArgs, '--output-format', 'json']
}

/** Return the standard App Store Connect API key lookup locations for altool. */
export function appStoreConnectPrivateKeySearchPaths({ cwd, homeDir, keyId }) {
  const fileName = `AuthKey_${keyId}.p8`
  return [
    join(cwd, 'private_keys', fileName),
    join(homeDir, 'private_keys', fileName),
    join(homeDir, '.private_keys', fileName),
    join(homeDir, '.appstoreconnect', 'private_keys', fileName),
  ]
}

/** Normalize API key secret content from either raw .p8 text or base64-wrapped text. */
export function normalizeApiKeyContent(content) {
  const trimmed = content.trim()
  if (trimmed.includes('BEGIN PRIVATE KEY')) return `${trimmed}\n`

  const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim()
  if (decoded.includes('BEGIN PRIVATE KEY')) return `${decoded}\n`

  return `${trimmed}\n`
}

/** Find the app Info.plist inside an IPA's unzip listing. */
export function findIpaInfoPlistPath(listing) {
  const matches = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(line))
  if (matches.length !== 1) {
    throw new Error(`expected exactly one app Info.plist in IPA, found ${matches.length}`)
  }
  return matches[0]
}

/** Return true when an Info.plist raw value represents boolean false. */
export function isFalsePlistValue(value) {
  return ['false', 'no', '0'].includes(value.trim().toLowerCase())
}

/** Find every app-extension bundle path inside an IPA's unzip listing. */
export function findIpaAppexPaths(listing) {
  const paths = new Set()
  for (const line of listing.split('\n')) {
    const match = line.trim().match(/^(Payload\/[^/]+\.app\/PlugIns\/[^/]+\.appex)\//)
    if (match) paths.add(match[1])
  }
  return [...paths].sort()
}

function ensureMacos() {
  if (process.platform !== 'darwin') fail('iOS release commands only run on macOS')
}

function ensureTool(command, args, installHint) {
  const result = run(command, args)
  if (result.status !== 0) fail(`${command} is not available. ${installHint}\n${result.output.trim()}`)
}

export function createTimestampBuildNumber(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
  ].join('')
}

function ensureBuildNumber(buildNumber, { required, now = new Date() }) {
  if (!buildNumber) {
    if (required) {
      const generatedBuildNumber = createTimestampBuildNumber(now)
      log(`generated UTC timestamp build number: ${generatedBuildNumber}`)
      return generatedBuildNumber
    }
    return null
  }
  if (!/^[0-9]+$/.test(buildNumber)) fail(`invalid build number "${buildNumber}" — use digits only`)
  return buildNumber
}

export function resolveBuildNumber(buildNumberFlag, { required, now = new Date() }) {
  return ensureBuildNumber(buildNumberFlag ?? process.env.BUILD_NUMBER, { required, now })
}

function resolveExportMethod(exportMethod) {
  if (!EXPORT_METHODS.has(exportMethod)) {
    fail(`unknown export method "${exportMethod}" — one of: ${[...EXPORT_METHODS].join(', ')}`)
  }
  return exportMethod
}

function firstExistingPath(paths) {
  return paths.find((path) => existsSync(path)) ?? null
}

function stageApiKeyContent({ keyId, rawContent }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'reflect-ios-api-key-'))
  const keyPath = join(tempDir, `AuthKey_${keyId}.p8`)
  writeFileSync(keyPath, normalizeApiKeyContent(rawContent), { mode: 0o600 })
  return {
    keyPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  }
}

function resolveApiKeyCredentials({ requirePrivateKey }) {
  const { APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_CONTENT, APPLE_API_KEY_PATH } = process.env
  if (!APPLE_API_KEY || !APPLE_API_ISSUER) return null

  let cleanup = null
  let keyPath = APPLE_API_KEY_PATH ? resolve(APPLE_API_KEY_PATH) : null
  if (APPLE_API_KEY_CONTENT) {
    const staged = stageApiKeyContent({ keyId: APPLE_API_KEY, rawContent: APPLE_API_KEY_CONTENT })
    cleanup = staged.cleanup
    keyPath = staged.keyPath
  } else if (!keyPath) {
    keyPath = firstExistingPath(
      appStoreConnectPrivateKeySearchPaths({ cwd: process.cwd(), homeDir: homedir(), keyId: APPLE_API_KEY }),
    )
  }

  if (keyPath && !existsSync(keyPath)) {
    cleanup?.()
    fail(`APPLE_API_KEY_PATH points to ${keyPath}, but that file does not exist`)
  }
  if (requirePrivateKey && !keyPath) {
    fail(
      'APPLE_API_KEY/APPLE_API_ISSUER are set, but xcodebuild also needs the .p8 file.\n' +
        '  Set APPLE_API_KEY_CONTENT, set APPLE_API_KEY_PATH, or place AuthKey_<KEY>.p8 in\n' +
        '  ~/.appstoreconnect/private_keys.',
    )
  }

  return {
    altoolArgs: createApiKeyAltoolArgs({ issuerId: APPLE_API_ISSUER, keyId: APPLE_API_KEY, keyPath }),
    cleanup,
    env: keyPath ? { APPLE_API_KEY_PATH: keyPath } : {},
    source: keyPath
      ? `App Store Connect API key ${APPLE_API_KEY} (${keyPath})`
      : `App Store Connect API key ${APPLE_API_KEY} (altool standard key search path)`,
  }
}

function resolveUploadCredentials() {
  const apiKey = resolveApiKeyCredentials({ requirePrivateKey: false })
  if (apiKey) return apiKey

  const { APPLE_ID, APPLE_PASSWORD, APPLE_PROVIDER_PUBLIC_ID } = process.env
  if (APPLE_ID && APPLE_PASSWORD) {
    const args = ['--username', APPLE_ID, '--password', '@env:APPLE_PASSWORD']
    if (APPLE_PROVIDER_PUBLIC_ID) args.push('--provider-public-id', APPLE_PROVIDER_PUBLIC_ID)
    return {
      altoolArgs: args,
      cleanup: null,
      env: {},
      source: `Apple ID ${APPLE_ID} (APPLE_PASSWORD from environment)`,
    }
  }

  const stored = readKeychainCredentials()
  if (stored) {
    const args = ['--username', stored.account, '--password', '@env:APPLE_PASSWORD']
    if (APPLE_PROVIDER_PUBLIC_ID) args.push('--provider-public-id', APPLE_PROVIDER_PUBLIC_ID)
    return {
      altoolArgs: args,
      cleanup: null,
      env: { APPLE_PASSWORD: stored.password },
      source: `Apple ID ${stored.account} (keychain item "${KEYCHAIN_SERVICE}")`,
    }
  }

  fail(
    'no App Store Connect upload credentials found.\n' +
      '  Preferred: APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_CONTENT (or APPLE_API_KEY_PATH).\n' +
      `  Fallback for upload-only: APPLE_ID + APPLE_PASSWORD, or keychain item "${KEYCHAIN_SERVICE}".`,
  )
}

function readKeychainCredentials() {
  const meta = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE])
  if (meta.status !== 0) return null
  const account = meta.output.match(/"acct"<blob>="([^"]+)"/)?.[1]
  const password = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])
  if (!account || password.status !== 0) return null
  return { account, password: password.output.trim() }
}

function listFilesRecursive(root) {
  if (!existsSync(root)) return []
  const entries = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) entries.push(...listFilesRecursive(path))
    else entries.push(path)
  }
  return entries
}

function newestIpa() {
  const candidates = listFilesRecursive(iosBuildDir)
    .filter((path) => path.endsWith('.ipa'))
    .map((path) => ({ mtimeMs: statSync(path).mtimeMs, path }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.path ?? null
}

function resolveInputPath(path) {
  const direct = resolve(path)
  if (existsSync(direct)) return direct
  const repoRelative = resolve(repoRoot, path)
  if (existsSync(repoRelative)) return repoRelative
  return direct
}

function readIpaInfoPlistRawValue(ipa, key) {
  const listing = capture('unzip', ['-Z1', ipa])
  const infoPlistPath = findIpaInfoPlistPath(listing)
  const tempDir = mkdtempSync(join(tmpdir(), 'reflect-ios-ipa-'))
  const infoPlist = join(tempDir, 'Info.plist')
  try {
    const plist = execFileSync('unzip', ['-p', ipa, infoPlistPath])
    writeFileSync(infoPlist, plist)
    return capture('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist]).trim()
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function assertIpaBundleIdentifier(ipa) {
  const bundleIdentifier = readIpaInfoPlistRawValue(ipa, 'CFBundleIdentifier')
  if (bundleIdentifier !== IOS_BUNDLE_IDENTIFIER) {
    const oldAppHint =
      bundleIdentifier === OLD_CAPACITOR_BUNDLE_IDENTIFIER
        ? ' This is the old Capacitor mobile app bundle id; refusing to upload over its TestFlight app.'
        : ''
    fail(
      `IPA bundle identifier is ${bundleIdentifier}, expected ${IOS_BUNDLE_IDENTIFIER}.${oldAppHint}\n` +
        '  Check apps/desktop/src-tauri/tauri.ios.conf.json and ios.project.yml before uploading.',
    )
  }
  log(`IPA bundle identifier: ${bundleIdentifier}`)
}

function assertIpaExportCompliance(ipa) {
  let value
  try {
    value = readIpaInfoPlistRawValue(ipa, NON_EXEMPT_ENCRYPTION_KEY)
  } catch {
    fail(
      `IPA Info.plist is missing ${NON_EXEMPT_ENCRYPTION_KEY}.\n` +
        '  Set it to false in apps/desktop/src-tauri/ios.project.yml before uploading so\n' +
        '  App Store Connect can skip repeated export-compliance questions.',
    )
  }

  if (!isFalsePlistValue(value)) {
    fail(
      `IPA Info.plist has ${NON_EXEMPT_ENCRYPTION_KEY}=${value}, expected false.\n` +
        '  Reflect iOS currently uses only exempt encryption; update export-compliance\n' +
        '  docs and App Store Connect answers before uploading if that changes.',
    )
  }
  log(`${NON_EXEMPT_ENCRYPTION_KEY}: false`)
}

/**
 * The share extension is useless without its App Group entitlement: the
 * container lookup returns nil and every share fails with "Couldn't save",
 * while the build itself installs and launches normally. The entitlement
 * comes from the export re-signing step (not the committed .entitlements
 * file), so verify what was actually signed before letting an IPA upload.
 */
function assertIpaAppexEntitlements(ipa) {
  const appexPaths = findIpaAppexPaths(capture('unzip', ['-Z1', ipa]))
  if (appexPaths.length === 0) {
    fail(
      'IPA contains no app extensions — expected the ShareExtension appex.\n' +
        '  Check that ios.project.yml still embeds ShareExtension.',
    )
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'reflect-ios-appex-'))
  try {
    execFileSync('unzip', ['-q', ipa, 'Payload/*', '-d', tempDir])
    for (const appexPath of appexPaths) {
      let entitlements
      try {
        entitlements = capture('codesign', ['-d', '--entitlements', ':-', join(tempDir, appexPath)])
      } catch (error) {
        fail(`cannot read code-signing entitlements of ${basename(appexPath)}: ${error.message}`)
      }
      if (!entitlements.includes(SHARE_EXTENSION_APP_GROUP)) {
        fail(
          `${basename(appexPath)} is signed without the ${SHARE_EXTENSION_APP_GROUP} App Group entitlement.\n` +
            '  Shares from this build would fail with "Couldn\'t save" — the extension\n' +
            '  cannot reach the shared capture inbox. Check the export re-signing step\n' +
            '  against gen/apple/ShareExtension/ShareExtension.entitlements.',
        )
      }
      log(`${basename(appexPath)} entitlements include ${SHARE_EXTENSION_APP_GROUP}`)
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function assertIpaAppStoreMetadata(ipa) {
  assertIpaBundleIdentifier(ipa)
  assertIpaExportCompliance(ipa)
  assertIpaAppexEntitlements(ipa)
}

function ensureReleaseTools() {
  ensureMacos()
  ensureTool('xcodebuild', ['-version'], 'Install Xcode and select it with `xcode-select`.')
  ensureTool('xcrun', ['--find', 'altool'], 'Install Xcode; altool is bundled with it.')
}

function runTauriIosBuild({ apiKeyCredentials, buildNumber, exportMethod, verbose }) {
  ensureReleaseTools()
  const args = createTauriIosBuildArgs({
    buildNumber,
    exportMethod,
    verbose,
  })
  log(`building ${IOS_BUNDLE_IDENTIFIER} with export method ${exportMethod}${buildNumber ? `, build ${buildNumber}` : ''}…`)
  if (apiKeyCredentials) {
    log(`Tauri provisioning auth: ${apiKeyCredentials.source}`)
  } else {
    log('Tauri provisioning auth: local Xcode account/profiles')
  }
  const result = spawnSync('pnpm', args, {
    cwd: appDir,
    stdio: 'inherit',
    env: createTauriIosBuildEnv({ apiKeyCredentials }),
  })
  if (result.status !== 0) {
    fail(
      'tauri ios build failed.\n' +
        '  If the Xcode export log says "No Accounts" or "No profiles", configure the\n' +
        '  App Store Connect API key env vars or sign into Xcode with a team that can\n' +
        `  provision ${IOS_BUNDLE_IDENTIFIER}.`,
    )
  }

  const ipa = newestIpa()
  if (!ipa) fail(`tauri build succeeded, but no .ipa was found under ${iosBuildDir}`)
  assertIpaAppStoreMetadata(ipa)
  log(`IPA: ${ipa} (${(statSync(ipa).size / (1024 * 1024)).toFixed(1)} MB)`)
  return ipa
}

function uploadIpaWithCredentials({ credentials, ipa, wait }) {
  assertIpaAppStoreMetadata(ipa)
  try {
    log(`uploading ${basename(ipa)} to App Store Connect as ${credentials.source}…`)
    const args = createAltoolUploadArgs({ authArgs: credentials.altoolArgs, ipa, wait })
    const result = spawnSync('xcrun', args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...credentials.env },
    })
    if (result.status !== 0) fail('altool upload failed')
    log(wait ? 'upload accepted and processing completed' : 'upload submitted to App Store Connect/TestFlight')
  } finally {
    credentials.cleanup?.()
  }
}

function uploadIpa({ ipa, wait }) {
  ensureReleaseTools()
  const credentials = resolveUploadCredentials()
  uploadIpaWithCredentials({ credentials, ipa, wait })
}

function validateIpa({ ipa }) {
  ensureReleaseTools()
  assertIpaAppStoreMetadata(ipa)
  const credentials = resolveUploadCredentials()
  try {
    log(`validating ${basename(ipa)} with App Store Connect…`)
    const args = createAltoolValidateArgs({ authArgs: credentials.altoolArgs, ipa })
    const result = spawnSync('xcrun', args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, ...credentials.env },
    })
    if (result.status !== 0) fail('altool validation failed')
    log('validation passed')
  } finally {
    credentials.cleanup?.()
  }
}

function parseAltoolJsonArray(output) {
  const jsonStart = output.indexOf('[')
  const jsonEnd = output.lastIndexOf(']')
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    fail(`altool response did not include a JSON array:\n${output.trim()}`)
  }
  const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1))
  if (!Array.isArray(parsed)) fail('altool response was not a JSON array')
  return parsed
}

function verifyAppStoreConnectAppRecord(credentials) {
  const args = createAltoolListAppsArgs({
    authArgs: credentials.altoolArgs,
    bundleIdentifier: IOS_BUNDLE_IDENTIFIER,
  })
  const result = spawnSync('xcrun', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...credentials.env },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) fail(`checking App Store Connect apps failed:\n${output.trim()}`)

  const apps = parseAltoolJsonArray(output)
  if (apps.length === 0) {
    fail(
      `no App Store Connect app record exists for ${IOS_BUNDLE_IDENTIFIER}.\n` +
        `  Create a new App Store Connect app for ${IOS_BUNDLE_IDENTIFIER} before uploading.\n` +
        `  Do not reuse the old Capacitor app (${OLD_CAPACITOR_BUNDLE_IDENTIFIER}).`,
    )
  }
  if (apps.length > 1) fail(`expected one App Store Connect app for ${IOS_BUNDLE_IDENTIFIER}, found ${apps.length}`)

  const [app] = apps
  const appleId = app && typeof app === 'object' && 'id' in app ? String(app.id) : 'unknown'
  const name = app && typeof app === 'object' && 'name' in app ? String(app.name) : 'unknown'
  log(`App Store Connect app record: ${name} (${appleId})`)
}

function build({ buildNumberFlag, exportMethod, verbose }) {
  const apiKeyCredentials = resolveApiKeyCredentials({ requirePrivateKey: false })
  try {
    return runTauriIosBuild({
      apiKeyCredentials,
      buildNumber: resolveBuildNumber(buildNumberFlag, { required: false }),
      exportMethod,
      verbose,
    })
  } finally {
    apiKeyCredentials?.cleanup?.()
  }
}

function testflight({ buildNumberFlag, exportMethod, wait, verbose }) {
  const apiKeyCredentials = resolveApiKeyCredentials({ requirePrivateKey: false })
  const uploadCredentials = resolveUploadCredentials()
  try {
    const ipa = runTauriIosBuild({
      apiKeyCredentials,
      buildNumber: resolveBuildNumber(buildNumberFlag, { required: true }),
      exportMethod,
      verbose,
    })
    uploadIpaWithCredentials({ credentials: uploadCredentials, ipa, wait })
  } finally {
    apiKeyCredentials?.cleanup?.()
    if (uploadCredentials !== apiKeyCredentials) uploadCredentials.cleanup?.()
  }
}

function preflight({ buildNumberFlag }) {
  ensureReleaseTools()
  resolveBuildNumber(buildNumberFlag, { required: true })
  const apiKeyCredentials = resolveApiKeyCredentials({ requirePrivateKey: false })
  const uploadCredentials = resolveUploadCredentials()
  try {
    log(`bundle identifier: ${IOS_BUNDLE_IDENTIFIER}`)
    log(
      `xcodebuild provisioning auth: ${
        apiKeyCredentials?.source ?? 'local Xcode account/profiles (no App Store Connect API key configured)'
      }`,
    )
    log(`altool upload auth: ${uploadCredentials.source}`)
    log(`xcodebuild: ${capture('xcodebuild', ['-version']).trim().replace(/\n/g, ' / ')}`)
    verifyAppStoreConnectAppRecord(uploadCredentials)
    log('preflight passed')
  } finally {
    apiKeyCredentials?.cleanup?.()
    if (uploadCredentials !== apiKeyCredentials) uploadCredentials.cleanup?.()
  }
}

function flagValue(flags, name) {
  return flags.find((flag) => flag.startsWith(`${name}=`))?.slice(name.length + 1) ?? null
}

const USAGE = `Usage: pnpm release:ios [command] [flags]

Commands:
  build       Build an App Store Connect IPA (default)
  preflight   Check TestFlight credentials and local Xcode tooling
  testflight  Build an IPA, then upload it to App Store Connect/TestFlight
  upload      Upload an existing IPA
  validate    Validate an existing IPA with App Store Connect

Flags:
  --build-number=<number>
              CFBundleVersion build number. Defaults to BUILD_NUMBER when set.
              Required preflight/testflight commands generate a UTC timestamp
              (YYYYMMDDHHmm) when omitted.
  --export-method=<name>
              Tauri/Xcode export method: app-store-connect | release-testing |
              debugging | validation (default: app-store-connect)
  --ipa=<path> Existing IPA for upload/validate
  --wait      Wait for App Store Connect processing (testflight/upload)
  --verbose   Verbose Tauri build output
  --help      Show this help

Docs: docs/ios-testflight.md`

async function main() {
  const argv = process.argv.slice(2)
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const commands = argv.filter((arg) => !arg.startsWith('--'))
  const command = commands[0] ?? 'build'
  const unknownFlag = flags.find(
    (flag) =>
      !['--help', '--wait', '--verbose'].includes(flag) &&
      !flag.startsWith('--build-number=') &&
      !flag.startsWith('--export-method=') &&
      !flag.startsWith('--ipa='),
  )
  if (unknownFlag) fail(`unknown flag "${unknownFlag}"\n\n${USAGE}`)
  if (flags.includes('--help')) {
    console.log(USAGE)
    return
  }

  const buildNumberFlag = flagValue(flags, '--build-number')
  const exportMethod = resolveExportMethod(flagValue(flags, '--export-method') ?? DEFAULT_EXPORT_METHOD)
  const ipaFlag = flagValue(flags, '--ipa')
  const wait = flags.includes('--wait')
  const verbose = flags.includes('--verbose')

  switch (command) {
    case 'build':
      if (ipaFlag) fail('--ipa only applies to upload and validate')
      if (wait) fail('--wait only applies to testflight and upload')
      build({ buildNumberFlag, exportMethod, verbose })
      return
    case 'preflight':
      if (ipaFlag) fail('--ipa does not apply to preflight')
      if (wait) fail('--wait only applies to testflight and upload')
      preflight({ buildNumberFlag })
      return
    case 'testflight':
      if (ipaFlag) fail('--ipa only applies to upload and validate')
      testflight({ buildNumberFlag, exportMethod, wait, verbose })
      return
    case 'upload': {
      const ipa = ipaFlag ? resolveInputPath(ipaFlag) : newestIpa()
      if (!ipa || !existsSync(ipa)) fail('--ipa is required, or build an IPA first')
      uploadIpa({ ipa, wait })
      return
    }
    case 'validate': {
      if (wait) fail('--wait only applies to testflight and upload')
      const ipa = ipaFlag ? resolveInputPath(ipaFlag) : newestIpa()
      if (!ipa || !existsSync(ipa)) fail('--ipa is required, or build an IPA first')
      validateIpa({ ipa })
      return
    }
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
