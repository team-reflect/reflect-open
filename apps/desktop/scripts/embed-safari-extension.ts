// Adds the Safari extension to a local build, for testing it without the
// release credentials. Release builds get it from `build-macos.ts`.
//
//   pnpm --filter @reflect/desktop safari:embed --app=<path> [flags]
//
// Needs Xcode.
//
//   --app=<path>        The built app, for example from `pnpm tauri:build:dev`
//   --identity=<name>   Codesign identity. Default: $APPLE_SIGNING_IDENTITY.
//                       Use the identity the app was signed with: its
//                       restricted entitlements stay tied to it. `-` signs
//                       ad-hoc, for UI work only: it loads in Safari (with
//                       Develop > Allow Unsigned Extensions) but cannot save,
//                       because only the owning team's signature can use the
//                       App Group.
//   --team=<id>         The identity's Team ID, which prefixes the App Group.
//                       Default: Reflect's team.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'
import { z } from 'zod'
import { INHERIT, log, runWithTempDir, TAURI_SRC_DIR } from './helpers.ts'
import {
  APP_GROUPS_KEY,
  embedSafariExtension,
  readAppInfo,
  REFLECT_TEAM_ID,
  safariAppexEntitlements,
  safariAppexPath,
  safariAppGroup,
} from './safari-extension.ts'

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

/** The plist at `path` (XML or binary), parsed through JSON. */
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

/** The Tauri config file `name` in `src-tauri/`, alone: no base or platform merge. */
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
  const identity = values.identity ?? process.env.APPLE_SIGNING_IDENTITY
  if (!identity) {
    throw new Error('Pass --identity=<name> or set APPLE_SIGNING_IDENTITY (`-` signs ad-hoc)')
  }
  const identifier = await readAppInfo(app, 'CFBundleIdentifier')
  const group = safariAppGroup(values.team, identifier)

  await embedSafariExtension(app, group)
  await runWithTempDir(async (tempDir) => {
    log(`Signing with ${identity === '-' ? 'an ad-hoc signature' : identity}`)
    await sign(safariAppexPath(app), identity, safariAppexEntitlements(group), tempDir)
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
  log(`Embedded the Safari extension in ${app} (App Group ${group})`)
}

await main()
