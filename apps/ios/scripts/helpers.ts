import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'tinyexec'
import { runWithTempDir } from '../../../scripts/release.ts'

export const IOS_DIR = join(import.meta.dirname, '..')
export const BUILD_DIR = join(IOS_DIR, 'build')
export const ARCHIVE_PATH = join(BUILD_DIR, 'Reflect.xcarchive')
export const IPA_PATH = join(BUILD_DIR, 'Reflect.ipa')

/** The identifiers that tell the iOS flavors apart. */
export interface IosIdentity {
  bundleIdentifier: string
  appGroup: string
}

async function readInfoValue(app: string, key: string): Promise<string> {
  const args = ['-extract', key, 'raw', '-o', '-', join(app, 'Info.plist')]
  return (await exec('plutil', args, { throwOnError: true })).stdout.trim()
}

/**
 * Each app extension must sit under the app's bundle id and carry the
 * flavor's App Group. Export re-signs the extensions; without the App Group
 * entitlement the build installs and launches, but every share fails.
 */
async function assertAppexes(app: string, flavor: IosIdentity): Promise<void> {
  const plugInsDir = join(app, 'PlugIns')
  const appexes = existsSync(plugInsDir) ? readdirSync(plugInsDir) : []
  if (appexes.length === 0) {
    throw new Error('the IPA contains no app extension')
  }
  for (const appex of appexes) {
    const identifier = await readInfoValue(join(plugInsDir, appex), 'CFBundleIdentifier')
    if (!identifier.startsWith(`${flavor.bundleIdentifier}.`)) {
      throw new Error(
        `${appex} bundle identifier is ${identifier}, expected a child of ${flavor.bundleIdentifier}`,
      )
    }
    const display = ['-d', '--entitlements', ':-', join(plugInsDir, appex)]
    const entitlements = (await exec('codesign', display, { throwOnError: true })).stdout
    if (!entitlements.includes(`<string>${flavor.appGroup}</string>`)) {
      throw new Error(`${appex} is signed without the ${flavor.appGroup} App Group entitlement`)
    }
  }
}

/** Checks the bundle id, the App Group and the app extensions of the app in an IPA. */
export async function assertIpa(ipaPath: string, flavor: IosIdentity): Promise<void> {
  await runWithTempDir(async (tempDir) => {
    await exec('unzip', ['-q', ipaPath, 'Payload/*', '-d', tempDir], { throwOnError: true })
    const payloadDir = join(tempDir, 'Payload')
    const appName = readdirSync(payloadDir).find((name) => name.endsWith('.app'))
    if (!appName) {
      throw new Error('the IPA contains no app')
    }
    const app = join(payloadDir, appName)

    const identifier = await readInfoValue(app, 'CFBundleIdentifier')
    if (identifier !== flavor.bundleIdentifier) {
      throw new Error(`IPA bundle identifier is ${identifier}, expected ${flavor.bundleIdentifier}`)
    }
    if ((await readInfoValue(app, 'ReflectAppGroup')) !== flavor.appGroup) {
      throw new Error(`ReflectAppGroup must be ${flavor.appGroup}`)
    }
    if ((await readInfoValue(app, 'ITSAppUsesNonExemptEncryption')) !== 'false') {
      throw new Error('ITSAppUsesNonExemptEncryption must be false')
    }
    await assertAppexes(app, flavor)
  })
}
