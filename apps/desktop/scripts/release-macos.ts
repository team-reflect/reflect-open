// Builds a signed, notarized macOS app and DMG. See docs/macos-distribution.md.
//
//   pnpm release:macos [build]        Build, sign, notarize, then verify
//   pnpm release:macos verify         Re-run the checks on existing bundles
//   pnpm release:macos setup          Store the notarization Apple ID in the keychain
//   pnpm release:macos setup-updater  Generate the updater signing keypair
//
//   --flavor=<stable|beta|dev>   Default: from the version
//   --target=<triple>            Default: the host triple
//   --artifact-dir=<path>        Copy the release assets there after the build
//   --no-notarize                Signed-only build

import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { x } from 'tinyexec'
import { z } from 'zod'
import {
  cargoTargetDir,
  exec,
  flavorConfigArgs,
  flavorOfVersion,
  isFlavor,
  keychainPassword,
  log,
  readAppVersion,
  readTauriConfig,
  resolveApiKey,
  resolveAppleId,
  run,
  runMain,
  storeAppleId,
  tauri,
  tauriDir,
  withTempDir,
  type Flavor,
} from './helpers.ts'

const INTEL_TARGET = 'x86_64-apple-darwin'
const ARCHS: Record<string, string> = {
  'aarch64-apple-darwin': 'aarch64',
  [INTEL_TARGET]: 'x86_64',
}
const UPDATER_KEYCHAIN_SERVICE = 'reflect-updater'
const ONNX_RUNTIME = 'onnxruntime-osx-x86_64-1.23.2'
const ONNX_RUNTIME_FILES = ['lib/libonnxruntime.dylib', 'LICENSE', 'ThirdPartyNotices.txt']
const PROFILE_IDENTITY_KEYS = [
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier',
]
const PlistSchema = z.record(z.string(), z.unknown())

interface Bundle {
  readonly target: string
  readonly arch: string
  readonly identifier: string
  /** The asset name prefix. GitHub rewrites spaces in asset names to dots, so do it up front. */
  readonly assetName: string
  readonly version: string
  readonly entitlements: string
  readonly hasProfile: boolean
  readonly app: string
  readonly sidecars: readonly string[]
  readonly dmg: string
  readonly updaterArchive: string
}

interface Signer {
  readonly identity: string
  readonly keychain: string | null
}

async function resolveBundle(flavor: Flavor, target: string): Promise<Bundle> {
  const arch = ARCHS[target]
  if (!arch) throw new Error(`unsupported target "${target}"`)
  const config = readTauriConfig('macos', flavor)
  const { entitlements, files } = config.bundle.macOS ?? {}
  if (!entitlements) throw new Error(`flavor "${flavor}" has no bundle.macOS.entitlements`)
  const version = readAppVersion()
  const bundleDir = join(await cargoTargetDir(), target, 'release', 'bundle')
  const app = join(bundleDir, 'macos', `${config.productName}.app`)
  return {
    target,
    arch,
    identifier: config.identifier,
    assetName: config.productName.replaceAll(' ', '.'),
    version,
    entitlements: join(tauriDir, entitlements),
    hasProfile: files?.['embedded.provisionprofile'] !== undefined,
    app,
    sidecars: config.bundle.externalBin.map((path) =>
      join(app, 'Contents', 'MacOS', basename(path)),
    ),
    dmg: join(bundleDir, 'dmg', `${config.productName}_${version}_${arch}.dmg`),
    updaterArchive: `${app}.tar.gz`,
  }
}

async function findSigningIdentity(): Promise<string> {
  if (process.env.APPLE_SIGNING_IDENTITY) return process.env.APPLE_SIGNING_IDENTITY
  const identities = await run('security', ['find-identity', '-v', '-p', 'codesigning'])
  const identity = /"(Developer ID Application: [^"]+)"/.exec(identities)?.[1]
  if (!identity) throw new Error('no "Developer ID Application" certificate in the keychain')
  return identity
}

async function resolveNotaryArgs(identity: string, tempDir: string): Promise<string[]> {
  const apiKey = resolveApiKey(tempDir)
  if (apiKey?.keyPath) {
    return ['--key', apiKey.keyPath, '--key-id', apiKey.keyId, '--issuer', apiKey.issuer]
  }
  const appleId = await resolveAppleId()
  const teamId = process.env.APPLE_TEAM_ID ?? /\(([0-9A-Z]{10})\)$/.exec(identity)?.[1]
  if (!appleId || !teamId) {
    throw new Error(
      'no notarization credentials: run `pnpm release:macos setup` or pass --no-notarize',
    )
  }
  return ['--apple-id', appleId.account, '--password', appleId.password, '--team-id', teamId]
}

/** The environment for `tauri signer sign`, or null when no updater key is available. */
async function resolveUpdaterKeyEnv(): Promise<NodeJS.ProcessEnv | null> {
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''
  if (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    return { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password }
  }
  const stored = await keychainPassword(UPDATER_KEYCHAIN_SERVICE)
  if (!stored) return null
  return {
    TAURI_SIGNING_PRIVATE_KEY: Buffer.from(stored, 'base64').toString('utf8'),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  }
}

/** Upstream ONNX Runtime 1.24 dropped macOS x86_64, so Intel builds bundle the 1.23 dylib. */
async function stageIntelOnnxRuntime(): Promise<string> {
  const resourceDir = join(tauriDir, 'resources', 'onnxruntime')
  const staged = ONNX_RUNTIME_FILES.map((file) => join(resourceDir, basename(file)))
  if (!staged.every((path) => existsSync(path))) {
    await withTempDir(async (tempDir) => {
      const archive = join(tempDir, `${ONNX_RUNTIME}.tgz`)
      const url = `https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/${ONNX_RUNTIME}.tgz`
      await exec('curl', ['-fL', '--retry', '3', '-o', archive, url])
      await exec('tar', ['-xzf', archive, '-C', tempDir])
      mkdirSync(resourceDir, { recursive: true })
      for (const file of ONNX_RUNTIME_FILES) {
        copyFileSync(join(tempDir, ONNX_RUNTIME, file), join(resourceDir, basename(file)))
      }
    })
  }
  const resources = {
    'resources/onnxruntime/libonnxruntime.dylib': 'libonnxruntime.dylib',
    'resources/onnxruntime/LICENSE': 'onnxruntime/LICENSE',
    'resources/onnxruntime/ThirdPartyNotices.txt': 'onnxruntime/ThirdPartyNotices.txt',
  }
  return JSON.stringify({ bundle: { resources } })
}

async function buildApp(flavor: Flavor, target: string, identity: string): Promise<void> {
  const args = ['build', '--target', target, '--bundles', 'app', ...flavorConfigArgs(flavor)]
  if (target === INTEL_TARGET) args.push('--config', await stageIntelOnnxRuntime())
  // Tauri notarizes whenever these are set, but notarization must wait until
  // the sidecars are re-signed.
  for (const name of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_ISSUER']) {
    delete process.env[name]
  }
  await tauri(args, { APPLE_SIGNING_IDENTITY: identity })
}

/**
 * Imports `APPLE_CERTIFICATE` into a temporary keychain for the signing steps
 * that run after Tauri has removed its own. Without the variable, the login
 * keychain is used.
 */
async function withSigningKeychain(
  tempDir: string,
  action: (keychain: string | null) => Promise<void>,
): Promise<void> {
  const { APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD } = process.env
  if (!APPLE_CERTIFICATE || !APPLE_CERTIFICATE_PASSWORD) return await action(null)

  const certificate = join(tempDir, 'certificate.p12')
  const keychain = join(tempDir, 'signing.keychain-db')
  const password = randomBytes(24).toString('hex')
  const searchList = await run('security', ['list-keychains', '-d', 'user'])
  const previous = [...searchList.matchAll(/"([^"]+)"/g)].flatMap((match) => match[1] ?? [])
  writeFileSync(certificate, Buffer.from(APPLE_CERTIFICATE, 'base64'), { mode: 0o600 })
  try {
    await run('security', ['create-keychain', '-p', password, keychain])
    // Notarization can outlast the default five-minute auto-lock.
    await run('security', ['set-keychain-settings', '-lut', '21600', keychain])
    await run('security', ['unlock-keychain', '-p', password, keychain])
    await run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...previous])
    const importArgs = ['-P', APPLE_CERTIFICATE_PASSWORD, '-T', '/usr/bin/codesign']
    await run('security', ['import', certificate, '-k', keychain, ...importArgs])
    const partitions = ['-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password]
    await run('security', ['set-key-partition-list', ...partitions, keychain])
    await action(keychain)
  } finally {
    await x('security', ['list-keychains', '-d', 'user', '-s', ...previous])
    await x('security', ['delete-keychain', keychain])
  }
}

async function codesign(signer: Signer, args: readonly string[]): Promise<void> {
  const keychain = signer.keychain ? ['--keychain', signer.keychain] : []
  await exec('codesign', [
    '--force',
    '--sign',
    signer.identity,
    '--timestamp',
    ...keychain,
    ...args,
  ])
}

/** Converts plist text to JSON with `plutil`. `args` selects the conversion. */
async function readPlist(
  plist: string,
  args = ['-convert', 'json'],
): Promise<Record<string, unknown>> {
  const json = await run('plutil', [...args, '-o', '-', '-'], { stdin: plist })
  return PlistSchema.parse(JSON.parse(json))
}

/**
 * The application and team identifiers from the embedded provisioning profile.
 * A Developer ID app that uses iCloud must carry them in its signature.
 */
async function readProfileIdentity(bundle: Bundle): Promise<Record<string, string>> {
  const profilePath = join(bundle.app, 'Contents', 'embedded.provisionprofile')
  const profile = await run('security', ['cms', '-D', '-i', profilePath])
  const entitlements = await readPlist(profile, ['-extract', 'Entitlements', 'json'])
  const identity = z
    .record(z.string(), z.string())
    .parse(Object.fromEntries(PROFILE_IDENTITY_KEYS.map((key) => [key, entitlements[key]])))
  const applicationId = identity['com.apple.application-identifier'] ?? ''
  if (applicationId.slice(applicationId.indexOf('.') + 1) !== bundle.identifier) {
    throw new Error(`provisioning profile is for "${applicationId}", not "${bundle.identifier}"`)
  }
  return identity
}

/** The entitlements file for the app: the configured one plus the profile identity. */
async function prepareEntitlements(bundle: Bundle, tempDir: string): Promise<string> {
  if (!bundle.hasProfile) return bundle.entitlements
  const merged = {
    ...(await readPlist(readFileSync(bundle.entitlements, 'utf8'))),
    ...(await readProfileIdentity(bundle)),
  }
  const path = join(tempDir, 'Entitlements.plist')
  writeFileSync(path, JSON.stringify(merged))
  await run('plutil', ['-convert', 'xml1', path])
  return path
}

/**
 * Tauri signs the sidecars with the app's entitlements. The restricted iCloud
 * entitlements have no matching profile there, so the system kills them at
 * launch. Re-sign the sidecars without entitlements, then the app around them.
 */
async function resignApp(bundle: Bundle, signer: Signer, tempDir: string): Promise<void> {
  for (const sidecar of bundle.sidecars) {
    await codesign(signer, ['--options', 'runtime', sidecar])
  }
  const entitlements = await prepareEntitlements(bundle, tempDir)
  await codesign(signer, ['--options', 'runtime', '--entitlements', entitlements, bundle.app])
}

async function notarize(path: string, notaryArgs: readonly string[]): Promise<void> {
  log(`notarizing ${basename(path)}`)
  const submit = ['notarytool', 'submit', path, ...notaryArgs, '--wait', '--output-format', 'json']
  const { stdout, stderr } = await x('xcrun', submit)
  const verdict = z
    .object({ id: z.string(), status: z.string() })
    .safeParse(stdout.startsWith('{') ? JSON.parse(stdout) : null).data
  if (verdict?.status === 'Accepted') return
  const detail = verdict
    ? await run('xcrun', ['notarytool', 'log', verdict.id, ...notaryArgs])
    : `${stdout}${stderr}`
  throw new Error(`notarization of ${basename(path)} failed\n${detail}`)
}

async function notarizeApp(
  bundle: Bundle,
  notaryArgs: readonly string[],
  tempDir: string,
): Promise<void> {
  const zip = join(tempDir, `${basename(bundle.app)}.zip`)
  await exec('ditto', ['-c', '-k', '--keepParent', bundle.app, zip])
  await notarize(zip, notaryArgs)
  await exec('xcrun', ['stapler', 'staple', bundle.app])
}

/** The updater payload must come from the re-signed app, so Tauri cannot create it. */
async function createUpdaterArchive(bundle: Bundle, keyEnv: NodeJS.ProcessEnv): Promise<void> {
  rmSync(`${bundle.updaterArchive}.sig`, { force: true })
  const tarArgs = ['-czf', bundle.updaterArchive, '-C', dirname(bundle.app), basename(bundle.app)]
  await exec('tar', tarArgs)
  await tauri(['signer', 'sign', bundle.updaterArchive], keyEnv)
}

/**
 * Tauri's DMG script drives Finder and is brittle on CI. `hdiutil` under-sizes
 * a compressed image made straight from a folder, so build a writable image
 * with headroom first, then compress it.
 */
async function createDmg(bundle: Bundle, signer: Signer, tempDir: string): Promise<void> {
  const stagingDir = join(tempDir, 'dmg')
  const writableDmg = join(tempDir, 'writable.dmg')
  mkdirSync(stagingDir)
  await exec('ditto', [bundle.app, join(stagingDir, basename(bundle.app))])
  symlinkSync('/Applications', join(stagingDir, 'Applications'))

  const usedKb = Number((await run('du', ['-sk', stagingDir])).split('\t')[0])
  const sizeMb = Math.ceil(usedKb / 1024) * 2 + 32
  const volumeName = basename(bundle.app, '.app')
  const createArgs = ['-volname', volumeName, '-srcfolder', stagingDir, '-format', 'UDRW']
  await exec('hdiutil', ['create', ...createArgs, '-size', `${sizeMb}m`, writableDmg])
  mkdirSync(dirname(bundle.dmg), { recursive: true })
  const convertArgs = ['-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', '-o', bundle.dmg]
  await exec('hdiutil', ['convert', writableDmg, ...convertArgs])
  await codesign(signer, [bundle.dmg])
}

async function expectOutput(
  command: string,
  args: readonly string[],
  expected: readonly string[],
): Promise<void> {
  const { exitCode, stdout, stderr } = await x(command, args, {
    nodeOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
  })
  const output = `${stdout}${stderr}`
  if (exitCode !== 0 || !expected.every((text) => output.includes(text))) {
    throw new Error(`check failed: ${command} ${args.join(' ')}\n${output}`)
  }
}

async function verifyProfileIdentity(bundle: Bundle): Promise<void> {
  if (!bundle.hasProfile) return
  const xml = await run('codesign', ['--display', '--entitlements', '-', '--xml', bundle.app])
  const signed = await readPlist(xml)
  for (const [key, value] of Object.entries(await readProfileIdentity(bundle))) {
    if (signed[key] !== value) throw new Error(`the signed app lost the "${key}" entitlement`)
  }
}

/** A sidecar with a bad signature passes `codesign --verify` and dies at launch, so launch them. */
async function verifySidecarsLaunch(bundle: Bundle): Promise<void> {
  if (bundle.target !== INTEL_TARGET && process.arch !== 'arm64') return
  for (const sidecar of bundle.sidecars) {
    await expectOutput(sidecar, basename(sidecar) === 'reflect' ? ['--version'] : [], [])
  }
}

async function verify(bundle: Bundle, notarized: boolean): Promise<void> {
  await expectOutput(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', bundle.app],
    ['valid on disk', 'satisfies its Designated Requirement'],
  )
  await verifyProfileIdentity(bundle)
  await verifySidecarsLaunch(bundle)
  if (!notarized) return
  const accepted = ['accepted', 'source=Notarized Developer ID']
  await expectOutput('spctl', ['--assess', '--type', 'execute', '-v', bundle.app], accepted)
  const openContext = ['--type', 'open', '--context', 'context:primary-signature']
  await expectOutput('spctl', ['--assess', ...openContext, '-v', bundle.dmg], accepted)
  for (const path of [bundle.app, bundle.dmg]) {
    await expectOutput('xcrun', ['stapler', 'validate', path], ['The validate action worked!'])
  }
  log('verified')
}

/** Copies the release assets under the names they are published with. */
function exportArtifacts(bundle: Bundle, artifactDir: string): void {
  const archiveName = `${bundle.assetName}_${bundle.version}_${bundle.arch}.app.tar.gz`
  mkdirSync(artifactDir, { recursive: true })
  copyFileSync(bundle.dmg, join(artifactDir, `${bundle.assetName}_${bundle.arch}.dmg`))
  copyFileSync(bundle.updaterArchive, join(artifactDir, archiveName))
  copyFileSync(`${bundle.updaterArchive}.sig`, join(artifactDir, `${archiveName}.sig`))
}

interface BuildOptions {
  readonly flavor: Flavor
  readonly target: string
  readonly notarize: boolean
  readonly artifactDir: string | undefined
}

async function build({
  flavor,
  target,
  notarize: shouldNotarize,
  artifactDir,
}: BuildOptions): Promise<void> {
  const bundle = await resolveBundle(flavor, target)
  const identity = await findSigningIdentity()
  const updaterKeyEnv = await resolveUpdaterKeyEnv()
  if (artifactDir && !updaterKeyEnv)
    throw new Error('no updater signing key: run `pnpm release:macos setup-updater`')

  await withTempDir(async (tempDir) => {
    const notaryArgs = shouldNotarize ? await resolveNotaryArgs(identity, tempDir) : null
    await buildApp(flavor, target, identity)
    await withSigningKeychain(tempDir, async (keychain) => {
      const signer = { identity, keychain }
      await resignApp(bundle, signer, tempDir)
      if (notaryArgs) await notarizeApp(bundle, notaryArgs, tempDir)
      if (updaterKeyEnv) await createUpdaterArchive(bundle, updaterKeyEnv)
      await createDmg(bundle, signer, tempDir)
    })
    if (notaryArgs) {
      await notarize(bundle.dmg, notaryArgs)
      await exec('xcrun', ['stapler', 'staple', bundle.dmg])
    }
  })
  await verify(bundle, shouldNotarize)
  if (artifactDir) exportArtifacts(bundle, artifactDir)
  log(`done: ${bundle.dmg}`)
}

async function setup(): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const account = (await readline.question('Apple ID email: ')).trim()
  readline.close()
  console.log('Paste the app-specific password (https://account.apple.com) when prompted:')
  await storeAppleId(account)
}

/**
 * Installed apps verify every update against the committed public key, so a
 * new key only reaches them through a release signed with the old one.
 */
async function setupUpdater(): Promise<void> {
  if (await keychainPassword(UPDATER_KEYCHAIN_SERVICE)) {
    throw new Error(`keychain item "${UPDATER_KEYCHAIN_SERVICE}" already exists`)
  }
  await withTempDir(async (tempDir) => {
    const keyPath = join(tempDir, 'updater.key')
    await tauri(['signer', 'generate', '--write-keys', keyPath, '--password', '', '--ci'])
    const privateKey = readFileSync(keyPath).toString('base64')
    const item = ['-U', '-s', UPDATER_KEYCHAIN_SERVICE, '-a', 'updater', '-w', privateKey]
    await run('security', ['add-generic-password', ...item])
    log('public key for plugins.updater.pubkey in tauri.conf.json:')
    console.log(readFileSync(`${keyPath}.pub`, 'utf8').trim())
  })
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      flavor: { type: 'string' },
      target: { type: 'string' },
      'artifact-dir': { type: 'string' },
      'no-notarize': { type: 'boolean', default: false },
    },
  })
  const command = positionals[0] ?? 'build'
  if (command === 'setup') return await setup()
  if (command === 'setup-updater') return await setupUpdater()

  const flavor = values.flavor ?? flavorOfVersion(readAppVersion())
  if (!isFlavor(flavor)) throw new Error(`unknown flavor "${flavor}"`)
  const target = values.target ?? (await run('rustc', ['--print', 'host-tuple']))
  const notarize = !values['no-notarize']
  if (command === 'verify') return await verify(await resolveBundle(flavor, target), notarize)
  if (command !== 'build') throw new Error(`unknown command "${command}"`)
  await build({ flavor, target, notarize, artifactDir: values['artifact-dir'] })
}

await runMain(main)
