// Builds the iOS app and checks the IPA and its dSYM. `pnpm upload:testflight`
// uploads the result. See docs/distribution.md.
//
//   pnpm build:ios --build-number=<digits> --flavor=beta|stable
//
//   --build-number=<digits>   Required
//   --flavor=beta|stable      Required
//   --no-sign                 Unsigned archive without credentials. It cannot be installed

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import packageJson from '../package.json' with { type: 'json' }
import {
  assertDsyms,
  assertIpa,
  assertSentryDsn,
  type IosIdentity,
  IOS_ARCHIVE_PATH,
  IOS_IPA_PATH,
  log,
  resolveApiKey,
  runTauri,
  runWithTempDir,
  TAURI_SRC_DIR,
} from './helpers.ts'

interface IosFlavor extends IosIdentity {
  /** The app's entitlements file, relative to `gen/apple`. */
  appEntitlements: string
  /** `--config` arguments for `tauri ios build`, which writes `identifier` into the app target. */
  configArgs: string[]
  /**
   * Overrides for the `release` configuration defaults in `gen/apple/project.yml`.
   * `tauri ios build` passes only `TAURI*` variables (and a few others) on to
   * xcodebuild, hence the prefix.
   */
  xcodeEnv: Record<string, string>
}

const FLAVORS = {
  stable: {
    bundleIdentifier: 'app.reflect.ios',
    appGroup: 'group.app.reflect',
    appEntitlements: 'reflect-open_iOS/reflect-open_iOS.entitlements',
    configArgs: [],
    xcodeEnv: {},
  },
  beta: {
    bundleIdentifier: 'app.reflect.ios.beta',
    appGroup: 'group.app.reflect.beta',
    appEntitlements: 'reflect-open_iOS/reflect-open_iOS.beta.entitlements',
    configArgs: ['--config', join('src-tauri', 'tauri.ios.beta.conf.json')],
    xcodeEnv: {
      TAURI_REFLECT_IOS_DISPLAY_NAME: 'Reflect Beta',
      TAURI_REFLECT_IOS_APP_ICON: 'AppIcon-Beta',
      TAURI_REFLECT_IOS_APP_GROUP: 'group.app.reflect.beta',
      TAURI_REFLECT_IOS_APP_ENTITLEMENTS: 'reflect-open_iOS/reflect-open_iOS.beta.entitlements',
      TAURI_REFLECT_IOS_SHARE_BUNDLE_ID: 'app.reflect.ios.beta.share',
      TAURI_REFLECT_IOS_SHARE_ENTITLEMENTS: 'ShareExtension/ShareExtension.beta.entitlements',
      TAURI_REFLECT_IOS_WIDGETS_BUNDLE_ID: 'app.reflect.ios.beta.widgets',
      TAURI_REFLECT_IOS_WIDGETS_ENTITLEMENTS: 'RecordingWidget/RecordingWidget.beta.entitlements',
    },
  },
} satisfies Record<string, IosFlavor>

type FlavorName = keyof typeof FLAVORS

function resolveFlavorName(option: string): FlavorName {
  if (option === 'beta' || option === 'stable') {
    return option
  }
  throw new Error(`invalid flavor "${option}": expected beta or stable`)
}
const APPLE_DIR = join(TAURI_SRC_DIR, 'gen', 'apple')
/** Tauri derives this path from the scheme name. */
const TAURI_APP_ENTITLEMENTS_PATH = join(
  APPLE_DIR,
  'reflect-open_iOS',
  'reflect-open_iOS.entitlements',
)
const APP_BINARY_PATH = join(IOS_ARCHIVE_PATH, 'Products', 'Applications', 'Reflect.app', 'Reflect')
const DSYM_PATH = join(IOS_ARCHIVE_PATH, 'dSYMs', 'Reflect.app.dSYM')

/**
 * Before export, `tauri ios build` re-signs the archived app with
 * `reflect-open_iOS/reflect-open_iOS.entitlements`, whatever
 * `CODE_SIGN_ENTITLEMENTS` says. Puts the flavor's file there during `run`.
 */
async function withAppEntitlements(flavor: IosFlavor, run: () => Promise<void>): Promise<void> {
  const flavorPath = join(APPLE_DIR, flavor.appEntitlements)
  if (flavorPath === TAURI_APP_ENTITLEMENTS_PATH) {
    return await run()
  }
  const original = readFileSync(TAURI_APP_ENTITLEMENTS_PATH)
  copyFileSync(flavorPath, TAURI_APP_ENTITLEMENTS_PATH)
  try {
    await run()
  } finally {
    writeFileSync(TAURI_APP_ENTITLEMENTS_PATH, original)
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'build-number': { type: 'string', default: '' },
      flavor: { type: 'string', default: '' },
      'no-sign': { type: 'boolean', default: false },
    },
  })
  const buildNumber = values['build-number']
  const noSign = values['no-sign']
  const flavorName = resolveFlavorName(values.flavor)
  const flavor = FLAVORS[flavorName]
  if (!/^\d+$/.test(buildNumber)) {
    throw new Error(`invalid build number "${buildNumber}"`)
  }
  assertSentryDsn()

  const config = JSON.stringify({ bundle: { iOS: { bundleVersion: buildNumber } } })
  await runWithTempDir(async (tempDir) => {
    const args = ['ios', 'build', '--ci', '--config', config, ...flavor.configArgs]
    const env: NodeJS.ProcessEnv = {
      // Without line tables the dSYM cannot symbolicate Rust frames.
      CARGO_PROFILE_RELEASE_DEBUG: 'line-tables-only',
      // Tauri only versions the app's Info.plist. The app extensions read
      // these instead, so their versions match the app's (prerelease tag
      // stripped, as Tauri does). `tauri ios build` passes only `TAURI_*`
      // variables on to Xcode.
      TAURI_REFLECT_MARKETING_VERSION: packageJson.version.split('-')[0],
      TAURI_REFLECT_BUILD_NUMBER: buildNumber,
      ...flavor.xcodeEnv,
    }
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
    await withAppEntitlements(flavor, () => runTauri(args, env))
  })
  if (!noSign) {
    await assertIpa(IOS_IPA_PATH, flavor)
  }
  await assertDsyms(APP_BINARY_PATH, [DSYM_PATH], '_reflect_start_native_diagnostics')
  const output = noSign ? IOS_ARCHIVE_PATH : IOS_IPA_PATH
  log(`built ${output} (${flavorName} ${flavor.bundleIdentifier}, build ${buildNumber})`)
}

await main()
