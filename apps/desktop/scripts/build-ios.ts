// Builds the iOS app and checks the IPA and its dSYM. `pnpm upload:testflight`
// uploads the result. See docs/ios-testflight.md.
//
//   pnpm build:ios --build-number=<digits>
//
//   --build-number=<digits>   Required
//   --no-sign                 Unsigned archive without credentials. It cannot be installed

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'
import {
  assertDsyms,
  assertSentryDsn,
  IOS_ARCHIVE_PATH,
  IOS_IPA_PATH,
  log,
  resolveApiKey,
  runTauri,
  runWithTempDir,
} from './helpers.ts'

const BUNDLE_IDENTIFIER = 'app.reflect.ios'
const APP_GROUP = 'group.app.reflect'
const APP_BINARY_PATH = join(IOS_ARCHIVE_PATH, 'Products', 'Applications', 'Reflect.app', 'Reflect')
const DSYM_PATH = join(IOS_ARCHIVE_PATH, 'dSYMs', 'Reflect.app.dSYM')

async function readInfoValue(app: string, key: string): Promise<string> {
  const args = ['-extract', key, 'raw', '-o', '-', join(app, 'Info.plist')]
  return (await exec('plutil', args, { throwOnError: true })).stdout.trim()
}

/**
 * Export re-signs the share extension. Without its App Group entitlement the
 * build installs and launches, but every share fails.
 */
async function assertAppexEntitlements(app: string): Promise<void> {
  const plugInsDir = join(app, 'PlugIns')
  const appexes = existsSync(plugInsDir) ? readdirSync(plugInsDir) : []
  if (appexes.length === 0) {
    throw new Error('the IPA contains no app extension')
  }
  for (const appex of appexes) {
    const display = ['-d', '--entitlements', ':-', join(plugInsDir, appex)]
    const entitlements = (await exec('codesign', display, { throwOnError: true })).stdout
    if (!entitlements.includes(APP_GROUP)) {
      throw new Error(`${appex} is signed without the ${APP_GROUP} App Group entitlement`)
    }
  }
}

async function assertIpa(): Promise<void> {
  await runWithTempDir(async (tempDir) => {
    await exec('unzip', ['-q', IOS_IPA_PATH, 'Payload/*', '-d', tempDir], { throwOnError: true })
    const payloadDir = join(tempDir, 'Payload')
    const appName = readdirSync(payloadDir).find((name) => name.endsWith('.app'))
    if (!appName) {
      throw new Error('the IPA contains no app')
    }
    const app = join(payloadDir, appName)

    const identifier = await readInfoValue(app, 'CFBundleIdentifier')
    if (identifier !== BUNDLE_IDENTIFIER) {
      throw new Error(`IPA bundle identifier is ${identifier}, expected ${BUNDLE_IDENTIFIER}`)
    }
    if ((await readInfoValue(app, 'ITSAppUsesNonExemptEncryption')) !== 'false') {
      throw new Error('ITSAppUsesNonExemptEncryption must be false')
    }
    await assertAppexEntitlements(app)
  })
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'build-number': { type: 'string', default: '' },
      'no-sign': { type: 'boolean', default: false },
    },
  })
  const buildNumber = values['build-number']
  const noSign = values['no-sign']
  if (!/^\d+$/.test(buildNumber)) {
    throw new Error(`invalid build number "${buildNumber}"`)
  }
  assertSentryDsn()

  const config = JSON.stringify({ bundle: { iOS: { bundleVersion: buildNumber } } })
  await runWithTempDir(async (tempDir) => {
    const args = ['ios', 'build', '--ci', '--config', config]
    // Without line tables the dSYM cannot symbolicate Rust frames.
    const env: NodeJS.ProcessEnv = { CARGO_PROFILE_RELEASE_DEBUG: 'line-tables-only' }
    if (noSign) {
      args.push('--no-sign')
    } else {
      const apiKey = resolveApiKey(tempDir)
      if (!apiKey) {
        throw new Error('the App Store Connect API key is not set')
      }
      args.push('--export-method', 'app-store-connect')
      env.APPLE_API_KEY_PATH = apiKey.keyPath
    }
    await runTauri(args, env)
  })
  if (!noSign) {
    await assertIpa()
  }
  await assertDsyms(APP_BINARY_PATH, [DSYM_PATH], '_reflect_start_native_diagnostics')
  log(`built ${noSign ? IOS_ARCHIVE_PATH : IOS_IPA_PATH} (build ${buildNumber})`)
}

await main()
