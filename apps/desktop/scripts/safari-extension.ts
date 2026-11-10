// Builds the Safari app extension, which Tauri's bundler cannot, and puts it in
// a built app. `build-macos.ts` ships it in every release, and
// `embed-safari-extension.ts` adds it to a local build. See docs/distribution.md.
//
// The App Group is `<team>.<app bundle id>`, so each flavor spools into its own
// container. The relay in `src-tauri/src/capture.rs` reads it back from the app
// extension's Info.plist.

import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { exec } from 'tinyexec'
import { APP_DIR, INHERIT, log, runWithTempDir, TAURI_SRC_DIR } from './helpers.ts'

export const REFLECT_TEAM_ID = '789ULN5MZB'
export const APP_GROUPS_KEY = 'com.apple.security.application-groups'
/** Must match `SAFARI_APPEX` in `src-tauri/src/capture.rs`. */
const APPEX = 'SafariExtension.appex'
const PROJECT_DIR = join(TAURI_SRC_DIR, 'safari-extension')
const WEB_EXTENSION_DIR = join(APP_DIR, '..', 'extension', '.output', 'safari-mv3')

/** A value from the Info.plist of a built app. */
export async function readAppInfo(app: string, key: string): Promise<string> {
  const plist = join(app, 'Contents', 'Info.plist')
  const { stdout } = await exec('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
    throwOnError: true,
  })
  return stdout.trim()
}

/** Where the app extension sits inside `app`. */
export function safariAppexPath(app: string): string {
  return join(app, 'Contents', 'PlugIns', APPEX)
}

/** The App Group the app and its Safari extension share. */
export function safariAppGroup(teamId: string, identifier: string): string {
  return `${teamId}.${identifier}`
}

/** What the app extension is signed with. Safari requires the sandbox. */
export function safariAppexEntitlements(group: string): Record<string, unknown> {
  return { 'com.apple.security.app-sandbox': true, [APP_GROUPS_KEY]: [group] }
}

/**
 * Builds the web extension and the app extension, and copies the result into
 * `app` unsigned. The caller signs it, then re-signs the app around it, so the
 * app's signature seals the app extension's.
 */
export async function embedSafariExtension(app: string, group: string): Promise<void> {
  log('Building the Safari extension')
  await exec('pnpm', ['--filter', '@reflect/extension', 'build:safari'], INHERIT)
  await runWithTempDir(async (tempDir) => {
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
        `REFLECT_APP_IDENTIFIER=${await readAppInfo(app, 'CFBundleIdentifier')}`,
        `REFLECT_APP_GROUP=${group}`,
        `MARKETING_VERSION=${await readAppInfo(app, 'CFBundleShortVersionString')}`,
        `CURRENT_PROJECT_VERSION=${await readAppInfo(app, 'CFBundleVersion')}`,
        'build',
      ],
      INHERIT,
    )
    const built = join(tempDir, 'Release', APPEX)
    // Safari loads the web extension from the app extension's Resources.
    cpSync(WEB_EXTENSION_DIR, join(built, 'Contents', 'Resources'), { recursive: true })
    const appex = safariAppexPath(app)
    rmSync(appex, { recursive: true, force: true })
    mkdirSync(dirname(appex), { recursive: true })
    await exec('ditto', [built, appex], INHERIT)
  })
}
