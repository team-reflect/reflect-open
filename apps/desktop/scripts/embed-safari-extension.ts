// Builds the Safari app extension and embeds it in a built Reflect.app, so
// Safari can deliver the capture extension's messages to it. Tauri's bundler
// cannot build app extensions; `build-macos.ts` does not run this yet.
//
//   pnpm --filter @reflect/desktop safari:embed --app=<path> [flags]
//
// Needs Xcode and XcodeGen (`brew install xcodegen`).
//
//   --app=<path>        The built app, for example from `pnpm tauri:build:dev`
//   --identity=<name>   Codesign identity. Default: $APPLE_SIGNING_IDENTITY,
//                       else ad-hoc. Use the identity the app was signed
//                       with: its restricted entitlements stay tied to it.
//                       An ad-hoc signature loads in Safari (with Develop >
//                       Allow Unsigned Extensions) but cannot use the App
//                       Group, which only the owning team's signature can.
//   --team=<id>         The identity's Team ID, which prefixes the App Group.
//                       Default: Reflect's team.
//
// The App Group is `<team>.<app bundle id>`, so each flavor spools into its
// own container. A team-prefixed group needs no provisioning-profile grant.
// The relay in `src-tauri/src/capture.rs` reads it back from the app
// extension's Info.plist.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'
import { z } from 'zod'
import { APP_DIR, INHERIT, log, runWithTempDir, TAURI_SRC_DIR } from './helpers.ts'

const REFLECT_TEAM_ID = '789ULN5MZB'
/** Must match `SAFARI_APPEX` in `src-tauri/src/capture.rs`. */
const APPEX = 'SafariExtension.appex'
const PROJECT_DIR = join(TAURI_SRC_DIR, 'safari-extension')
const WEB_EXTENSION_DIR = join(APP_DIR, '..', 'extension', '.output', 'safari-mv3')
const APP_GROUPS_KEY = 'com.apple.security.application-groups'
const FLAVOR_OVERLAYS = ['tauri.dev.conf.json', 'tauri.beta.conf.json']

const EntitlementsSchema = z.record(z.string(), z.unknown())
type Entitlements = z.infer<typeof EntitlementsSchema>

const TauriConfigSchema = z.object({
  identifier: z.string().optional(),
  bundle: z
    .object({ macOS: z.object({ entitlements: z.string().optional() }).optional() })
    .optional(),
})
type TauriConfig = z.infer<typeof TauriConfigSchema>

async function readInfo(app: string, key: string): Promise<string> {
  const plist = join(app, 'Contents', 'Info.plist')
  const { stdout } = await exec('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
    throwOnError: true,
  })
  return stdout.trim()
}

async function readPlist(path: string): Promise<Entitlements> {
  const json = await exec('plutil', ['-convert', 'json', '-o', '-', path], { throwOnError: true })
  return EntitlementsSchema.parse(JSON.parse(json.stdout))
}

/**
 * The entitlements `path` is signed with; empty when it is unsigned. Any
 * other `codesign` failure throws, so a failed read never re-signs the app
 * without its entitlements.
 */
async function readEntitlements(path: string, tempDir: string): Promise<Entitlements> {
  const { exitCode, stdout, stderr } = await exec('codesign', [
    '-d',
    '--entitlements',
    '-',
    '--xml',
    path,
  ])
  if (exitCode !== 0) {
    if (/not signed at all/.test(stderr)) {
      return {}
    }
    throw new Error(`Cannot read the entitlements of ${path}: ${stderr.trim()}`)
  }
  if (stdout.trim() === '') {
    return {}
  }
  const plist = join(tempDir, 'signed.entitlements')
  writeFileSync(plist, stdout)
  return await readPlist(plist)
}

function readTauriConfig(name: string): TauriConfig {
  return TauriConfigSchema.parse(JSON.parse(readFileSync(join(TAURI_SRC_DIR, name), 'utf8')))
}

/**
 * The entitlements file Tauri configures for the flavor with `identifier`:
 * its overlay's, else the macOS config's. A `tauri build` without a signing
 * identity signs ad-hoc with none, so the app's own signature may lack them.
 */
function configuredEntitlementsPath(identifier: string): string {
  const overlay = FLAVOR_OVERLAYS.map(readTauriConfig).find(
    (config) => config.identifier === identifier,
  )
  const file =
    overlay?.bundle?.macOS?.entitlements ??
    readTauriConfig('tauri.macos.conf.json').bundle?.macOS?.entitlements
  if (file === undefined) {
    throw new Error('tauri.macos.conf.json configures no entitlements file')
  }
  return join(TAURI_SRC_DIR, file)
}

/** Signs `path` with the hardened runtime and `entitlements`. */
async function sign(
  path: string,
  identity: string,
  entitlements: Entitlements,
  tempDir: string,
): Promise<void> {
  const plist = join(tempDir, 'sign.entitlements')
  writeFileSync(plist, JSON.stringify(entitlements))
  await exec('plutil', ['-convert', 'xml1', plist], { throwOnError: true })
  // A secure timestamp needs a real identity; ad-hoc signatures cannot carry one.
  const timestamp = identity === '-' ? [] : ['--timestamp']
  await exec(
    'codesign',
    [
      '--force',
      '--sign',
      identity,
      ...timestamp,
      '--options',
      'runtime',
      '--entitlements',
      plist,
      path,
    ],
    INHERIT,
  )
}

async function buildAppex(
  app: string,
  identifier: string,
  group: string,
  tempDir: string,
): Promise<string> {
  await exec('xcodegen', ['generate', '--spec', join(PROJECT_DIR, 'project.yml')], INHERIT)
  await exec(
    'xcodebuild',
    [
      '-project',
      join(PROJECT_DIR, 'ReflectSafari.xcodeproj'),
      '-target',
      'SafariExtension',
      '-configuration',
      'Release',
      `SYMROOT=${tempDir}`,
      `REFLECT_APP_IDENTIFIER=${identifier}`,
      `REFLECT_APP_GROUP=${group}`,
      `MARKETING_VERSION=${await readInfo(app, 'CFBundleShortVersionString')}`,
      `CURRENT_PROJECT_VERSION=${await readInfo(app, 'CFBundleVersion')}`,
      'build',
    ],
    INHERIT,
  )
  const appex = join(tempDir, 'Release', APPEX)
  // Safari loads the web extension from the app extension's Resources.
  cpSync(WEB_EXTENSION_DIR, join(appex, 'Contents', 'Resources'), { recursive: true })
  return appex
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      identity: { type: 'string' },
      team: { type: 'string', default: REFLECT_TEAM_ID },
    },
  })
  if (values.app === undefined) {
    throw new Error('Pass --app=<path to the built Reflect.app>')
  }
  const app = resolve(values.app)
  const identity = values.identity ?? process.env.APPLE_SIGNING_IDENTITY ?? '-'
  const identifier = await readInfo(app, 'CFBundleIdentifier')
  const group = `${values.team}.${identifier}`
  // Not part of Xcode or its command-line tools; fail before any build step.
  if ((await exec('which', ['xcodegen'])).exitCode !== 0) {
    throw new Error('safari:embed needs XcodeGen: brew install xcodegen')
  }

  log('Building the Safari web extension')
  await exec('pnpm', ['--filter', '@reflect/extension', 'build:safari'], INHERIT)

  await runWithTempDir(async (tempDir) => {
    log('Building the Safari app extension')
    const appex = await buildAppex(app, identifier, group, tempDir)

    log(`Signing with ${identity === '-' ? 'an ad-hoc signature' : identity}`)
    // Nested code first: re-signing the app seals the app extension's signature.
    await sign(
      appex,
      identity,
      { 'com.apple.security.app-sandbox': true, [APP_GROUPS_KEY]: [group] },
      tempDir,
    )
    const plugIns = join(app, 'Contents', 'PlugIns')
    rmSync(join(plugIns, APPEX), { recursive: true, force: true })
    mkdirSync(plugIns, { recursive: true })
    await exec('ditto', [appex, join(plugIns, APPEX)], INHERIT)
    // The app keeps its flavor's entitlements plus what it was signed with
    // (a release build's profile identity), and joins the group, so it can
    // read the container without a macOS access prompt.
    const entitlements = {
      ...(await readPlist(configuredEntitlementsPath(identifier))),
      ...(await readEntitlements(app, tempDir)),
      [APP_GROUPS_KEY]: [group],
    }
    await sign(app, identity, entitlements, tempDir)
  })
  await exec('codesign', ['--verify', '--deep', '--strict', app], INHERIT)
  log(`Embedded ${APPEX} in ${app} (App Group ${group})`)
}

await main()
