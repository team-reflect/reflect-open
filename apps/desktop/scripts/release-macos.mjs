// Build a signed, notarized, distribution-ready macOS bundle of Reflect.
//
// Usage:
//   pnpm release:macos              Signed + notarized build, then verify
//   pnpm release:macos setup        Store notarization credentials (one-time)
//   pnpm release:macos verify       Re-run Gatekeeper checks on existing bundles
//   pnpm release:macos --no-notarize  Signed-only build (won't pass Gatekeeper elsewhere)
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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const KEYCHAIN_SERVICE = 'reflect-notary'
const APP_SPECIFIC_PASSWORD_URL = 'https://account.apple.com'

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
 * The architecture segment of the host triple (e.g. "aarch64"). Taken from
 * rustc — the same source Tauri names bundle artifacts from — rather than
 * process.arch, which diverges when Node runs under Rosetta.
 */
function hostArch() {
  const arch = capture('rustc', ['-vV']).match(/^host: (\S+)/m)?.[1]?.split('-')[0]
  if (!arch) fail('could not determine the host triple from rustc -vV')
  return arch
}

/** Derive bundle output paths from tauri.conf.json and cargo's target dir. */
function bundlePaths() {
  const conf = JSON.parse(readFileSync(join(appDir, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const metadata = JSON.parse(
    capture('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: repoRoot }),
  )
  const arch = hostArch()
  const bundleDir = join(metadata.target_directory, 'release', 'bundle')
  return {
    app: join(bundleDir, 'macos', `${conf.productName}.app`),
    dmg: join(bundleDir, 'dmg', `${conf.productName}_${conf.version}_${arch}.dmg`),
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
function verify({ notarized }) {
  const { app, dmg } = bundlePaths()
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

function printArtifacts() {
  const { app, dmg } = bundlePaths()
  const dmgSizeMb = (statSync(dmg).size / (1024 * 1024)).toFixed(1)
  log('distribution bundles:')
  console.log(`  ${app}`)
  console.log(`  ${dmg} (${dmgSizeMb} MB)`)
}

function build({ notarize }) {
  const identity = findSigningIdentity()
  log(`signing identity: ${identity}`)

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

  const buildEnv = { ...process.env, APPLE_SIGNING_IDENTITY: identity, ...credentials?.buildEnv }
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
  const result = spawnSync('pnpm', ['tauri', 'build'], { cwd: appDir, stdio: 'inherit', env: buildEnv })
  if (result.status !== 0) fail('tauri build failed')

  if (notarize) notarizeDmg(bundlePaths().dmg, credentials)
  verify({ notarized: notarize })
  printArtifacts()
  log(notarize ? 'done — ready to distribute' : 'done — signed but NOT notarized')
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

const USAGE = `Usage: pnpm release:macos [command] [flags]

Commands:
  build     Signed + notarized release build, then verify (default)
  setup     Store the notarization Apple ID + app-specific password in the keychain
  verify    Re-run signing/Gatekeeper checks on already-built bundles

Flags:
  --no-notarize   Skip notarization (signed-only build/verify)
  --help          Show this help

Docs: docs/macos-distribution.md`

async function main() {
  const argv = process.argv.slice(2)
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const commands = argv.filter((arg) => !arg.startsWith('--'))
  const unknownFlag = flags.find((flag) => !['--no-notarize', '--help'].includes(flag))
  if (unknownFlag) fail(`unknown flag "${unknownFlag}"\n\n${USAGE}`)
  if (flags.includes('--help')) {
    console.log(USAGE)
    return
  }
  if (process.platform !== 'darwin') fail('this command only runs on macOS')

  const command = commands[0] ?? 'build'
  const notarize = !flags.includes('--no-notarize')
  switch (command) {
    case 'build':
      return build({ notarize })
    case 'setup':
      return setup()
    case 'verify':
      verify({ notarized: notarize })
      return printArtifacts()
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`)
  }
}

await main()
