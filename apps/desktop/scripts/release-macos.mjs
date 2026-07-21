// Build a signed, notarized, distribution-ready macOS bundle of Reflect.
//
// Usage:
//   pnpm release:macos                Signed + notarized build, then verify
//   pnpm release:macos setup          Store notarization credentials (one-time)
//   pnpm release:macos setup-updater  Generate the auto-update signing keypair (one-time)
//   pnpm release:macos verify         Re-run Gatekeeper checks on existing bundles
//   pnpm release:macos publish        Build, then fill and undraft the release-please draft release (or create one)
//   pnpm release:macos --no-notarize  Signed-only build (won't pass Gatekeeper elsewhere)
//   pnpm release:macos --flavor=beta  Build a specific flavor: stable | beta | dev (default: from the version)
//
// Signing configuration is intentionally not committed — contributors must be
// able to build without Reflect's certificate. The Developer ID identity is
// auto-detected from the login keychain and notarization credentials come from
// the keychain item created by `setup`. Environment variables override
// auto-detection (what CI should use): APPLE_SIGNING_IDENTITY, plus either
// APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID or the App Store Connect key trio
// APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH.
//
// Full procedure and troubleshooting: docs/macos-distribution.md

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const KEYCHAIN_SERVICE = 'reflect-notary'
const UPDATER_KEYCHAIN_SERVICE = 'reflect-updater'
const APP_SPECIFIC_PASSWORD_URL = 'https://account.apple.com'
const BETA_UPDATER_FEED_TAG = 'updater-beta'
const STABLE_UPDATER_ENDPOINT = 'https://github.com/team-reflect/reflect-open/releases/latest/download/latest.json'
const APPLE_SILICON_MAC_TARGET = 'aarch64-apple-darwin'
const INTEL_MAC_TARGET = 'x86_64-apple-darwin'
const INTEL_ONNX_RUNTIME_VERSION = '1.23.2'
const INTEL_ONNX_RUNTIME_ARCHIVE_ROOT = `onnxruntime-osx-x86_64-${INTEL_ONNX_RUNTIME_VERSION}`
const INTEL_ONNX_RUNTIME_URL =
  `https://github.com/microsoft/onnxruntime/releases/download/v${INTEL_ONNX_RUNTIME_VERSION}/` +
  `${INTEL_ONNX_RUNTIME_ARCHIVE_ROOT}.tgz`
const ONNX_RUNTIME_DYLIB_RESOURCE = 'libonnxruntime.dylib'
const INTEL_ONNX_RUNTIME_RESOURCE_SOURCE = `resources/onnxruntime/${ONNX_RUNTIME_DYLIB_RESOURCE}`
const RELEASE_NOTES_FILENAME = 'release-notes.md'
const MAC_DOWNLOAD_NOTICE_HEADING = '## Which Mac download should I choose?'
const MACOS_SIDECARS = ['reflect', 'reflect-capture-host']
const MACOS_PROFILE_IDENTITY_ENTITLEMENTS = [
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier',
]
const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-beta(?:\.(\d+))?)?$/
const NOTARIZATION_ENV_VARS = [
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY_PATH',
]

/**
 * Build flavors. Each ships as a distinct app (its own productName, identifier
 * and icon) so all three coexist on one machine. `overlay` is a Tauri config
 * merged on top of the base config via `--config`; null means the base config
 * *is* the flavor (stable). The flavor is normally derived from the version
 * (prerelease → beta), so a published build always matches the updater feed
 * compiled into it.
 */
const FLAVOR_OVERLAYS = {
  stable: null,
  beta: 'src-tauri/tauri.beta.conf.json',
  dev: 'src-tauri/tauri.dev.conf.json',
}

const MACOS_RELEASE_TARGETS = {
  [APPLE_SILICON_MAC_TARGET]: {
    arch: 'aarch64',
    label: 'Apple Silicon',
    platform: 'darwin-aarch64',
  },
  [INTEL_MAC_TARGET]: {
    arch: 'x86_64',
    label: 'Intel',
    platform: 'darwin-x86_64',
  },
}
const DEFAULT_PUBLISH_TARGETS = [APPLE_SILICON_MAC_TARGET, INTEL_MAC_TARGET]

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const repoRoot = join(here, '..', '..', '..')

function log(message) {
  console.log(`release-macos: ${message}`)
}

function fail(message) {
  console.error(`release-macos: error: ${message}`)
  process.exit(1)
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options })
}

/** Format an error for fail(), keeping any stdout/stderr captured by execFileSync. */
export function describeError(error) {
  if (!(error instanceof Error)) return String(error)
  const parts = [error.message]
  for (const stream of ['stdout', 'stderr']) {
    const text = typeof error[stream] === 'string' ? error[stream].trim() : ''
    if (text) parts.push(`${stream}:\n${text}`)
  }
  return parts.join('\n')
}

/** Run a command and return { status, output } with stdout+stderr combined. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** Parse `security list-keychains` output into keychain paths. */
export function parseKeychainList(output) {
  return [...output.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

function listUserKeychains() {
  return parseKeychainList(capture('security', ['list-keychains', '-d', 'user']))
}

/** Build the Tauri CLI arguments for release packaging. */
export function createTauriBuildArgs({ flavor, resourceConfig = null, target }) {
  const buildArgs = ['tauri', 'build', '--target', target, '--bundles', 'app']
  const overlay = FLAVOR_OVERLAYS[flavor]
  if (overlay) buildArgs.push('--config', overlay)
  // The beta and dev overlays pin their own updater feed; the stable flavor has
  // no overlay, so without this it would inherit whatever endpoint is committed
  // in the base tauri.conf.json — which is the *beta* feed. Pin it at build
  // time so a stable build always polls the stable feed, no matter which
  // branch it was cut from. This is what makes releases branch-independent.
  if (flavor === 'stable') {
    buildArgs.push('--config', JSON.stringify({ plugins: { updater: { endpoints: [STABLE_UPDATER_ENDPOINT] } } }))
  }
  if (resourceConfig) {
    buildArgs.push('--config', JSON.stringify(resourceConfig))
  }
  return buildArgs
}

export function macosTargetResourceConfig(target) {
  if (target !== INTEL_MAC_TARGET) return null
  return {
    bundle: {
      resources: {
        [INTEL_ONNX_RUNTIME_RESOURCE_SOURCE]: ONNX_RUNTIME_DYLIB_RESOURCE,
        'resources/onnxruntime/LICENSE': 'onnxruntime/LICENSE',
        'resources/onnxruntime/ThirdPartyNotices.txt': 'onnxruntime/ThirdPartyNotices.txt',
      },
    },
  }
}

function stageIntelOnnxRuntime() {
  const resourceDir = join(appDir, 'src-tauri', 'resources', 'onnxruntime')
  const dylib = join(resourceDir, ONNX_RUNTIME_DYLIB_RESOURCE)
  const license = join(resourceDir, 'LICENSE')
  const notices = join(resourceDir, 'ThirdPartyNotices.txt')
  if (existsSync(dylib) && existsSync(license) && existsSync(notices)) {
    return
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'reflect-onnxruntime-'))
  try {
    const archive = join(tempDir, `${INTEL_ONNX_RUNTIME_ARCHIVE_ROOT}.tgz`)
    log(`downloading ONNX Runtime ${INTEL_ONNX_RUNTIME_VERSION} for Intel macOS…`)
    execFileSync(
      'curl',
      ['-fL', '--retry', '3', '--retry-delay', '2', '-o', archive, INTEL_ONNX_RUNTIME_URL],
      { stdio: 'inherit' },
    )
    execFileSync('tar', ['-xzf', archive, '-C', tempDir], { stdio: 'inherit' })

    const root = join(tempDir, INTEL_ONNX_RUNTIME_ARCHIVE_ROOT)
    mkdirSync(resourceDir, { recursive: true })
    copyFileSync(join(root, 'lib', ONNX_RUNTIME_DYLIB_RESOURCE), dylib)
    copyFileSync(join(root, 'LICENSE'), license)
    copyFileSync(join(root, 'ThirdPartyNotices.txt'), notices)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function prepareTargetResources(target) {
  const resourceConfig = macosTargetResourceConfig(target)
  if (!resourceConfig) return null
  stageIntelOnnxRuntime()
  return resourceConfig
}

/**
 * Resolve the Developer ID Application identity: APPLE_SIGNING_IDENTITY wins,
 * otherwise the login keychain is searched. Fails with remediation if absent.
 */
function findSigningIdentity() {
  if (process.env.APPLE_SIGNING_IDENTITY) return process.env.APPLE_SIGNING_IDENTITY

  const { output } = run('security', ['find-identity', '-v', '-p', 'codesigning'])
  const identities = [
    ...new Set([...output.matchAll(/"(Developer ID Application: [^"]+)"/g)].map((match) => match[1])),
  ]
  if (identities.length === 0) {
    fail(
      'no "Developer ID Application" certificate found in the keychain.\n' +
        '  Distribution outside the App Store requires one (created by the Apple Developer\n' +
        '  Account Holder at https://developer.apple.com/account/resources/certificates).\n' +
        '  For an unsigned local build, use `pnpm tauri build` instead.',
    )
  }
  if (identities.length > 1) {
    log(`multiple Developer ID identities found; using "${identities[0]}" (override with APPLE_SIGNING_IDENTITY)`)
  }
  return identities[0]
}

/**
 * Resolve the notarization team ID: APPLE_TEAM_ID wins, otherwise it's
 * extracted from an identity like "… (789ULN5MZB)". Only called by the
 * credential paths that actually need a team ID, so bare identities work
 * with --no-notarize and API-key notarization.
 */
function resolveTeamId(identity) {
  if (process.env.APPLE_TEAM_ID) return process.env.APPLE_TEAM_ID
  const teamId = identity.match(/\(([0-9A-Z]{10})\)$/)?.[1]
  if (!teamId) fail(`could not extract a team ID from identity "${identity}" — set APPLE_TEAM_ID explicitly`)
  return teamId
}

/** Read the Apple ID + app-specific password stored by `setup`, or null. */
function readKeychainCredentials() {
  const meta = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE])
  if (meta.status !== 0) return null
  const account = meta.output.match(/"acct"<blob>="([^"]+)"/)?.[1]
  const password = run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])
  if (!account || password.status !== 0) return null
  return { account, password: password.output.trim() }
}

/**
 * Resolve notarization credentials in precedence order: App Store Connect API
 * key env vars, Apple ID env vars, then the keychain item from `setup`.
 * Returns { notarytoolArgs, source } or null when nothing is found.
 */
function resolveNotaryCredentials(identity) {
  const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH, APPLE_ID, APPLE_PASSWORD } = process.env

  if (APPLE_API_KEY && APPLE_API_ISSUER) {
    if (!APPLE_API_KEY_PATH) fail('APPLE_API_KEY is set but APPLE_API_KEY_PATH (path to the .p8 file) is not')
    return {
      notarytoolArgs: ['--key', APPLE_API_KEY_PATH, '--key-id', APPLE_API_KEY, '--issuer', APPLE_API_ISSUER],
      source: 'App Store Connect API key (environment)',
    }
  }

  if (APPLE_ID && APPLE_PASSWORD) {
    const teamId = resolveTeamId(identity)
    return {
      notarytoolArgs: ['--apple-id', APPLE_ID, '--password', APPLE_PASSWORD, '--team-id', teamId],
      source: `Apple ID ${APPLE_ID} (environment)`,
    }
  }

  const stored = readKeychainCredentials()
  if (!stored) return null
  const teamId = resolveTeamId(identity)
  return {
    notarytoolArgs: ['--apple-id', stored.account, '--password', stored.password, '--team-id', teamId],
    source: `Apple ID ${stored.account} (keychain item "${KEYCHAIN_SERVICE}")`,
  }
}

/**
 * Resolve the Tauri updater signing key (minisign — distinct from Apple
 * signing). Environment wins (CI: TAURI_SIGNING_PRIVATE_KEY or …_PATH),
 * then the keychain item created by `setup-updater` (the key file,
 * base64-wrapped so the blob survives the keychain round-trip). Returns
 * { env, source } to merge into the build environment, or null.
 */
function resolveUpdaterSigningEnv() {
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''
  if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    return { env: { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password }, source: 'environment' }
  }
  const stored = run('security', ['find-generic-password', '-s', UPDATER_KEYCHAIN_SERVICE, '-w'])
  if (stored.status !== 0) return null
  return {
    env: {
      TAURI_SIGNING_PRIVATE_KEY: Buffer.from(stored.output.trim(), 'base64').toString('utf8'),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
    },
    source: `keychain item "${UPDATER_KEYCHAIN_SERVICE}"`,
  }
}

function releaseTargetConfig(target) {
  const config = MACOS_RELEASE_TARGETS[target]
  if (!config) {
    fail(`unsupported macOS release target "${target}" — one of: ${Object.keys(MACOS_RELEASE_TARGETS).join(', ')}`)
  }
  return config
}

/**
 * The host triple from rustc rather than process.arch, which diverges when
 * Node runs under Rosetta. Used as the local build default only; published
 * releases build every target in DEFAULT_PUBLISH_TARGETS.
 */
function hostTarget() {
  const target = capture('rustc', ['-vV']).match(/^host: (\S+)/m)?.[1]
  if (!target) fail('could not determine the host triple from rustc -vV')
  releaseTargetConfig(target)
  return target
}
/** The app version, from apps/desktop/package.json — the single version source. */
function readAppVersion() {
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    fail('apps/desktop/package.json has no "version"')
  }
  return pkg.version
}

/**
 * Parse tauri.conf.json — the source of truth for the base bundle name. Its
 * committed `version` is a pointer at ../package.json (Tauri resolves it at
 * build time), so set the real app version here for every downstream reader.
 */
function readTauriConf() {
  const conf = JSON.parse(readFileSync(join(appDir, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  conf.version = readAppVersion()
  return conf
}

function readPlatformConf(platform) {
  const path = join(appDir, 'src-tauri', `tauri.${platform}.conf.json`)
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Apply an RFC 7396 JSON Merge Patch — the same algorithm Tauri uses for `--config`. */
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = mergePatch(out[key], value)
  }
  return out
}

/**
 * The resolved config for a flavor: the base config with the flavor overlay
 * merged on top, exactly as `tauri build --config <overlay>` produces it. Bundle
 * paths depend on the flavor's productName, so they read the merged config.
 */
function readFlavorConf(flavor) {
  const base = mergePatch(readTauriConf(), readPlatformConf('macos'))
  const overlay = FLAVOR_OVERLAYS[flavor]
  if (!overlay) return base
  const patch = JSON.parse(readFileSync(join(appDir, overlay), 'utf8'))
  return mergePatch(base, patch)
}

/**
 * Pick the flavor. `publish` always derives it from the version channel so a
 * build can never be published to a feed it wasn't compiled for; local builds
 * may override with --flavor (including the never-published `dev`).
 */
function resolveFlavor({ flavorFlag, version, forPublish }) {
  const byVersion = version.includes('-') ? 'beta' : 'stable'
  if (forPublish) {
    if (flavorFlag && flavorFlag !== byVersion) {
      fail(
        `--flavor=${flavorFlag} conflicts with version ${version} (channel ${byVersion}); ` +
          'publish derives the flavor from the version',
      )
    }
    return byVersion
  }
  return flavorFlag ?? byVersion
}

/** Derive bundle output paths from the flavor's resolved config and cargo's target dir. */
function bundlePaths(flavor, target) {
  const conf = readFlavorConf(flavor)
  const { arch } = releaseTargetConfig(target)
  const metadata = JSON.parse(
    capture('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: repoRoot }),
  )
  const bundleDir = join(metadata.target_directory, target, 'release', 'bundle')
  return {
    app: join(bundleDir, 'macos', `${conf.productName}.app`),
    dmg: join(bundleDir, 'dmg', `${conf.productName}_${conf.version}_${arch}.dmg`),
    // The auto-update payload (when built with an updater key): the archive
    // the installed app downloads, and its minisign signature.
    updaterArchive: join(bundleDir, 'macos', `${conf.productName}.app.tar.gz`),
    updaterSignature: join(bundleDir, 'macos', `${conf.productName}.app.tar.gz.sig`),
  }
}

/**
 * Create the updater manifest body. The stable updater feed resolves
 * `releases/latest/download/latest.json`, so every published release must carry
 * this file — it is how installed apps discover the new version and verify its
 * payload.
 */
export function createUpdaterManifest({ artifacts, pubDate, slug, tag, version }) {
  const platforms = {}
  for (const artifact of artifacts) {
    // GitHub rewrites spaces in uploaded asset names to dots, so a flavor whose
    // productName has a space ("Reflect Beta") is served under a dotted name.
    // The manifest URL must match the uploaded name or auto-update gets a 404.
    const assetName = githubAssetName(basename(artifact.updaterArchive))
    platforms[artifact.platform] = {
      signature: readFileSync(artifact.updaterSignature, 'utf8').trim(),
      url: `https://github.com/${slug}/releases/download/${tag}/${assetName}`,
    }
  }
  return {
    version,
    pub_date: pubDate,
    platforms,
  }
}

function writeUpdaterManifest({ artifacts, outputDir, tag, version }) {
  const slug = capture('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()
  const manifest = createUpdaterManifest({
    artifacts,
    pubDate: new Date().toISOString(),
    slug,
    tag,
    version,
  })
  const manifestPath = join(outputDir, 'latest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

/** Build the tar arguments used for the macOS updater payload. */
export function createUpdaterArchiveArgs({ app, archive }) {
  return ['-czf', archive, '-C', dirname(app), basename(app)]
}

function writeUpdaterArtifacts({ flavor, target, updater }) {
  const { app, updaterArchive, updaterSignature } = bundlePaths(flavor, target)
  if (!existsSync(app)) fail(`${app} does not exist — Tauri did not produce the app bundle`)

  rmSync(updaterArchive, { force: true })
  rmSync(updaterSignature, { force: true })
  log(`creating updater archive ${basename(updaterArchive)} from finalized ${basename(app)}…`)
  execFileSync('tar', createUpdaterArchiveArgs({ app, archive: updaterArchive }), { stdio: 'inherit' })

  log(`signing updater archive ${basename(updaterArchive)}…`)
  const result = spawnSync('pnpm', ['tauri', 'signer', 'sign', updaterArchive], {
    cwd: appDir,
    encoding: 'utf8',
    env: { ...process.env, ...updater.env },
  })
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    fail(`signing updater archive failed${output ? `\n${output}` : ''}`)
  }
  if (!existsSync(updaterSignature)) {
    fail(`updater signature missing after signing — expected ${updaterSignature}`)
  }
}

/** Build the hdiutil arguments used to create the release DMG. */
export function createDmgArgs({ dmg, sourceFolder, volumeName }) {
  return ['create', '-volname', volumeName, '-srcfolder', sourceFolder, '-ov', '-format', 'UDZO', dmg]
}

/** Build the codesign arguments used for the DMG container. */
export function signDmgArgs({ dmg, identity, keychain }) {
  const args = ['--force', '--sign', identity, '--timestamp']
  if (keychain) args.push('--keychain', keychain)
  args.push(dmg)
  return args
}

function codesignArgs({ entitlements, identity, keychain, path }) {
  const args = ['--force', '--sign', identity, '--options', 'runtime', '--timestamp']
  if (entitlements) args.push('--entitlements', entitlements)
  if (keychain) args.push('--keychain', keychain)
  args.push(path)
  return args
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function macosProfileIdentityEntitlements({ bundleIdentifier, profileEntitlements }) {
  if (typeof bundleIdentifier !== 'string' || bundleIdentifier.length === 0) {
    throw new Error('macOS flavor has no bundle identifier')
  }
  if (!isRecord(profileEntitlements)) {
    throw new Error('embedded provisioning profile has no entitlements dictionary')
  }

  const identityEntitlements = {}
  for (const key of MACOS_PROFILE_IDENTITY_ENTITLEMENTS) {
    const value = profileEntitlements[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`embedded provisioning profile is missing string entitlement "${key}"`)
    }
    identityEntitlements[key] = value
  }

  const applicationIdentifier = identityEntitlements['com.apple.application-identifier']
  const prefixSeparator = applicationIdentifier.indexOf('.')
  const profileBundleIdentifier = applicationIdentifier.slice(prefixSeparator + 1)
  if (prefixSeparator <= 0 || profileBundleIdentifier !== bundleIdentifier) {
    throw new Error(
      `embedded provisioning profile application identifier "${applicationIdentifier}" ` +
        `does not match bundle identifier "${bundleIdentifier}"`,
    )
  }
  return identityEntitlements
}

/**
 * Add the identity entitlements supplied by a flavor's provisioning profile
 * without importing unrelated wildcard grants from that profile.
 */
export function mergeMacosProfileIdentityEntitlements({
  appEntitlements,
  bundleIdentifier,
  profileEntitlements,
}) {
  if (!isRecord(appEntitlements)) throw new Error('configured macOS entitlements are not a dictionary')
  const identityEntitlements = macosProfileIdentityEntitlements({ bundleIdentifier, profileEntitlements })

  for (const [key, value] of Object.entries(identityEntitlements)) {
    if (Object.hasOwn(appEntitlements, key) && appEntitlements[key] !== value) {
      throw new Error(
        `configured macOS entitlement "${key}" is "${appEntitlements[key]}", ` +
          `but the embedded provisioning profile requires "${value}"`,
      )
    }
  }
  return { ...appEntitlements, ...identityEntitlements }
}

/** Assert that a signed app retained the profile-owned identity entitlements. */
export function assertMacosProfileIdentityEntitlements({
  bundleIdentifier,
  profileEntitlements,
  signedEntitlements,
}) {
  if (!isRecord(signedEntitlements)) throw new Error('signed macOS entitlements are not a dictionary')
  const identityEntitlements = macosProfileIdentityEntitlements({ bundleIdentifier, profileEntitlements })

  for (const [key, value] of Object.entries(identityEntitlements)) {
    if (signedEntitlements[key] !== value) {
      throw new Error(
        `signed app entitlement "${key}" is ${JSON.stringify(signedEntitlements[key])}, ` +
          `expected "${value}" from the embedded provisioning profile`,
      )
    }
  }
}

export function macosEntitlementsPath(flavor) {
  const entitlements = readFlavorConf(flavor).bundle?.macOS?.entitlements
  if (typeof entitlements !== 'string') {
    fail(`macOS flavor "${flavor}" has no bundle.macOS.entitlements`)
  }
  return join(appDir, 'src-tauri', entitlements)
}

/** Resolve the provisioning profile embedded for a flavor, if it has one. */
export function macosProvisioningProfilePath(flavor) {
  const profile = readFlavorConf(flavor).bundle?.macOS?.files?.['embedded.provisionprofile']
  if (profile === undefined) return null
  if (typeof profile !== 'string' || profile.length === 0) {
    fail(`macOS flavor "${flavor}" has an invalid embedded provisioning profile`)
  }
  return join(appDir, 'src-tauri', profile)
}

function parsePlistJson(output, description) {
  const value = JSON.parse(output)
  if (!isRecord(value)) throw new Error(`${description} is not a dictionary`)
  return value
}

function readEntitlementsPlist(path) {
  return parsePlistJson(capture('plutil', ['-convert', 'json', '-o', '-', '--', path]), path)
}

function readProvisioningProfileEntitlements(path) {
  const profile = capture('security', ['cms', '-D', '-i', path])
  const entitlements = capture('plutil', ['-extract', 'Entitlements', 'json', '-o', '-', '-'], {
    input: profile,
  })
  return parsePlistJson(entitlements, `${path} entitlements`)
}

function readCodeSigningEntitlements(app) {
  const entitlements = capture('codesign', ['--display', '--entitlements', '-', '--xml', app], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const json = capture('plutil', ['-convert', 'json', '-o', '-', '-'], { input: entitlements })
  return parsePlistJson(json, `${app} code-signing entitlements`)
}

function prepareMacosSigningEntitlements({ app, flavor }) {
  const appEntitlementsPath = macosEntitlementsPath(flavor)
  const configuredProfilePath = macosProvisioningProfilePath(flavor)
  if (!configuredProfilePath) {
    return { cleanup: () => {}, description: basename(appEntitlementsPath), path: appEntitlementsPath }
  }

  const embeddedProfilePath = join(app, 'Contents', 'embedded.provisionprofile')
  if (!existsSync(embeddedProfilePath)) {
    throw new Error(
      `${basename(configuredProfilePath)} was configured for macOS flavor "${flavor}", ` +
        `but ${embeddedProfilePath} does not exist`,
    )
  }

  const bundleIdentifier = readFlavorConf(flavor).identifier
  const appEntitlements = readEntitlementsPlist(appEntitlementsPath)
  const profileEntitlements = readProvisioningProfileEntitlements(embeddedProfilePath)
  const mergedEntitlements = mergeMacosProfileIdentityEntitlements({
    appEntitlements,
    bundleIdentifier,
    profileEntitlements,
  })
  const tempDir = mkdtempSync(join(tmpdir(), 'reflect-signing-entitlements-'))
  const path = join(tempDir, 'Entitlements.plist')
  try {
    // The plist round-trips through JSON, which only preserves strings,
    // booleans, and arrays — every entitlement today. A number or <data>
    // entitlement would lose its exact plist type here.
    writeFileSync(path, `${JSON.stringify(mergedEntitlements, null, 2)}\n`, { mode: 0o600 })
    execFileSync('plutil', ['-convert', 'xml1', path])
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
  return {
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
    description: `${basename(appEntitlementsPath)} + identity from ${basename(configuredProfilePath)}`,
    path,
  }
}

function macosSidecarPaths(app) {
  return MACOS_SIDECARS.map((binary) => join(app, 'Contents', 'MacOS', binary))
}

function resignMacosApp({ flavor, identity, keychain, target }) {
  const { app } = bundlePaths(flavor, target)
  for (const sidecar of macosSidecarPaths(app)) {
    if (!existsSync(sidecar)) fail(`${sidecar} does not exist — Tauri did not bundle the sidecar`)
  }

  let signingEntitlements
  try {
    signingEntitlements = prepareMacosSigningEntitlements({ app, flavor })
  } catch (error) {
    fail(`preparing macOS signing entitlements failed: ${describeError(error)}`)
  }

  try {
    log('re-signing macOS sidecars without app entitlements…')
    for (const sidecar of macosSidecarPaths(app)) {
      execFileSync('codesign', codesignArgs({ identity, keychain, path: sidecar }), { stdio: 'inherit' })
    }

    log(`re-signing ${basename(app)} with ${signingEntitlements.description}…`)
    execFileSync(
      'codesign',
      codesignArgs({ entitlements: signingEntitlements.path, identity, keychain, path: app }),
      { stdio: 'inherit' },
    )
  } finally {
    signingEntitlements.cleanup()
  }
}

function importSigningCertificate() {
  const { APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD } = process.env
  if (!APPLE_CERTIFICATE) return null
  if (!APPLE_CERTIFICATE_PASSWORD) fail('APPLE_CERTIFICATE is set but APPLE_CERTIFICATE_PASSWORD is not')

  const tempDir = mkdtempSync(join(tmpdir(), 'reflect-signing-'))
  const certificatePath = join(tempDir, 'certificate.p12')
  const keychainPath = join(tempDir, 'reflect-signing.keychain-db')
  const keychainPassword = randomBytes(24).toString('hex')
  const previousKeychains = listUserKeychains()

  try {
    writeFileSync(certificatePath, Buffer.from(APPLE_CERTIFICATE, 'base64'), { mode: 0o600 })
    execFileSync('security', ['create-keychain', '-p', keychainPassword, keychainPath], { stdio: 'inherit' })
    execFileSync('security', ['set-keychain-settings', '-lut', '21600', keychainPath], { stdio: 'inherit' })
    execFileSync('security', ['unlock-keychain', '-p', keychainPassword, keychainPath], { stdio: 'inherit' })
    execFileSync('security', ['list-keychains', '-d', 'user', '-s', keychainPath, ...previousKeychains], {
      stdio: 'inherit',
    })
    execFileSync(
      'security',
      ['import', certificatePath, '-k', keychainPath, '-P', APPLE_CERTIFICATE_PASSWORD, '-T', '/usr/bin/codesign'],
      { stdio: 'inherit' },
    )
    execFileSync(
      'security',
      ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychainPath],
      { stdio: 'inherit' },
    )
    rmSync(certificatePath, { force: true })
    return { keychainPath, previousKeychains, tempDir }
  } catch (error) {
    cleanupSigningCertificate({ keychainPath, previousKeychains, tempDir })
    throw error
  }
}

function cleanupSigningCertificate(signingCertificate) {
  if (!signingCertificate) return
  if (signingCertificate.previousKeychains?.length) {
    spawnSync('security', ['list-keychains', '-d', 'user', '-s', ...signingCertificate.previousKeychains], {
      stdio: 'ignore',
    })
  }
  if (existsSync(signingCertificate.keychainPath)) {
    spawnSync('security', ['delete-keychain', signingCertificate.keychainPath], { stdio: 'ignore' })
  }
  rmSync(signingCertificate.tempDir, { recursive: true, force: true })
}

function createDmg({ flavor, identity, keychain, target }) {
  const conf = readFlavorConf(flavor)
  const { app, dmg } = bundlePaths(flavor, target)
  if (!existsSync(app)) fail(`${app} does not exist — tauri did not produce the app bundle`)

  const stagingRoot = mkdtempSync(join(tmpdir(), 'reflect-dmg-'))
  const stagingDir = join(stagingRoot, `${conf.productName}-dmg`)
  const stagedApp = join(stagingDir, basename(app))
  try {
    mkdirSync(stagingDir, { recursive: true })
    execFileSync('ditto', [app, stagedApp], { stdio: 'inherit' })
    symlinkSync('/Applications', join(stagingDir, 'Applications'))

    mkdirSync(dirname(dmg), { recursive: true })
    if (existsSync(dmg)) rmSync(dmg)
    log(`creating ${basename(dmg)} from ${basename(app)}…`)
    execFileSync('hdiutil', createDmgArgs({ dmg, sourceFolder: stagingDir, volumeName: conf.productName }), {
      stdio: 'inherit',
    })
    log(`signing ${basename(dmg)}…`)
    execFileSync('codesign', signDmgArgs({ dmg, identity, keychain }), { stdio: 'inherit' })
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

function submitNotarization({ credentials, label, path }) {
  log(`submitting ${basename(path)} to Apple's notary service (typically 1-10 minutes)…`)
  const submit = spawnSync(
    'xcrun',
    ['notarytool', 'submit', path, ...credentials.notarytoolArgs, '--wait', '--output-format', 'json'],
    { encoding: 'utf8' },
  )
  let verdict = {}
  try {
    verdict = JSON.parse(submit.stdout || '{}')
  } catch {
    // fall through to the failure path with whatever notarytool printed
  }
  if (submit.status !== 0 || verdict.status !== 'Accepted') {
    if (verdict.id) {
      log(`fetching notarization log for submission ${verdict.id}…`)
      const detail = run('xcrun', ['notarytool', 'log', verdict.id, ...credentials.notarytoolArgs])
      console.error(detail.output)
    } else {
      console.error(submit.stderr ?? '')
    }
    fail(`${label} notarization ${verdict.status ?? 'failed'}`)
  }
  return verdict
}

function notarizeApp(app, credentials) {
  const tempDir = mkdtempSync(join(tmpdir(), 'reflect-app-notary-'))
  try {
    const zip = join(tempDir, `${basename(app)}.zip`)
    log(`creating ${basename(zip)} for app notarization…`)
    execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip], { stdio: 'inherit' })
    const verdict = submitNotarization({ credentials, label: 'app', path: zip })
    log(`app notarization accepted (submission ${verdict.id}); stapling…`)
    execFileSync('xcrun', ['stapler', 'staple', app], { stdio: 'inherit' })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

/**
 * Notarize and staple the DMG. The app has its own ticket already; without a
 * separate ticket for the DMG, downloads still get Gatekeeper friction.
 */
function notarizeDmg(dmg, credentials) {
  const verdict = submitNotarization({ credentials, label: 'DMG', path: dmg })
  log(`DMG notarization accepted (submission ${verdict.id}); stapling…`)
  execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
}

/** Assert one Gatekeeper/codesign check, failing loudly with its output. */
function expectCheck(description, command, args, expected) {
  const { output, status } = run(command, args)
  const passed = status === 0 && expected.every((needle) => output.includes(needle))
  if (!passed) fail(`${description} failed:\n${output.trim()}`)
  log(`${description}: ok`)
}

export function canLaunchTarget(target, processArch = process.arch) {
  if (target === APPLE_SILICON_MAC_TARGET) return processArch === 'arm64'
  if (target === INTEL_MAC_TARGET) return processArch === 'x64' || processArch === 'arm64'
  return true
}

function verifySidecarsLaunch({ flavor, target }) {
  if (!canLaunchTarget(target)) {
    log(`skipping sidecar launch checks for ${target} on ${process.arch}`)
    return
  }

  const { app } = bundlePaths(flavor, target)
  const checks = [
    {
      args: ['--version'],
      binary: join(app, 'Contents', 'MacOS', 'reflect'),
      description: 'reflect CLI launch',
      outputPattern: /^reflect \d/,
    },
    {
      args: [],
      binary: join(app, 'Contents', 'MacOS', 'reflect-capture-host'),
      description: 'reflect capture host launch',
      outputPattern: null,
    },
  ]

  for (const check of checks) {
    const result = spawnSync(check.binary, check.args, { encoding: 'utf8', input: '' })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    if (result.error) fail(`${check.description} failed:\n${result.error.message}`)
    if (result.status !== 0) fail(`${check.description} exited ${result.status ?? 'without a status'}:\n${output}`)
    if (check.outputPattern && !check.outputPattern.test(output)) {
      fail(`${check.description} printed unexpected output:\n${output}`)
    }
    log(`${check.description}: ok`)
  }
}

function verifyMacosProfileIdentityEntitlements({ app, flavor }) {
  const configuredProfilePath = macosProvisioningProfilePath(flavor)
  if (!configuredProfilePath) return

  const embeddedProfilePath = join(app, 'Contents', 'embedded.provisionprofile')
  if (!existsSync(embeddedProfilePath)) {
    throw new Error(`${app} is missing ${basename(configuredProfilePath)}`)
  }
  assertMacosProfileIdentityEntitlements({
    bundleIdentifier: readFlavorConf(flavor).identifier,
    profileEntitlements: readProvisioningProfileEntitlements(embeddedProfilePath),
    signedEntitlements: readCodeSigningEntitlements(app),
  })
  log('profile identity entitlements: ok')
}

/** Verify the built bundles match the expected distribution state. */
function verify({ notarized, flavor, target }) {
  const { app, dmg } = bundlePaths(flavor, target)
  if (!existsSync(app)) fail(`${app} does not exist — run \`pnpm release:macos\` first`)
  if (!existsSync(dmg)) fail(`${dmg} does not exist — run \`pnpm release:macos\` first`)

  expectCheck('codesign verify (app)', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], [
    'valid on disk',
    'satisfies its Designated Requirement',
  ])
  try {
    verifyMacosProfileIdentityEntitlements({ app, flavor })
  } catch (error) {
    fail(`profile identity entitlement verification failed: ${describeError(error)}`)
  }
  verifySidecarsLaunch({ flavor, target })

  if (!notarized) {
    log('signed-only verification passed (not notarized: Gatekeeper will reject this bundle on other Macs)')
    return
  }

  expectCheck('Gatekeeper (app)', 'spctl', ['--assess', '--type', 'execute', '-v', app], [
    'accepted',
    'source=Notarized Developer ID',
  ])
  expectCheck('stapled ticket (app)', 'xcrun', ['stapler', 'validate', app], ['The validate action worked!'])
  expectCheck(
    'Gatekeeper (dmg)',
    'spctl',
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', dmg],
    ['accepted', 'source=Notarized Developer ID'],
  )
  expectCheck('stapled ticket (dmg)', 'xcrun', ['stapler', 'validate', dmg], ['The validate action worked!'])
}

function printArtifacts(flavor, target) {
  const { app, dmg } = bundlePaths(flavor, target)
  const dmgSizeMb = (statSync(dmg).size / (1024 * 1024)).toFixed(1)
  log('distribution bundles:')
  console.log(`  ${app}`)
  console.log(`  ${dmg} (${dmgSizeMb} MB)`)
}

/** Build the uploaded file name for a target-specific release artifact. */
function releaseAssetName({ productName, version, target, type }) {
  const { arch } = releaseTargetConfig(target)
  if (type === 'dmg') return `${githubAssetName(productName)}_${arch}.dmg`

  const prefix = `${productName}_${version}_${arch}`
  switch (type) {
    case 'updaterArchive':
      return `${prefix}.app.tar.gz`
    case 'updaterSignature':
      return `${prefix}.app.tar.gz.sig`
    default:
      fail(`unknown release asset type "${type}"`)
  }
}

/** Match GitHub's release asset URL/display rewrite for uploaded file names. */
function githubAssetName(fileName) {
  return fileName.replace(/ /g, '.')
}

function exportReleaseArtifacts({ artifactDir, flavor, target }) {
  const conf = readFlavorConf(flavor)
  const targetConfig = releaseTargetConfig(target)
  const paths = bundlePaths(flavor, target)
  const exported = {
    dmg: join(
      artifactDir,
      releaseAssetName({ productName: conf.productName, version: conf.version, target, type: 'dmg' }),
    ),
    updaterArchive: join(
      artifactDir,
      releaseAssetName({ productName: conf.productName, version: conf.version, target, type: 'updaterArchive' }),
    ),
    updaterSignature: join(
      artifactDir,
      releaseAssetName({ productName: conf.productName, version: conf.version, target, type: 'updaterSignature' }),
    ),
  }

  mkdirSync(artifactDir, { recursive: true })
  copyFileSync(paths.dmg, exported.dmg)
  copyFileSync(paths.updaterArchive, exported.updaterArchive)
  copyFileSync(paths.updaterSignature, exported.updaterSignature)
  writeFileSync(
    join(artifactDir, `${target}.json`),
    `${JSON.stringify(
      {
        version: conf.version,
        productName: conf.productName,
        flavor,
        target,
        platform: targetConfig.platform,
        assets: {
          dmg: basename(exported.dmg),
          updaterArchive: basename(exported.updaterArchive),
          updaterSignature: basename(exported.updaterSignature),
        },
      },
      null,
      2,
    )}\n`,
  )
  log(`exported ${targetConfig.label} release artifacts to ${artifactDir}`)
}

function readReleaseArtifact({ artifactDir, expectedFlavor, expectedProductName, expectedTarget, expectedVersion }) {
  const metadataPath = join(artifactDir, `${expectedTarget}.json`)
  if (!existsSync(metadataPath)) fail(`missing release artifact metadata ${metadataPath}`)

  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  const targetConfig = releaseTargetConfig(metadata.target)
  if (metadata.target !== expectedTarget) fail(`${metadataPath} describes ${metadata.target}, expected ${expectedTarget}`)
  if (metadata.version !== expectedVersion) {
    fail(`${metadataPath} describes version ${metadata.version}, expected ${expectedVersion}`)
  }
  if (metadata.flavor !== expectedFlavor) fail(`${metadataPath} describes flavor ${metadata.flavor}, expected ${expectedFlavor}`)
  if (metadata.productName !== expectedProductName) {
    fail(`${metadataPath} describes product ${metadata.productName}, expected ${expectedProductName}`)
  }
  if (metadata.platform !== targetConfig.platform) {
    fail(`${metadataPath} describes platform ${metadata.platform}, expected ${targetConfig.platform}`)
  }

  const artifact = {
    target: metadata.target,
    platform: metadata.platform,
    dmg: join(artifactDir, metadata.assets.dmg),
    updaterArchive: join(artifactDir, metadata.assets.updaterArchive),
    updaterSignature: join(artifactDir, metadata.assets.updaterSignature),
  }
  for (const path of [artifact.dmg, artifact.updaterArchive, artifact.updaterSignature]) {
    if (!existsSync(path)) fail(`missing release artifact ${path}`)
  }
  return artifact
}

function readReleaseArtifacts({ artifactDir, flavor, productName, targets, version }) {
  return targets.map((target) =>
    readReleaseArtifact({
      artifactDir,
      expectedFlavor: flavor,
      expectedProductName: productName,
      expectedTarget: target,
      expectedVersion: version,
    }),
  )
}

function build({ artifactDir, notarize, requireUpdater = false, flavor, target }) {
  const targetConfig = releaseTargetConfig(target)
  const identity = findSigningIdentity()
  log(`signing identity: ${identity}`)
  log(`release target: ${targetConfig.label} (${target})`)

  const updater = resolveUpdaterSigningEnv()
  if (updater) {
    log(`updater signing key: ${updater.source}`)
  } else if (requireUpdater || artifactDir) {
    fail(
      'no updater signing key found.\n' +
        '  Published releases must carry updater artifacts, or installed apps stop receiving\n' +
        '  updates. Run `pnpm release:macos setup-updater` once, or export TAURI_SIGNING_PRIVATE_KEY.',
    )
  } else {
    log('no updater signing key — skipping updater artifacts (run `pnpm release:macos setup-updater` to set one up)')
  }

  let credentials = null
  if (notarize) {
    if (run('xcrun', ['--find', 'notarytool']).status !== 0) {
      fail('notarytool not found — install the Xcode Command Line Tools (`xcode-select --install`)')
    }
    credentials = resolveNotaryCredentials(identity)
    if (!credentials) {
      fail(
        'no notarization credentials found.\n' +
          '  Run `pnpm release:macos setup` once to store them in the keychain,\n' +
          '  export APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID (or the APPLE_API_KEY trio),\n' +
          '  or pass --no-notarize for a signed-only build.',
      )
    }
    log(`notarizing as: ${credentials.source}`)
  } else {
    log('notarization skipped (--no-notarize): the bundle will not pass Gatekeeper on other Macs')
  }

  const buildEnv = {
    ...process.env,
    APPLE_SIGNING_IDENTITY: identity,
  }
  // Tauri notarizes the .app whenever these are present. The release helper
  // now notarizes after repairing sidecar entitlements, so keep Tauri to
  // build/sign only even for notarized releases.
  for (const name of NOTARIZATION_ENV_VARS) {
    delete buildEnv[name]
  }
  // Build only the signed .app with Tauri. The generated Tauri DMG script is
  // brittle on GitHub-hosted macOS images, and updater archives must be made
  // after the sidecar signatures are repaired below.
  const resourceConfig = prepareTargetResources(target)
  const buildArgs = createTauriBuildArgs({ flavor, resourceConfig, target })
  const result = spawnSync('pnpm', buildArgs, { cwd: appDir, stdio: 'inherit', env: buildEnv })
  if (result.status !== 0) fail('tauri build failed')

  const signingCertificate = importSigningCertificate()
  try {
    resignMacosApp({ flavor, identity, keychain: signingCertificate?.keychainPath, target })
    if (notarize) notarizeApp(bundlePaths(flavor, target).app, credentials)
    if (updater) writeUpdaterArtifacts({ flavor, target, updater })
    createDmg({ flavor, identity, keychain: signingCertificate?.keychainPath, target })
  } finally {
    cleanupSigningCertificate(signingCertificate)
  }
  if (notarize) notarizeDmg(bundlePaths(flavor, target).dmg, credentials)
  verify({ notarized: notarize, flavor, target })
  printArtifacts(flavor, target)
  if (artifactDir) exportReleaseArtifacts({ artifactDir, flavor, target })
  log(notarize ? 'done — ready to distribute' : 'done — signed but NOT notarized')
}

/** Assert the GitHub CLI is installed and authenticated. */
function ensureGhReady() {
  if (run('gh', ['--version']).status !== 0) {
    fail('GitHub CLI not found — install it from https://cli.github.com and run `gh auth login`')
  }
  const auth = run('gh', ['auth', 'status'])
  if (auth.status !== 0) fail(`gh is not authenticated — run \`gh auth login\`\n${auth.output.trim()}`)
}

/**
 * Assert HEAD is a clean commit pushed to origin — the repo gh releases to —
 * and return its SHA. The release tag is created at this commit, so it must
 * exist on GitHub and match what gets built.
 */
function ensurePublishableCommit() {
  if (capture('git', ['status', '--porcelain']).trim() !== '') {
    fail('the working tree has uncommitted changes — commit or stash them before publishing')
  }
  const commit = capture('git', ['rev-parse', 'HEAD']).trim()
  if (capture('git', ['branch', '--remotes', '--contains', commit, '--list', 'origin/*']).trim() === '') {
    fail('HEAD is not on any origin branch — push it first so the release tag points at published code')
  }
  return commit
}

/**
 * Find the GitHub release for a tag, drafts included. release-please creates
 * releases as drafts, and the `releases/tags/<tag>` endpoint does not resolve
 * drafts — list and match instead.
 */
function findReleaseByTag(tag) {
  const result = spawnSync(
    'gh',
    ['api', '--paginate', 'repos/{owner}/{repo}/releases', '--jq', `.[] | select(.tag_name == ${JSON.stringify(tag)})`],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    fail(`could not list GitHub releases:\n${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`)
  }
  const line = (result.stdout ?? '').split('\n').find((candidate) => candidate.trim() !== '')
  return line ? JSON.parse(line) : null
}

/**
 * A release created by release-please (the Release PR flow) starts as an
 * asset-less draft; publish fills it in and undrafts it. Refuse a published
 * release that already carries built artifacts — that version has shipped.
 * A draft with partial assets is a crashed publish; uploads clobber, so
 * retrying is safe.
 */
function ensureReleaseAcceptsAssets(release, tag) {
  const names = (release.assets ?? []).map((asset) => asset.name)
  const shipped = names.some((name) => name.endsWith('.dmg') || name === 'latest.json')
  if (shipped && !release.draft) {
    fail(`release ${tag} already has published artifacts — bump "version" in apps/desktop/package.json first`)
  }
}

/**
 * A draft release's target_commitish records the commit it releases. Refuse
 * to attach artifacts built from a different commit. (For an already-published
 * release the git tag is authoritative, so the tag check covers it.)
 */
function ensureReleaseTargetsCommit(release, tag, commit) {
  if (!release.draft) return ensureTagMatchesCommit(tag, commit)

  const target = release.target_commitish ?? ''
  let taggedCommit = target
  if (!/^[0-9a-f]{40}$/.test(target)) {
    // target_commitish may be a branch name; resolve it to its origin tip.
    const resolved = run('git', ['rev-parse', '--verify', `refs/remotes/origin/${target}`])
    if (resolved.status !== 0) {
      fail(`draft release ${tag} targets "${target}", which is neither a commit nor a known origin branch`)
    }
    taggedCommit = resolved.output.trim()
  }
  if (taggedCommit !== commit) {
    fail(
      `draft release ${tag} targets ${taggedCommit.slice(0, 7)} but HEAD is ${commit.slice(0, 7)}.\n` +
        '  Publishing would attach artifacts built from the wrong commit —\n' +
        '  run the release workflow on the commit that merged the Release PR.',
    )
  }
}

/**
 * Assert that if the tag already exists on origin, it points at the commit
 * being released. `gh release create` silently reuses an existing tag and
 * ignores --target, which would attach the release to whatever old commit
 * the tag names instead of the code that was just built.
 */
function ensureTagMatchesCommit(tag, commit) {
  // The "^{}" pattern makes ls-remote include the peeled line for annotated
  // tags; gh-created tags are lightweight and resolve to the commit directly.
  const output = capture('git', ['ls-remote', '--tags', 'origin', tag, `${tag}^{}`]).trim()
  if (output === '') return
  const refs = output.split('\n').map((line) => line.split('\t'))
  const peeled = refs.find(([, name]) => name === `refs/tags/${tag}^{}`)
  const taggedCommit = (peeled ?? refs[0])[0]
  if (taggedCommit !== commit) {
    fail(
      `tag ${tag} already exists on origin at ${taggedCommit.slice(0, 7)} but HEAD is ${commit.slice(0, 7)}.\n` +
        '  gh would attach the release to the existing tag, not the commit being built —\n' +
        '  delete the remote tag or bump "version" in apps/desktop/package.json.',
    )
  }
}

/** Build the GitHub API args that generate the standard release notes body. */
export function createGenerateReleaseNotesArgs({ commit, tag }) {
  return [
    'api',
    'repos/{owner}/{repo}/releases/generate-notes',
    '--method',
    'POST',
    '-f',
    `tag_name=${tag}`,
    '-f',
    `target_commitish=${commit}`,
  ]
}

/** Create the release-note footer that maps Mac CPU families to the right DMG. */
export function createMacDownloadNotice({ productName }) {
  const appleSiliconDmg = githubAssetName(
    releaseAssetName({ productName, target: APPLE_SILICON_MAC_TARGET, type: 'dmg' }),
  )
  const intelDmg = githubAssetName(releaseAssetName({ productName, target: INTEL_MAC_TARGET, type: 'dmg' }))

  return [
    MAC_DOWNLOAD_NOTICE_HEADING,
    '',
    `- **Apple Silicon (M-series Macs):** download \`${appleSiliconDmg}\`.`,
    `- **Intel Macs:** download \`${intelDmg}\`.`,
    '',
    'To check your Mac, open **Apple menu -> About This Mac**. If it shows **Chip** with M1, M2, M3, M4, or newer, choose Apple Silicon. If it shows **Processor** with Intel, choose Intel.',
  ].join('\n')
}

/** Append Reflect's Mac download guidance after GitHub's generated notes. */
export function appendMacDownloadNotice({ body, productName }) {
  const trimmedBody = body.trimEnd()
  if (trimmedBody.includes(MAC_DOWNLOAD_NOTICE_HEADING)) return `${trimmedBody}\n`

  const notice = createMacDownloadNotice({ productName })
  return `${trimmedBody ? `${trimmedBody}\n\n` : ''}${notice}\n`
}

/** Fetch GitHub's generated release notes body before creating the release. */
function generateReleaseNotesBody({ commit, tag }) {
  const result = spawnSync('gh', createGenerateReleaseNotesArgs({ commit, tag }), { encoding: 'utf8' })
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    fail(`generating GitHub release notes failed${output ? `\n${output}` : ''}`)
  }

  let generated
  try {
    generated = JSON.parse(result.stdout)
  } catch (error) {
    fail(`GitHub release notes response was not JSON: ${describeError(error)}`)
  }

  if (!generated || typeof generated !== 'object' || typeof generated.body !== 'string') {
    fail('GitHub release notes response did not include a markdown body')
  }
  return generated.body
}

/** Write generated release notes plus Reflect's Mac download footer to disk. */
function writeReleaseNotes({ commit, outputDir, productName, tag }) {
  log('generating GitHub release notes…')
  const body = generateReleaseNotesBody({ commit, tag })
  const releaseNotesPath = join(outputDir, RELEASE_NOTES_FILENAME)
  writeFileSync(releaseNotesPath, appendMacDownloadNotice({ body, productName }))
  return releaseNotesPath
}

/** Build the GitHub CLI args that publish the release and upload artifacts. */
export function createReleaseArgs({ assets, commit, draft, notesPath, prerelease, productName, tag, version }) {
  const releaseArgs = [
    'release',
    'create',
    tag,
    ...assets,
    '--title',
    `${productName} ${version}`,
    '--target',
    commit,
    '--notes-file',
    notesPath,
  ]
  if (prerelease) {
    releaseArgs.push('--prerelease', '--latest=false')
  } else {
    releaseArgs.push('--latest')
  }
  if (draft) releaseArgs.push('--draft')
  return releaseArgs
}

/** Build the `gh release upload` args that fill a release-please draft release. */
export function createExistingReleaseUploadArgs({ assets, tag }) {
  return ['release', 'upload', tag, ...assets, '--clobber']
}

/**
 * Build the `gh release edit` args that finalize a release-please draft:
 * title, complete notes, channel flags, and — unless the draft is kept for
 * review — the undraft itself, which makes the release visible to users only
 * once every asset is in place.
 */
export function createFinalizeReleaseArgs({ keepDraft, notesPath, prerelease, productName, tag, version }) {
  const args = ['release', 'edit', tag, '--title', `${productName} ${version}`, '--notes-file', notesPath]
  if (prerelease) {
    args.push('--prerelease', '--latest=false')
  } else {
    args.push('--prerelease=false', '--latest')
  }
  if (!keepDraft) args.push('--draft=false')
  return args
}

/** Build the `gh release create` arguments for the moving beta download and updater feed. */
export function createBetaFeedReleaseArgs({ assets, commit }) {
  return [
    'release',
    'create',
    BETA_UPDATER_FEED_TAG,
    ...assets,
    '--title',
    'Latest Reflect Beta downloads',
    '--target',
    commit,
    '--prerelease',
    '--latest=false',
    '--notes',
    'Moving downloads and updater feed for the latest Reflect Beta release. Choose a DMG for a fresh install; installed beta apps use latest.json.',
  ]
}

/** Build ordered uploads so installer failures leave the working updater manifest untouched. */
export function createBetaFeedUploadSteps({ dmgPaths, manifestPath }) {
  return [
    {
      label: 'downloads',
      args: ['release', 'upload', BETA_UPDATER_FEED_TAG, ...dmgPaths, '--clobber'],
    },
    {
      label: 'updater feed',
      args: ['release', 'upload', BETA_UPDATER_FEED_TAG, manifestPath, '--clobber'],
    },
  ]
}

/** Build the `gh release download` arguments used to recover moving assets from a tagged release. */
export function createReleaseDownloadArgs({ assetNames, outputDir, tag }) {
  return [
    'release',
    'download',
    tag,
    '--dir',
    outputDir,
    ...assetNames.flatMap((assetName) => ['--pattern', assetName]),
  ]
}

function parseReleaseVersion(version) {
  const match = RELEASE_VERSION_PATTERN.exec(version)
  if (!match) throw new Error(`unsupported release version: ${version}`)

  const [, major, minor, patch, betaNumber] = match
  return {
    core: [major, minor, patch].map(Number),
    prerelease: version.includes('-beta') ? Number(betaNumber ?? 0) : null,
  }
}

/** Compare Reflect stable/beta versions, returning negative, zero, or positive. */
export function compareReleaseVersions(left, right) {
  const leftVersion = parseReleaseVersion(left)
  const rightVersion = parseReleaseVersion(right)

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const difference = leftVersion.core[index] - rightVersion.core[index]
    if (difference !== 0) return Math.sign(difference)
  }

  if (leftVersion.prerelease === null && rightVersion.prerelease === null) return 0
  if (leftVersion.prerelease === null) return 1
  if (rightVersion.prerelease === null) return -1
  return Math.sign(leftVersion.prerelease - rightVersion.prerelease)
}

/** Select the highest Reflect beta version from GitHub release tag names. */
export function newestBetaVersionFromTags(tags) {
  const versions = tags
    .map((tag) => tag.trim())
    .map((tag) => (tag.startsWith('v') ? tag.slice(1) : ''))
    .filter((version) => version.includes('-beta') && RELEASE_VERSION_PATTERN.test(version))
  if (versions.length === 0) throw new Error('GitHub did not return any published beta releases')

  return versions.reduce((newest, version) =>
    compareReleaseVersions(version, newest) > 0 ? version : newest,
  )
}

function findNewestPublishedBetaVersion() {
  const result = spawnSync(
    'gh',
    [
      'api',
      '--paginate',
      'repos/{owner}/{repo}/releases',
      '--jq',
      '.[] | select(.prerelease == true and .draft == false) | .tag_name',
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    fail(`could not list published beta releases:\n${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`)
  }

  try {
    return newestBetaVersionFromTags((result.stdout ?? '').split('\n'))
  } catch (error) {
    fail(describeError(error))
  }
}

function updateBetaFeed({ commit, dmgPaths, manifestPath }) {
  const existing = run('gh', ['release', 'view', BETA_UPDATER_FEED_TAG])
  if (existing.status === 0) {
    for (const step of createBetaFeedUploadSteps({ dmgPaths, manifestPath })) {
      log(`updating ${BETA_UPDATER_FEED_TAG} ${step.label}…`)
      const upload = spawnSync('gh', step.args, {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'inherit'],
      })
      if (upload.status !== 0) {
        fail(`updating the beta ${step.label} failed${upload.stdout ? `\n${upload.stdout.trim()}` : ''}`)
      }
    }
    return
  }
  if (!/release not found/i.test(existing.output)) {
    fail(`could not check GitHub for the ${BETA_UPDATER_FEED_TAG} updater feed:\n${existing.output.trim()}`)
  }
  log(`creating ${BETA_UPDATER_FEED_TAG} downloads and updater feed…`)
  const create = spawnSync('gh', createBetaFeedReleaseArgs({ assets: [...dmgPaths, manifestPath], commit }), {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  if (create.status !== 0) {
    fail(`creating the beta downloads failed${create.stdout ? `\n${create.stdout.trim()}` : ''}`)
  }
}

function downloadReleaseAssets({ assetNames, outputDir, tag }) {
  mkdirSync(outputDir, { recursive: true })
  const download = spawnSync('gh', createReleaseDownloadArgs({ assetNames, outputDir, tag }), {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  if (download.status !== 0) {
    fail(`downloading release assets from ${tag} failed${download.stdout ? `\n${download.stdout.trim()}` : ''}`)
  }

  const paths = assetNames.map((assetName) => join(outputDir, assetName))
  for (const path of paths) {
    if (!existsSync(path)) fail(`release download did not produce ${path}`)
  }
  return paths
}

/** Refresh the moving beta assets from an already-published immutable release. */
function syncBetaFeed() {
  ensureGhReady()
  const commit = ensurePublishableCommit()
  const { version } = readTauriConf()
  if (!version.includes('-')) fail(`version ${version} is stable — there is no beta feed to sync`)

  const flavor = resolveFlavor({ version, forPublish: true })
  const { productName } = readFlavorConf(flavor)
  const tag = `v${version}`
  const release = findReleaseByTag(tag)
  if (!release) fail(`release ${tag} does not exist`)
  ensureReleaseTargetsCommit(release, tag, commit)
  if (release.draft) {
    log(`release ${tag} is still a draft — ${BETA_UPDATER_FEED_TAG} remains unchanged`)
    return
  }
  if (!release.prerelease) fail(`release ${tag} is not marked as a pre-release`)

  const dmgNames = DEFAULT_PUBLISH_TARGETS.map((target) =>
    releaseAssetName({ productName, target, type: 'dmg' }),
  )
  const assetNames = [...dmgNames, 'latest.json']
  const publishedAssetNames = new Set((release.assets ?? []).map((asset) => asset.name))
  const missingAsset = assetNames.find((assetName) => !publishedAssetNames.has(assetName))
  if (missingAsset) fail(`release ${tag} does not contain ${missingAsset}`)

  const newestPublishedVersion = findNewestPublishedBetaVersion()
  if (compareReleaseVersions(version, newestPublishedVersion) < 0) {
    log(`${newestPublishedVersion} is already published; skipping older ${version}`)
    return
  }
  log(`syncing ${BETA_UPDATER_FEED_TAG} to the newest published beta, ${version}`)

  const tempDir = mkdtempSync(join(tmpdir(), 'reflect-beta-feed-'))
  try {
    const sourceDir = join(tempDir, 'source')
    downloadReleaseAssets({ assetNames, outputDir: sourceDir, tag })
    updateBetaFeed({
      commit,
      dmgPaths: dmgNames.map((dmgName) => join(sourceDir, dmgName)),
      manifestPath: join(sourceDir, 'latest.json'),
    })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

/**
 * Build signed + notarized artifacts for the release tagged v<version> (from
 * apps/desktop/package.json). The normal flow fills the asset-less draft
 * release that release-please created when the Release PR merged; the manual
 * fallback creates the release itself. A version with a prerelease segment
 * (e.g. `0.2.0-beta.1`) publishes as a GitHub pre-release. All preflight checks
 * run before the build so a doomed publish fails in seconds, not after
 * notarization.
 */
function ensurePublishableRelease({ flavorFlag }) {
  ensureGhReady()
  const commit = ensurePublishableCommit()
  const { version } = readTauriConf()
  const flavor = resolveFlavor({ flavorFlag, version, forPublish: true })
  const { productName } = readFlavorConf(flavor)
  const tag = `v${version}`
  const release = findReleaseByTag(tag)
  if (release) {
    ensureReleaseAcceptsAssets(release, tag)
    ensureReleaseTargetsCommit(release, tag, commit)
  } else {
    ensureTagMatchesCommit(tag, commit)
  }
  return { commit, flavor, productName, release, tag, version }
}

/** Run release publish checks without building artifacts or creating a release. */
function preflight({ flavorFlag }) {
  const { commit, release, tag } = ensurePublishableRelease({ flavorFlag })
  log(`${tag} is publishable from ${commit.slice(0, 7)}${release ? ' (into the existing draft release)' : ''}`)
}

/** Fill the release-please draft release: upload the artifacts, then finalize. */
function publishIntoExistingRelease({ assets, draft, prerelease, productName, release, releaseNotesPath, tag, version }) {
  log(`uploading ${assets.length} assets to the ${release.draft ? 'draft ' : ''}release ${tag}…`)
  const upload = spawnSync('gh', createExistingReleaseUploadArgs({ assets, tag }), {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  if (upload.status !== 0) {
    fail(`uploading release assets failed${upload.stdout ? `\n${upload.stdout.trim()}` : ''}`)
  }

  // Finalizing last keeps the release invisible (and `releases/latest`
  // unmoved) until every asset — latest.json included — is in place.
  const finalize = spawnSync(
    'gh',
    createFinalizeReleaseArgs({ keepDraft: draft, notesPath: releaseNotesPath, prerelease, productName, tag, version }),
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
  )
  if (finalize.status !== 0) {
    fail(`finalizing the GitHub release failed${finalize.stdout ? `\n${finalize.stdout.trim()}` : ''}`)
  }
  log(draft ? `draft release ${tag} updated — publish it from the GitHub UI` : `release published: ${tag}`)
}

/**
 * Publish freshly built or pre-staged macOS artifacts: into the draft release
 * created by release-please when one exists (the Release PR flow), otherwise
 * as a brand-new release (the manual workflow_dispatch fallback).
 */
function publish({ deferBetaFeed, draft, flavorFlag, fromArtifacts }) {
  const { commit, flavor, productName, release, tag, version } = ensurePublishableRelease({ flavorFlag })
  const artifactDir = fromArtifacts ?? mkdtempSync(join(tmpdir(), 'reflect-release-assets-'))

  if (!fromArtifacts) {
    for (const target of DEFAULT_PUBLISH_TARGETS) {
      build({ artifactDir, notarize: true, requireUpdater: true, flavor, target })
    }
  }

  const artifacts = readReleaseArtifacts({
    artifactDir,
    flavor,
    productName,
    targets: DEFAULT_PUBLISH_TARGETS,
    version,
  })
  const manifestPath = writeUpdaterManifest({ artifacts, outputDir: artifactDir, tag, version })
  const assets = [
    ...artifacts.flatMap((artifact) => [artifact.dmg, artifact.updaterArchive, artifact.updaterSignature]),
    manifestPath,
  ]
  // Pre-releases are invisible to `releases/latest` — the stable updater feed —
  // so installed stable apps never see a beta.
  const prerelease = version.includes('-')

  if (release) {
    // release-please already wrote the changelog into the release body; keep
    // it and append the Mac download chooser.
    const releaseNotesPath = join(artifactDir, RELEASE_NOTES_FILENAME)
    writeFileSync(releaseNotesPath, appendMacDownloadNotice({ body: release.body ?? '', productName }))
    publishIntoExistingRelease({ assets, draft, prerelease, productName, release, releaseNotesPath, tag, version })
  } else {
    const releaseNotesPath = writeReleaseNotes({
      commit,
      outputDir: artifactDir,
      productName,
      tag,
    })
    log(`creating GitHub ${prerelease ? 'pre-release' : 'release'} ${tag} from commit ${commit.slice(0, 7)}…`)
    const releaseArgs = createReleaseArgs({
      assets,
      commit,
      draft,
      notesPath: releaseNotesPath,
      prerelease,
      productName,
      tag,
      version,
    })
    const result = spawnSync('gh', releaseArgs, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] })
    if (result.status !== 0) fail(`creating the GitHub release failed${result.stdout ? `\n${result.stdout.trim()}` : ''}`)
    log(`${draft ? 'draft release created' : 'release published'}: ${result.stdout.trim()}`)
  }

  if (prerelease && !deferBetaFeed) {
    syncBetaFeed()
  } else if (prerelease) {
    log(`moving beta assets deferred to the downstream ${BETA_UPDATER_FEED_TAG} sync job`)
  }
}

async function setup() {
  console.log(
    `This stores notarization credentials in your login keychain (item "${KEYCHAIN_SERVICE}").\n` +
      `You need an app-specific password for an Apple ID on the team:\n` +
      `  ${APP_SPECIFIC_PASSWORD_URL} → Sign-In and Security → App-Specific Passwords\n`,
  )
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const account = (await readline.question('Apple ID email: ')).trim()
  readline.close()
  if (!/^\S+@\S+\.\S+$/.test(account)) fail(`"${account}" does not look like an email address`)

  // `security … -w` with no value prompts for the secret itself, so the
  // password never touches this process, its arguments, or shell history.
  console.log('Paste the app-specific password when prompted:')
  const result = spawnSync(
    'security',
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) fail('storing the password in the keychain failed')
  log(`stored credentials for ${account} — you can now run \`pnpm release:macos\``)
}

/**
 * Generate the Tauri updater keypair and store the private key in the
 * keychain (item "reflect-updater", base64-wrapped). The public key must be
 * committed as `plugins.updater.pubkey` in tauri.conf.json — installed apps
 * verify every update payload against it, so rotating the key only reaches
 * users through a release signed with the OLD key that ships the NEW pubkey.
 */
function setupUpdater() {
  if (run('security', ['find-generic-password', '-s', UPDATER_KEYCHAIN_SERVICE]).status === 0) {
    fail(
      `an updater signing key already exists (keychain item "${UPDATER_KEYCHAIN_SERVICE}").\n` +
        '  Rotating it strands installed apps unless a release signed with the old key ships\n' +
        '  the new pubkey first. If you really mean to rotate, delete the item with\n' +
        `  \`security delete-generic-password -s ${UPDATER_KEYCHAIN_SERVICE}\` and rerun.`,
    )
  }
  const keyDir = mkdtempSync(join(tmpdir(), 'reflect-updater-'))
  try {
    const keyPath = join(keyDir, 'updater.key')
    const generate = spawnSync(
      'pnpm',
      ['tauri', 'signer', 'generate', '--write-keys', keyPath, '--password', '', '--ci'],
      { cwd: appDir, encoding: 'utf8' },
    )
    if (generate.status !== 0 || !existsSync(keyPath)) {
      fail(`generating the updater keypair failed:\n${generate.stdout ?? ''}${generate.stderr ?? ''}`)
    }
    const store = run('security', [
      'add-generic-password',
      '-U',
      '-s',
      UPDATER_KEYCHAIN_SERVICE,
      '-a',
      'updater',
      '-w',
      readFileSync(keyPath).toString('base64'),
    ])
    if (store.status !== 0) fail(`storing the private key in the keychain failed:\n${store.output}`)
    log(`private key stored in the keychain (item "${UPDATER_KEYCHAIN_SERVICE}") — never commit it`)
    log('public key (set as plugins.updater.pubkey in apps/desktop/src-tauri/tauri.conf.json):')
    console.log(readFileSync(`${keyPath}.pub`, 'utf8').trim())
    log('for CI, copy the private key into the TAURI_SIGNING_PRIVATE_KEY secret')
  } finally {
    rmSync(keyDir, { recursive: true, force: true })
  }
}

const USAGE = `Usage: pnpm release:macos [command] [flags]

Commands:
  build          Signed + notarized release build, then verify (default)
  preflight      Check that the current commit can publish before CI spends macOS minutes
  sync-beta-feed Refresh moving beta downloads/feed from the published tagged release
  setup          Store the notarization Apple ID + app-specific password in the keychain
  setup-updater  Generate the auto-update signing keypair (keychain + pubkey to commit)
  verify         Re-run signing/Gatekeeper checks on already-built bundles
  publish        Build, then fill and undraft the release-please draft release (or create one)

Flags:
  --no-notarize   Skip notarization (signed-only build/verify)
  --draft         Create the GitHub release as a draft (publish only)
  --defer-beta-feed
                  Leave moving beta assets to a separate sync-beta-feed command (publish only)
  --target=<name> Build or verify one target: aarch64-apple-darwin | x86_64-apple-darwin
  --artifact-dir=<path>
                  Export release assets and metadata after build (build only)
  --from-artifacts=<path>
                  Publish already-built release assets from this directory (publish only)
  --flavor=<name> Build a flavor: stable | beta | dev (default: derived from the
                  version — prerelease → beta, else stable; publish ignores this
                  and always uses the version's channel)
  --help          Show this help

Docs: docs/macos-distribution.md`

async function main() {
  const argv = process.argv.slice(2)
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const commands = argv.filter((arg) => !arg.startsWith('--'))
  const command = commands[0] ?? 'build'
  const flavorFlag = flags.find((flag) => flag.startsWith('--flavor='))?.slice('--flavor='.length)
  const targetFlag = flags.find((flag) => flag.startsWith('--target='))?.slice('--target='.length)
  const artifactDir = flags.find((flag) => flag.startsWith('--artifact-dir='))?.slice('--artifact-dir='.length)
  const fromArtifacts = flags.find((flag) => flag.startsWith('--from-artifacts='))?.slice('--from-artifacts='.length)
  const unknownFlag = flags.find(
    (flag) =>
      !['--no-notarize', '--draft', '--defer-beta-feed', '--help'].includes(flag) &&
      !flag.startsWith('--flavor=') &&
      !flag.startsWith('--target=') &&
      !flag.startsWith('--artifact-dir=') &&
      !flag.startsWith('--from-artifacts='),
  )
  if (unknownFlag) fail(`unknown flag "${unknownFlag}"\n\n${USAGE}`)
  if (flavorFlag && !Object.keys(FLAVOR_OVERLAYS).includes(flavorFlag)) {
    fail(`unknown --flavor "${flavorFlag}" — one of: ${Object.keys(FLAVOR_OVERLAYS).join(', ')}`)
  }
  if (targetFlag) releaseTargetConfig(targetFlag)
  if (targetFlag && !['build', 'verify'].includes(command)) fail('--target only applies to build and verify')
  if (artifactDir && command !== 'build') fail('--artifact-dir only applies to build')
  if (fromArtifacts && command !== 'publish') fail('--from-artifacts only applies to publish')
  if (flags.includes('--defer-beta-feed') && command !== 'publish') fail('--defer-beta-feed only applies to publish')
  if (flags.includes('--help')) {
    console.log(USAGE)
    return
  }

  const needsMacos =
    ['build', 'setup', 'setup-updater', 'verify'].includes(command) || (command === 'publish' && !fromArtifacts)
  if (needsMacos && process.platform !== 'darwin') fail('this command only runs on macOS')

  const notarize = !flags.includes('--no-notarize')
  if (command === 'publish' && !notarize) fail('publish always notarizes — drop --no-notarize')
  if (command !== 'publish' && flags.includes('--draft')) fail('--draft only applies to publish')
  const { version } = readTauriConf()
  switch (command) {
    case 'build':
      return build({
        artifactDir,
        notarize,
        requireUpdater: Boolean(artifactDir),
        flavor: resolveFlavor({ flavorFlag, version, forPublish: false }),
        target: targetFlag ?? hostTarget(),
      })
    case 'preflight':
      return preflight({ flavorFlag })
    case 'setup':
      return setup()
    case 'setup-updater':
      return setupUpdater()
    case 'sync-beta-feed':
      return syncBetaFeed()
    case 'verify': {
      const flavor = resolveFlavor({ flavorFlag, version, forPublish: false })
      const target = targetFlag ?? hostTarget()
      verify({ notarized: notarize, flavor, target })
      return printArtifacts(flavor, target)
    }
    case 'publish':
      return publish({
        deferBetaFeed: flags.includes('--defer-beta-feed'),
        draft: flags.includes('--draft'),
        flavorFlag,
        fromArtifacts,
      })
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
