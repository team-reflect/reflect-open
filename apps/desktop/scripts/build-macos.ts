// Builds a signed, notarized macOS app and DMG, with the Safari extension
// inside. The shipped executables are stripped; their symbols stay in dSYMs.
// See docs/distribution.md.
//
//   pnpm build:macos [flags]
//
//   --target=<triple>       Default: the host triple
//   --artifact-dir=<path>   Copy the release assets and the dSYMs there after the build
//   --no-notarize           Signed-only build, for local runs without Apple credentials
//   --no-sign               Unsigned app only, to check that it compiles and bundles

import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { apply as applyMergePatch } from 'tiny-merge-patch'
import { exec } from 'tinyexec'
import { z } from 'zod'
import packageJson from '../package.json' with { type: 'json' }
import {
  assertDsyms,
  assertSentryDsn,
  getFlavorConfigArgs,
  getFlavorOverlay,
  getHostTriple,
  INHERIT,
  log,
  resolveApiKey,
  runTauri,
  runWithTempDir,
  TARGET_DIR,
  TAURI_SRC_DIR,
} from './helpers.ts'
import {
  APP_GROUPS_KEY,
  embedSafariExtension,
  REFLECT_TEAM_ID,
  safariAppexEntitlements,
  safariAppexPath,
  safariAppGroup,
} from './safari-extension.ts'

const APPLE_SILICON_TARGET = 'aarch64-apple-darwin'
const INTEL_TARGET = 'x86_64-apple-darwin'
const UNIVERSAL_TARGET = 'universal-apple-darwin'
const ARCHS: Record<string, string> = {
  [APPLE_SILICON_TARGET]: 'aarch64',
  [INTEL_TARGET]: 'x86_64',
  [UNIVERSAL_TARGET]: 'universal',
}
const MAIN_BINARY = 'reflect-open'
/** A symbol from each shipped executable's own crate, which stripping removes. */
const CRATE_SYMBOLS = new Map([
  [MAIN_BINARY, 'reflect_open_lib'],
  ['reflect', 'reflect_cli'],
  ['reflect-capture-host', 'reflect_capture_host'],
])
const PROFILE_IDENTITY_KEYS = [
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier',
]
const PlistSchema = z.record(z.string(), z.unknown())
const TauriConfigSchema = z.object({
  productName: z.string(),
  identifier: z.string(),
  bundle: z.object({
    externalBin: z.array(z.string()),
    macOS: z.object({
      entitlements: z.string(),
      files: z.record(z.string(), z.string()).default({}),
    }),
  }),
})

interface Dsym {
  /** The target triple whose build wrote the dSYM. */
  readonly triple: string
  readonly path: string
}

interface Executable {
  readonly path: string
  readonly symbol: string
  /** One dSYM per architecture. */
  readonly dsyms: readonly Dsym[]
}

interface Bundle {
  readonly target: string
  readonly arch: string
  readonly identifier: string
  /** The asset name prefix. GitHub rewrites spaces in asset names to dots, so do it up front. */
  readonly assetName: string
  readonly version: string
  readonly entitlements: string
  /** The flavor's provisioning profile in the source tree, when it has one. */
  readonly profile: string | null
  readonly app: string
  /** The Safari app extension inside {@link app}. */
  readonly appex: string
  /** The App Group the app and its Safari extension share. */
  readonly appGroup: string
  readonly sidecars: readonly string[]
  readonly executables: readonly Executable[]
  readonly dmg: string
  readonly updaterArchive: string
}

interface Signer {
  readonly identity: string
  readonly keychain: string | null
}

/** Resolves the config the way `tauri build` does: base, then platform file, then flavor overlay. */
function readTauriConfig(): z.infer<typeof TauriConfigSchema> {
  let config: unknown = {}
  for (const file of ['tauri.conf.json', 'tauri.macos.conf.json', getFlavorOverlay()]) {
    if (file) {
      const patch: unknown = JSON.parse(readFileSync(join(TAURI_SRC_DIR, file), 'utf8'))
      config = applyMergePatch(config, patch)
    }
  }
  return TauriConfigSchema.parse(config)
}

/**
 * Every path and identifier the build produces or checks for `target`, from
 * the flavor's Tauri config. Nothing is built yet.
 */
function resolveBundle(target: string): Bundle {
  const arch = ARCHS[target]
  if (!arch) {
    throw new Error(`unsupported target "${target}"`)
  }
  const { productName, identifier, bundle } = readTauriConfig()
  const version = packageJson.version
  const bundleDir = join(TARGET_DIR, target, 'release', 'bundle')
  const app = join(bundleDir, 'macos', `${productName}.app`)
  const macosDir = join(app, 'Contents', 'MacOS')
  const sidecars = bundle.externalBin.map((path) => join(macosDir, basename(path)))
  // A universal build compiles each architecture on its own and merges them with lipo.
  const triples = target === UNIVERSAL_TARGET ? [APPLE_SILICON_TARGET, INTEL_TARGET] : [target]
  const executables = [join(macosDir, MAIN_BINARY), ...sidecars].map((path) => {
    const name = basename(path)
    const symbol = CRATE_SYMBOLS.get(name)
    if (!symbol) {
      throw new Error(`no crate symbol for ${name}`)
    }
    const dsyms = triples.map((triple) => ({
      triple,
      path: join(TARGET_DIR, triple, 'release', `${name}.dSYM`),
    }))
    return { path, symbol, dsyms }
  })
  const profile = bundle.macOS.files['embedded.provisionprofile']
  return {
    target,
    arch,
    identifier,
    assetName: productName.replaceAll(' ', '.'),
    version,
    entitlements: join(TAURI_SRC_DIR, bundle.macOS.entitlements),
    profile: profile ? join(TAURI_SRC_DIR, profile) : null,
    app,
    appex: safariAppexPath(app),
    appGroup: safariAppGroup(REFLECT_TEAM_ID, identifier),
    sidecars,
    executables,
    dmg: join(bundleDir, 'dmg', `${productName}_${version}_${arch}.dmg`),
    updaterArchive: `${app}.tar.gz`,
  }
}

function resolveNotaryArgs(identity: string, tempDir: string): string[] {
  const apiKey = resolveApiKey(tempDir)
  if (apiKey) {
    return ['--key', apiKey.keyPath, '--key-id', apiKey.keyId, '--issuer', apiKey.issuer]
  }
  const { APPLE_ID, APPLE_PASSWORD } = process.env
  const teamId = process.env.APPLE_TEAM_ID ?? /\(([0-9A-Z]{10})\)$/.exec(identity)?.[1]
  if (!APPLE_ID || !APPLE_PASSWORD || !teamId) {
    throw new Error('no notarization credentials: set APPLE_API_KEY or APPLE_ID')
  }
  return ['--apple-id', APPLE_ID, '--password', APPLE_PASSWORD, '--team-id', teamId]
}

/**
 * Builds the app with Tauri (stripped executables, dSYMs kept), then embeds
 * the Safari app extension. Signing and notarization happen afterwards.
 */
async function buildApp(bundle: Bundle): Promise<void> {
  const args = ['build', '--target', bundle.target, '--bundles', 'app', ...getFlavorConfigArgs()]
  // Tauri notarizes whenever these are set, but notarization must wait until
  // the sidecars are re-signed.
  for (const name of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_ISSUER']) {
    delete process.env[name]
  }
  // Cargo writes a dSYM next to each executable, then strips the executable.
  // The sidecar build in `beforeBuildCommand` inherits these.
  await runTauri(args, {
    CARGO_PROFILE_RELEASE_DEBUG: 'line-tables-only',
    CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: 'packed',
    CARGO_PROFILE_RELEASE_STRIP: 'symbols',
  })
  for (const { path, dsyms, symbol } of bundle.executables) {
    await assertDsyms(
      path,
      dsyms.map((dsym) => dsym.path),
      symbol,
    )
  }
  await embedSafariExtension(bundle.app, bundle.appGroup)
}

/**
 * Imports `APPLE_CERTIFICATE` into a temporary keychain for the signing steps
 * that run after Tauri has removed its own. Without the variable, the login
 * keychain is used.
 */
async function runWithSigningKeychain(
  tempDir: string,
  action: (keychain: string | null) => Promise<void>,
): Promise<void> {
  const { APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD } = process.env
  if (!APPLE_CERTIFICATE || !APPLE_CERTIFICATE_PASSWORD) {
    return await action(null)
  }

  const certificate = join(tempDir, 'certificate.p12')
  const keychain = join(tempDir, 'signing.keychain-db')
  const password = randomBytes(24).toString('hex')
  const searchList = await exec('security', ['list-keychains', '-d', 'user'], {
    throwOnError: true,
  })
  const previous = [...searchList.stdout.matchAll(/"([^"]+)"/g)].flatMap((match) => match[1] ?? [])
  writeFileSync(certificate, Buffer.from(APPLE_CERTIFICATE, 'base64'), { mode: 0o600 })
  const steps = [
    ['create-keychain', '-p', password, keychain],
    // Notarization can outlast the default five-minute auto-lock.
    ['set-keychain-settings', '-lut', '21600', keychain],
    ['unlock-keychain', '-p', password, keychain],
    ['list-keychains', '-d', 'user', '-s', keychain, ...previous],
    [
      'import',
      certificate,
      '-k',
      keychain,
      '-P',
      APPLE_CERTIFICATE_PASSWORD,
      '-T',
      '/usr/bin/codesign',
    ],
    [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      password,
      keychain,
    ],
  ]
  try {
    for (const step of steps) {
      await exec('security', step, { throwOnError: true })
    }
    await action(keychain)
  } finally {
    await exec('security', ['list-keychains', '-d', 'user', '-s', ...previous])
    await exec('security', ['delete-keychain', keychain])
  }
}

async function runCodesign(signer: Signer, args: readonly string[]): Promise<void> {
  const keychain = signer.keychain ? ['--keychain', signer.keychain] : []
  const base = ['--force', '--sign', signer.identity, '--timestamp']
  await exec('codesign', [...base, ...keychain, ...args], INHERIT)
}

/** Converts plist text to JSON with `plutil`. `args` selects the conversion. */
async function readPlist(
  plist: string,
  args = ['-convert', 'json'],
): Promise<Record<string, unknown>> {
  const { stdout } = await exec('plutil', [...args, '-o', '-', '-'], {
    throwOnError: true,
    stdin: plist,
  })
  return PlistSchema.parse(JSON.parse(stdout))
}

/** The entitlements the provisioning profile at `path` grants (a CMS-signed plist). */
async function readProfileEntitlements(path: string): Promise<Record<string, unknown>> {
  const profile = await exec('security', ['cms', '-D', '-i', path], { throwOnError: true })
  return await readPlist(profile.stdout, ['-extract', 'Entitlements', 'json'])
}

/**
 * The application and team identifiers from the embedded provisioning profile.
 * A Developer ID app that uses iCloud must carry them in its signature.
 */
async function readProfileIdentity(bundle: Bundle): Promise<Record<string, string>> {
  const profilePath = join(bundle.app, 'Contents', 'embedded.provisionprofile')
  const entitlements = await readProfileEntitlements(profilePath)
  const identity = z
    .record(z.string(), z.string())
    .parse(Object.fromEntries(PROFILE_IDENTITY_KEYS.map((key) => [key, entitlements[key]])))
  const applicationId = identity['com.apple.application-identifier'] ?? ''
  if (applicationId.slice(applicationId.indexOf('.') + 1) !== bundle.identifier) {
    throw new Error(`provisioning profile is for "${applicationId}", not "${bundle.identifier}"`)
  }
  return identity
}

/**
 * The app claims the App Group so it can read the Safari extension's inbox
 * without a macOS prompt. That claim is validation-required: if the embedded
 * profile does not authorize it, the app still launches, but with its
 * entitlements-validated flag cleared, and Apple does not say what that does
 * to iCloud. Refuse before the build instead of finding out in a release.
 */
async function assertProfileAuthorizesAppGroup(bundle: Bundle): Promise<void> {
  if (!bundle.profile) {
    return
  }
  const { [APP_GROUPS_KEY]: claim } = await readProfileEntitlements(bundle.profile)
  const authorized = z.array(z.string()).default([]).parse(claim)
  if (!authorized.includes(bundle.appGroup) && !authorized.includes(`${REFLECT_TEAM_ID}.*`)) {
    throw new Error(
      `${basename(bundle.profile)} does not authorize the App Group ${bundle.appGroup}: ` +
        'see "Safari extension" in docs/distribution.md',
    )
  }
}

/** Writes `entitlements` as an XML plist for `codesign --entitlements` and returns its path. */
async function writeEntitlements(
  name: string,
  entitlements: Record<string, unknown>,
  tempDir: string,
): Promise<string> {
  const path = join(tempDir, name)
  writeFileSync(path, JSON.stringify(entitlements))
  await exec('plutil', ['-convert', 'xml1', path], { throwOnError: true })
  return path
}

/** The entitlements file for the app: the configured ones, its profile identity and its App Group. */
async function prepareEntitlements(bundle: Bundle, tempDir: string): Promise<string> {
  const merged = {
    ...(await readPlist(readFileSync(bundle.entitlements, 'utf8'))),
    ...(bundle.profile ? await readProfileIdentity(bundle) : {}),
    [APP_GROUPS_KEY]: [bundle.appGroup],
  }
  return await writeEntitlements('Entitlements.plist', merged, tempDir)
}

/**
 * Tauri signs the sidecars with the app's entitlements. The restricted iCloud
 * entitlements have no matching profile there, so the system kills them at
 * launch. Re-sign the sidecars without entitlements, sign the Safari app
 * extension with its own, then sign the app around them.
 */
async function resignApp(bundle: Bundle, signer: Signer, tempDir: string): Promise<void> {
  for (const sidecar of bundle.sidecars) {
    await runCodesign(signer, ['--options', 'runtime', sidecar])
  }
  const appexEntitlements = await writeEntitlements(
    'SafariExtension.plist',
    safariAppexEntitlements(bundle.appGroup),
    tempDir,
  )
  await runCodesign(signer, [
    '--options',
    'runtime',
    '--entitlements',
    appexEntitlements,
    bundle.appex,
  ])
  const entitlements = await prepareEntitlements(bundle, tempDir)
  await runCodesign(signer, ['--options', 'runtime', '--entitlements', entitlements, bundle.app])
}

async function notarize(path: string, notaryArgs: readonly string[]): Promise<void> {
  log(`notarizing ${basename(path)}`)
  const submit = ['notarytool', 'submit', path, ...notaryArgs, '--wait', '--output-format', 'json']
  const { stdout, stderr } = await exec('xcrun', submit)
  const verdict = z
    .object({ id: z.string(), status: z.string() })
    .safeParse(stdout.startsWith('{') ? JSON.parse(stdout) : null).data
  if (verdict?.status === 'Accepted') {
    return
  }
  const report = verdict
    ? await exec('xcrun', ['notarytool', 'log', verdict.id, ...notaryArgs])
    : null
  throw new Error(`notarization of ${basename(path)} failed\n${report?.stdout ?? stdout + stderr}`)
}

async function notarizeApp(
  bundle: Bundle,
  notaryArgs: readonly string[],
  tempDir: string,
): Promise<void> {
  const zip = join(tempDir, `${basename(bundle.app)}.zip`)
  await exec('ditto', ['-c', '-k', '--keepParent', bundle.app, zip], INHERIT)
  await notarize(zip, notaryArgs)
  await exec('xcrun', ['stapler', 'staple', bundle.app], INHERIT)
}

/** The updater payload must come from the re-signed app, so Tauri cannot create it. */
async function createUpdaterArchive(bundle: Bundle): Promise<void> {
  rmSync(`${bundle.updaterArchive}.sig`, { force: true })
  const tarArgs = ['-czf', bundle.updaterArchive, '-C', dirname(bundle.app), basename(bundle.app)]
  await exec('tar', tarArgs, INHERIT)
  // An unset password makes the signer prompt.
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''
  await runTauri(['signer', 'sign', bundle.updaterArchive], {
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  })
}

/**
 * Runs `hdiutil` up to 3 times. On CI runners it sometimes fails with
 * "Resource busy" while the system still holds the image.
 */
async function runHdiutil(args: readonly string[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const { exitCode } = await exec('hdiutil', args, { nodeOptions: { stdio: 'inherit' } })
    if (exitCode === 0) {
      return
    }
    if (attempt === 3) {
      throw new Error(`hdiutil ${args[0]} failed with exit code ${exitCode}`)
    }
    log(`hdiutil ${args[0]} failed, retrying in ${attempt * 5}s`)
    await sleep(attempt * 5000)
  }
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
  await exec('ditto', [bundle.app, join(stagingDir, basename(bundle.app))], INHERIT)
  symlinkSync('/Applications', join(stagingDir, 'Applications'))

  const usage = await exec('du', ['-sk', stagingDir], { throwOnError: true })
  const usedKb = Number(usage.stdout.split('\t')[0])
  const sizeMb = Math.ceil(usedKb / 1024) * 2 + 32
  const volumeName = basename(bundle.app, '.app')
  const createArgs = ['-volname', volumeName, '-srcfolder', stagingDir, '-format', 'UDRW', '-ov']
  await runHdiutil(['create', ...createArgs, '-size', `${sizeMb}m`, writableDmg])
  mkdirSync(dirname(bundle.dmg), { recursive: true })
  const convertArgs = ['-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', '-o', bundle.dmg]
  await runHdiutil(['convert', writableDmg, ...convertArgs])
  await runCodesign(signer, [bundle.dmg])
}

async function expectOutput(
  command: string,
  args: readonly string[],
  expected: readonly string[],
): Promise<void> {
  const { exitCode, stdout, stderr } = await exec(command, args, {
    nodeOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
  })
  const output = `${stdout}${stderr}`
  if (exitCode !== 0 || !expected.every((text) => output.includes(text))) {
    throw new Error(`check failed: ${command} ${args.join(' ')}\n${output}`)
  }
}

/** The entitlements `path` was actually signed with, read back from its signature. */
async function readSignedEntitlements(path: string): Promise<Record<string, unknown>> {
  const display = ['--display', '--entitlements', '-', '--xml', path]
  return await readPlist((await exec('codesign', display, { throwOnError: true })).stdout)
}

/**
 * The re-signed app must still carry the profile's application and team
 * identifiers, or iCloud fails at runtime. A flavor without a profile has
 * nothing to check.
 */
async function verifyProfileIdentity(bundle: Bundle): Promise<void> {
  if (!bundle.profile) {
    return
  }
  const signed = await readSignedEntitlements(bundle.app)
  for (const [key, value] of Object.entries(await readProfileIdentity(bundle))) {
    if (signed[key] !== value) {
      throw new Error(`the signed app lost the "${key}" entitlement`)
    }
  }
}

/**
 * A wrong App Group passes `codesign --verify` and only shows as Safari
 * captures that never save, so check what was signed.
 */
async function verifySafariExtension(bundle: Bundle): Promise<void> {
  for (const path of [bundle.app, bundle.appex]) {
    const display = ['--display', '--verbose=2', path]
    await expectOutput('codesign', display, [`TeamIdentifier=${REFLECT_TEAM_ID}`])
    const groups = z.array(z.string()).parse((await readSignedEntitlements(path))[APP_GROUPS_KEY])
    if (!groups.includes(bundle.appGroup)) {
      throw new Error(`${basename(path)} is not signed into ${bundle.appGroup}`)
    }
  }
  const signed = await readSignedEntitlements(bundle.appex)
  if (signed['com.apple.security.app-sandbox'] !== true) {
    throw new Error('Safari loads only a sandboxed app extension')
  }
  const info = join(bundle.appex, 'Contents', 'Info.plist')
  const readGroup = ['-extract', 'ReflectAppGroup', 'raw', '-o', '-', info]
  await expectOutput('plutil', readGroup, [bundle.appGroup])
  if (!existsSync(join(bundle.appex, 'Contents', 'Resources', 'manifest.json'))) {
    throw new Error('the Safari app extension has no web extension in its Resources')
  }
}

/** A sidecar with a bad signature passes `codesign --verify` and dies at launch, so launch them. */
async function verifySidecarsLaunch(bundle: Bundle): Promise<void> {
  if (bundle.target === APPLE_SILICON_TARGET && process.arch !== 'arm64') {
    return
  }
  const slices =
    bundle.target === UNIVERSAL_TARGET && process.arch === 'arm64' ? ['-arm64', '-x86_64'] : [null]
  for (const sidecar of bundle.sidecars) {
    const args = basename(sidecar) === 'reflect' ? ['--version'] : []
    for (const slice of slices) {
      if (slice) {
        await expectOutput('arch', [slice, sidecar, ...args], [])
      } else {
        await expectOutput(sidecar, args, [])
      }
    }
  }
}

/**
 * Checks the finished build before it ships: signatures, entitlements, the
 * Safari app extension and sidecar launches, then Gatekeeper and stapling
 * when `notarized`.
 */
async function verify(bundle: Bundle, notarized: boolean): Promise<void> {
  await expectOutput(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', bundle.app],
    ['valid on disk', 'satisfies its Designated Requirement'],
  )
  await verifyProfileIdentity(bundle)
  await verifySafariExtension(bundle)
  await verifySidecarsLaunch(bundle)
  if (!notarized) {
    return
  }
  const accepted = ['accepted', 'source=Notarized Developer ID']
  await expectOutput('spctl', ['--assess', '--type', 'execute', '-v', bundle.app], accepted)
  const openContext = ['--type', 'open', '--context', 'context:primary-signature']
  await expectOutput('spctl', ['--assess', ...openContext, '-v', bundle.dmg], accepted)
  for (const path of [bundle.app, bundle.dmg]) {
    await expectOutput('xcrun', ['stapler', 'validate', path], ['The validate action worked!'])
  }
}

/** Copies the release assets and a zip of the dSYMs under the names they are published with. */
async function exportArtifacts(bundle: Bundle, artifactDir: string): Promise<void> {
  const prefix = `${bundle.assetName}_${bundle.version}_${bundle.arch}`
  mkdirSync(artifactDir, { recursive: true })
  copyFileSync(bundle.dmg, join(artifactDir, `${bundle.assetName}_${bundle.arch}.dmg`))
  copyFileSync(bundle.updaterArchive, join(artifactDir, `${prefix}.app.tar.gz`))
  copyFileSync(`${bundle.updaterArchive}.sig`, join(artifactDir, `${prefix}.app.tar.gz.sig`))
  await runWithTempDir(async (tempDir) => {
    // `<triple>/<binary>.dSYM`: a universal build has one dSYM per architecture.
    for (const { triple, path } of bundle.executables.flatMap((executable) => executable.dsyms)) {
      // Cargo writes `<binary>.dSYM` as a symlink into `deps/`, and `ditto`
      // copies a symlink as a symlink, so copy the bundle it points to.
      await exec('ditto', [realpathSync(path), join(tempDir, triple, basename(path))], INHERIT)
    }
    await exec('ditto', ['-c', '-k', tempDir, join(artifactDir, `${prefix}.dSYMs.zip`)], INHERIT)
  })
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      'artifact-dir': { type: 'string' },
      'no-notarize': { type: 'boolean', default: false },
      'no-sign': { type: 'boolean', default: false },
    },
  })
  assertSentryDsn()
  const artifactDir = values['artifact-dir']
  const bundle = resolveBundle(values.target ?? (await getHostTriple()))
  if (values['no-sign']) {
    if (artifactDir) {
      throw new Error('--no-sign makes no release assets, so it cannot be used with --artifact-dir')
    }
    await buildApp(bundle)
    log(`done (unsigned): ${bundle.app}`)
    return
  }
  const identity = process.env.APPLE_SIGNING_IDENTITY
  if (!identity) {
    throw new Error('APPLE_SIGNING_IDENTITY is not set')
  }
  const hasUpdaterKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY)
  if (artifactDir && !hasUpdaterKey) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is not set')
  }
  await assertProfileAuthorizesAppGroup(bundle)

  await runWithTempDir(async (tempDir) => {
    const notaryArgs = values['no-notarize'] ? null : resolveNotaryArgs(identity, tempDir)
    await buildApp(bundle)
    await runWithSigningKeychain(tempDir, async (keychain) => {
      const signer = { identity, keychain }
      await resignApp(bundle, signer, tempDir)
      if (notaryArgs) {
        await notarizeApp(bundle, notaryArgs, tempDir)
      }
      if (hasUpdaterKey) {
        await createUpdaterArchive(bundle)
      }
      await createDmg(bundle, signer, tempDir)
    })
    if (notaryArgs) {
      await notarize(bundle.dmg, notaryArgs)
      await exec('xcrun', ['stapler', 'staple', bundle.dmg], INHERIT)
    }
    await verify(bundle, notaryArgs !== null)
  })
  if (artifactDir) {
    await exportArtifacts(bundle, artifactDir)
  }
  log(`done: ${bundle.dmg}`)
}

await main()
