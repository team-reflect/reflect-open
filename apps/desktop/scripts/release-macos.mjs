// Build a signed, notarized, distribution-ready macOS bundle of Reflect.
//
// Usage:
//   pnpm release:macos                Signed + notarized build, then verify
//   pnpm release:macos setup          Store notarization credentials (one-time)
//   pnpm release:macos setup-updater  Generate the auto-update signing keypair (one-time)
//   pnpm release:macos verify         Re-run Gatekeeper checks on existing bundles
//   pnpm release:macos publish        Build, then upload the DMG + updater artifacts to a new GitHub release
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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const KEYCHAIN_SERVICE = 'reflect-notary'
const UPDATER_KEYCHAIN_SERVICE = 'reflect-updater'
const APP_SPECIFIC_PASSWORD_URL = 'https://account.apple.com'
const BETA_UPDATER_FEED_TAG = 'updater-beta'
const STABLE_UPDATER_ENDPOINT = 'https://github.com/team-reflect/reflect-open/releases/latest/download/latest.json'
const BETA_UPDATER_ENDPOINT = `https://github.com/team-reflect/reflect-open/releases/download/${BETA_UPDATER_FEED_TAG}/latest.json`

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

/** Run a command and return { status, output } with stdout+stderr combined. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
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
 * Returns { buildEnv, notarytoolArgs, source } or null when nothing is found.
 * buildEnv is merged into `tauri build`'s environment (Tauri notarizes the
 * .app itself); notarytoolArgs are used for the separate DMG submission.
 */
function resolveNotaryCredentials(identity) {
  const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH, APPLE_ID, APPLE_PASSWORD } = process.env

  if (APPLE_API_KEY && APPLE_API_ISSUER) {
    if (!APPLE_API_KEY_PATH) fail('APPLE_API_KEY is set but APPLE_API_KEY_PATH (path to the .p8 file) is not')
    return {
      buildEnv: {},
      notarytoolArgs: ['--key', APPLE_API_KEY_PATH, '--key-id', APPLE_API_KEY, '--issuer', APPLE_API_ISSUER],
      source: 'App Store Connect API key (environment)',
    }
  }

  if (APPLE_ID && APPLE_PASSWORD) {
    const teamId = resolveTeamId(identity)
    return {
      buildEnv: { APPLE_TEAM_ID: teamId },
      notarytoolArgs: ['--apple-id', APPLE_ID, '--password', APPLE_PASSWORD, '--team-id', teamId],
      source: `Apple ID ${APPLE_ID} (environment)`,
    }
  }

  const stored = readKeychainCredentials()
  if (!stored) return null
  const teamId = resolveTeamId(identity)
  return {
    buildEnv: { APPLE_ID: stored.account, APPLE_PASSWORD: stored.password, APPLE_TEAM_ID: teamId },
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

/**
 * The architecture segment of the host triple (e.g. "aarch64"). Taken from
 * rustc — the same source Tauri names bundle artifacts from — rather than
 * process.arch, which diverges when Node runs under Rosetta.
 */
function hostArch() {
  const arch = capture('rustc', ['-vV']).match(/^host: (\S+)/m)?.[1]?.split('-')[0]
  if (!arch) fail('could not determine the host triple from rustc -vV')
  return arch
}

/** Parse tauri.conf.json — the source of truth for the version and base bundle name. */
function readTauriConf() {
  return JSON.parse(readFileSync(join(appDir, 'src-tauri', 'tauri.conf.json'), 'utf8'))
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
  const base = readTauriConf()
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
function bundlePaths(flavor) {
  const conf = readFlavorConf(flavor)
  const metadata = JSON.parse(
    capture('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: repoRoot }),
  )
  const arch = hostArch()
  const bundleDir = join(metadata.target_directory, 'release', 'bundle')
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
 * Write the updater manifest next to the bundle and return its path. The
 * committed updater endpoint resolves `releases/latest/download/latest.json`,
 * so every published release must carry this file — it is how installed apps
 * discover the new version and verify its payload.
 */
function writeUpdaterManifest({ version, tag, flavor }) {
  const { updaterArchive, updaterSignature } = bundlePaths(flavor)
  const slug = capture('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()
  // GitHub rewrites spaces in uploaded asset names to dots, so a flavor whose
  // productName has a space ("Reflect Beta") is served under a dotted name. The
  // manifest URL must match the *uploaded* name or auto-update gets a 404.
  const assetName = basename(updaterArchive).replace(/ /g, '.')
  const manifest = {
    version,
    pub_date: new Date().toISOString(),
    platforms: {
      [`darwin-${hostArch()}`]: {
        signature: readFileSync(updaterSignature, 'utf8').trim(),
        url: `https://github.com/${slug}/releases/download/${tag}/${assetName}`,
      },
    },
  }
  const manifestPath = join(dirname(updaterArchive), 'latest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

function updaterEndpointForVersion(version) {
  return version.includes('-') ? BETA_UPDATER_ENDPOINT : STABLE_UPDATER_ENDPOINT
}

function ensureUpdaterEndpointMatchesVersion({ version }) {
  const endpoint = readTauriConf().plugins?.updater?.endpoints?.[0]
  const expected = updaterEndpointForVersion(version)
  if (endpoint !== expected) {
    fail(
      `tauri.conf.json updater endpoint does not match version ${version}.\n` +
        `  expected: ${expected}\n` +
        `  found:    ${endpoint ?? '(missing)'}\n` +
        '  Run `pnpm release:bump` for the target channel so installed apps poll the right feed.',
    )
  }
}

/**
 * Notarize and staple the DMG. Tauri notarizes the .app during the build but
 * not the DMG wrapped around it afterwards; without its own ticket the DMG is
 * rejected by `spctl --type open` and downloads get Gatekeeper friction.
 */
function notarizeDmg(dmg, credentials) {
  log(`submitting ${basename(dmg)} to Apple's notary service (typically 1-10 minutes)…`)
  const submit = spawnSync(
    'xcrun',
    ['notarytool', 'submit', dmg, ...credentials.notarytoolArgs, '--wait', '--output-format', 'json'],
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
    fail(`DMG notarization ${verdict.status ?? 'failed'}`)
  }
  log(`DMG notarization accepted (submission ${verdict.id}); stapling…`)
  execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
}

/** Assert one Gatekeeper/codesign check, failing loudly with its output. */
function expectCheck(description, command, args, expected) {
  const { output } = run(command, args)
  const passed = expected.every((needle) => output.includes(needle))
  if (!passed) fail(`${description} failed:\n${output.trim()}`)
  log(`${description}: ok`)
}

/** Verify the built bundles match the expected distribution state. */
function verify({ notarized, flavor }) {
  const { app, dmg } = bundlePaths(flavor)
  if (!existsSync(app)) fail(`${app} does not exist — run \`pnpm release:macos\` first`)
  if (!existsSync(dmg)) fail(`${dmg} does not exist — run \`pnpm release:macos\` first`)

  expectCheck('codesign verify (app)', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], [
    'valid on disk',
    'satisfies its Designated Requirement',
  ])

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

function printArtifacts(flavor) {
  const { app, dmg } = bundlePaths(flavor)
  const dmgSizeMb = (statSync(dmg).size / (1024 * 1024)).toFixed(1)
  log('distribution bundles:')
  console.log(`  ${app}`)
  console.log(`  ${dmg} (${dmgSizeMb} MB)`)
}

function build({ notarize, requireUpdater = false, flavor }) {
  const identity = findSigningIdentity()
  log(`signing identity: ${identity}`)

  const updater = resolveUpdaterSigningEnv()
  if (updater) {
    log(`updater signing key: ${updater.source}`)
  } else if (requireUpdater) {
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
    ...credentials?.buildEnv,
    ...updater?.env,
  }
  if (!notarize) {
    // Tauri notarizes the .app whenever these are present, so inherited shell
    // exports would silently override --no-notarize.
    for (const name of [
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
      'APPLE_API_KEY',
      'APPLE_API_ISSUER',
      'APPLE_API_KEY_PATH',
    ]) {
      delete buildEnv[name]
    }
  }
  // createUpdaterArtifacts stays out of the committed config: with it on,
  // `tauri build` hard-fails without the private key, which would break plain
  // contributor builds. The release script turns it on only when it can sign.
  const buildArgs = ['tauri', 'build']
  const overlay = FLAVOR_OVERLAYS[flavor]
  if (overlay) buildArgs.push('--config', overlay)
  if (updater) {
    buildArgs.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: true } }))
  }
  const result = spawnSync('pnpm', buildArgs, { cwd: appDir, stdio: 'inherit', env: buildEnv })
  if (result.status !== 0) fail('tauri build failed')

  if (updater) {
    const { updaterArchive, updaterSignature } = bundlePaths(flavor)
    if (!existsSync(updaterArchive) || !existsSync(updaterSignature)) {
      fail(`updater artifacts missing after build — expected ${updaterArchive} and its .sig`)
    }
  }

  if (notarize) notarizeDmg(bundlePaths(flavor).dmg, credentials)
  verify({ notarized: notarize, flavor })
  printArtifacts(flavor)
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

/** Assert no release exists for the tag yet, distinguishing "absent" from gh errors. */
function ensureReleaseIsNew(tag) {
  const existing = run('gh', ['release', 'view', tag])
  if (existing.status === 0) {
    fail(`release ${tag} already exists — bump "version" in apps/desktop/src-tauri/tauri.conf.json first`)
  }
  if (!/release not found/i.test(existing.output)) {
    fail(`could not check GitHub for an existing ${tag} release:\n${existing.output.trim()}`)
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
        '  delete the remote tag or bump "version" in apps/desktop/src-tauri/tauri.conf.json.',
    )
  }
}

/** Build the GitHub CLI args that publish the release and upload artifacts. */
export function createReleaseArgs({ assets, commit, draft, prerelease, productName, tag, version }) {
  const releaseArgs = [
    'release',
    'create',
    tag,
    ...assets,
    '--title',
    `${productName} ${version}`,
    '--target',
    commit,
    '--generate-notes',
  ]
  if (prerelease) {
    releaseArgs.push('--prerelease', '--latest=false')
  } else {
    releaseArgs.push('--latest')
  }
  if (draft) releaseArgs.push('--draft')
  return releaseArgs
}

/** Build the `gh release create` arguments for the moving beta updater feed. */
export function createBetaFeedReleaseArgs({ commit, manifestPath }) {
  return [
    'release',
    'create',
    BETA_UPDATER_FEED_TAG,
    manifestPath,
    '--title',
    'Reflect beta updater feed',
    '--target',
    commit,
    '--prerelease',
    '--latest=false',
    '--notes',
    'Moving updater feed for beta builds. Do not install this release directly.',
  ]
}

/** Build the `gh release upload` arguments that replace the beta feed manifest. */
export function uploadBetaFeedArgs({ manifestPath }) {
  return ['release', 'upload', BETA_UPDATER_FEED_TAG, manifestPath, '--clobber']
}

function updateBetaFeed({ commit, manifestPath }) {
  const existing = run('gh', ['release', 'view', BETA_UPDATER_FEED_TAG])
  if (existing.status === 0) {
    log(`updating ${BETA_UPDATER_FEED_TAG} updater feed…`)
    const upload = spawnSync('gh', uploadBetaFeedArgs({ manifestPath }), {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'inherit'],
    })
    if (upload.status !== 0) {
      fail(`updating the beta updater feed failed${upload.stdout ? `\n${upload.stdout.trim()}` : ''}`)
    }
    return
  }
  if (!/release not found/i.test(existing.output)) {
    fail(`could not check GitHub for the ${BETA_UPDATER_FEED_TAG} updater feed:\n${existing.output.trim()}`)
  }
  log(`creating ${BETA_UPDATER_FEED_TAG} updater feed…`)
  const create = spawnSync('gh', createBetaFeedReleaseArgs({ commit, manifestPath }), {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  if (create.status !== 0) {
    fail(`creating the beta updater feed failed${create.stdout ? `\n${create.stdout.trim()}` : ''}`)
  }
}

/**
 * Build a signed + notarized DMG and upload it to a new GitHub release tagged
 * v<version> (from tauri.conf.json). A version with a prerelease segment
 * (e.g. `0.2.0-beta.1`, the `next`-branch convention) publishes as a GitHub
 * pre-release. All preflight checks run before the build so a doomed publish
 * fails in seconds, not after notarization.
 */
function publish({ draft, flavorFlag }) {
  ensureGhReady()
  const commit = ensurePublishableCommit()
  const { version } = readTauriConf()
  const flavor = resolveFlavor({ flavorFlag, version, forPublish: true })
  const { productName } = readFlavorConf(flavor)
  const tag = `v${version}`
  ensureUpdaterEndpointMatchesVersion({ version })
  ensureReleaseIsNew(tag)
  ensureTagMatchesCommit(tag, commit)

  build({ notarize: true, requireUpdater: true, flavor })

  const { dmg, updaterArchive, updaterSignature } = bundlePaths(flavor)
  const manifestPath = writeUpdaterManifest({ version, tag, flavor })
  // Pre-releases are invisible to `releases/latest` — the committed updater
  // endpoint — so installed stable apps never see a beta.
  const prerelease = version.includes('-')
  log(`creating GitHub ${prerelease ? 'pre-release' : 'release'} ${tag} from commit ${commit.slice(0, 7)}…`)
  const releaseArgs = createReleaseArgs({
    assets: [dmg, updaterArchive, updaterSignature, manifestPath],
    commit,
    draft,
    prerelease,
    productName,
    tag,
    version,
  })
  const result = spawnSync('gh', releaseArgs, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] })
  if (result.status !== 0) fail(`creating the GitHub release failed${result.stdout ? `\n${result.stdout.trim()}` : ''}`)
  log(`${draft ? 'draft release created' : 'release published'}: ${result.stdout.trim()}`)
  if (prerelease && !draft) {
    updateBetaFeed({ commit, manifestPath })
  } else if (prerelease) {
    log(`draft pre-release created — ${BETA_UPDATER_FEED_TAG} feed not updated`)
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
  setup          Store the notarization Apple ID + app-specific password in the keychain
  setup-updater  Generate the auto-update signing keypair (keychain + pubkey to commit)
  verify         Re-run signing/Gatekeeper checks on already-built bundles
  publish        Build, then upload the DMG + updater artifacts to a new GitHub release

Flags:
  --no-notarize   Skip notarization (signed-only build/verify)
  --draft         Create the GitHub release as a draft (publish only)
  --flavor=<name> Build a flavor: stable | beta | dev (default: derived from the
                  version — prerelease → beta, else stable; publish ignores this
                  and always uses the version's channel)
  --help          Show this help

Docs: docs/macos-distribution.md`

async function main() {
  const argv = process.argv.slice(2)
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const commands = argv.filter((arg) => !arg.startsWith('--'))
  const flavorFlag = flags.find((flag) => flag.startsWith('--flavor='))?.slice('--flavor='.length)
  const unknownFlag = flags.find(
    (flag) => !['--no-notarize', '--draft', '--help'].includes(flag) && !flag.startsWith('--flavor='),
  )
  if (unknownFlag) fail(`unknown flag "${unknownFlag}"\n\n${USAGE}`)
  if (flavorFlag && !Object.keys(FLAVOR_OVERLAYS).includes(flavorFlag)) {
    fail(`unknown --flavor "${flavorFlag}" — one of: ${Object.keys(FLAVOR_OVERLAYS).join(', ')}`)
  }
  if (flags.includes('--help')) {
    console.log(USAGE)
    return
  }
  if (process.platform !== 'darwin') fail('this command only runs on macOS')

  const command = commands[0] ?? 'build'
  const notarize = !flags.includes('--no-notarize')
  if (command === 'publish' && !notarize) fail('publish always notarizes — drop --no-notarize')
  if (command !== 'publish' && flags.includes('--draft')) fail('--draft only applies to publish')
  const { version } = readTauriConf()
  switch (command) {
    case 'build':
      return build({ notarize, flavor: resolveFlavor({ flavorFlag, version, forPublish: false }) })
    case 'setup':
      return setup()
    case 'setup-updater':
      return setupUpdater()
    case 'verify': {
      const flavor = resolveFlavor({ flavorFlag, version, forPublish: false })
      verify({ notarized: notarize, flavor })
      return printArtifacts(flavor)
    }
    case 'publish':
      return publish({ draft: flags.includes('--draft'), flavorFlag })
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
