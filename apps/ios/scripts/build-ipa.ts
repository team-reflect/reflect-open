// Builds the iOS app of the Swift shell (`apps/ios`) and checks the archive,
// its dSYM and the IPA.
//
//   pnpm build:ipa --build-number=<digits> --flavor=beta|stable
//
//   --build-number=<digits>   Required
//   --flavor=beta|stable      Required
//   --no-sign                 Unsigned archive without credentials and without an IPA

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { exec } from 'tinyexec'
import packageJson from '../../web/package.json' with { type: 'json' }
import {
  assertDsyms,
  assertSentryDsn,
  INHERIT,
  log,
  resolveApiKey,
  runWithTempDir,
} from '../../../scripts/release.ts'
import { ARCHIVE_PATH, assertIpa, BUILD_DIR, IOS_DIR, IPA_PATH } from './helpers.ts'

// The identifiers repeat the values of `apps/ios/Config/*.xcconfig` on
// purpose: the IPA check compares the built app with them.
const FLAVORS = {
  stable: {
    configuration: 'Release-Stable',
    bundleIdentifier: 'app.reflect.ios',
    appGroup: 'group.app.reflect',
  },
  beta: {
    configuration: 'Release-Beta',
    bundleIdentifier: 'app.reflect.ios.beta',
    appGroup: 'group.app.reflect.beta',
  },
}

const APP_BINARY_PATH = join(ARCHIVE_PATH, 'Products', 'Applications', 'Reflect.app', 'Reflect')
const DSYM_PATH = join(ARCHIVE_PATH, 'dSYMs', 'Reflect.app.dSYM')

// The ad-hoc signed archive has no team, so the export options name it.
// It repeats `DEVELOPMENT_TEAM` of `apps/ios/Config/Shared.xcconfig`.
const EXPORT_OPTIONS_PATH = join(IOS_DIR, 'ExportOptions.plist')

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
  if (values.flavor !== 'beta' && values.flavor !== 'stable') {
    throw new Error(`invalid flavor "${values.flavor}": expected beta or stable`)
  }
  const flavor = FLAVORS[values.flavor]
  if (!/^\d+$/.test(buildNumber)) {
    throw new Error(`invalid build number "${buildNumber}"`)
  }
  assertSentryDsn()

  await exec('pnpm', ['--filter', '@reflect/ios', 'build:web'], INHERIT)

  rmSync(BUILD_DIR, { recursive: true, force: true })
  await runWithTempDir(async (tempDir) => {
    const apiKey = noSign ? null : resolveApiKey(tempDir)
    if (!noSign && !apiKey) {
      throw new Error('the App Store Connect API key is not set')
    }
    const signing = apiKey
      ? [
          '-allowProvisioningUpdates',
          '-authenticationKeyPath',
          apiKey.keyPath,
          '-authenticationKeyID',
          apiKey.keyId,
          '-authenticationKeyIssuerID',
          apiKey.issuer,
        ]
      : []

    const archive = [
      'archive',
      '-project',
      join(IOS_DIR, 'Reflect.xcodeproj'),
      '-scheme',
      'Reflect',
      '-configuration',
      flavor.configuration,
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      ARCHIVE_PATH,
      // The marketing version has no prerelease tag: Apple takes three integers.
      `REFLECT_MARKETING_VERSION=${packageJson.version.split('-')[0]}`,
      `REFLECT_BUILD_NUMBER=${buildNumber}`,
      `REFLECT_SENTRY_DSN=${(process.env.VITE_SENTRY_DSN ?? '').trim()}`,
      // Signed to run locally: no certificate, but the signature keeps the
      // entitlements that the export re-signs with. Without the API key, the
      // archive cannot create a development certificate on the account.
      ...(noSign
        ? ['CODE_SIGNING_ALLOWED=NO']
        : ['CODE_SIGN_IDENTITY=-', 'AD_HOC_CODE_SIGNING_ALLOWED=YES']),
    ]
    await exec('xcodebuild', archive, {
      throwOnError: true,
      nodeOptions: {
        // Without line tables the dSYM cannot symbolicate Rust frames.
        env: { CARGO_PROFILE_RELEASE_DEBUG: 'line-tables-only' },
        stdio: 'inherit',
      },
    })

    if (apiKey) {
      const exportArchive = [
        '-exportArchive',
        '-archivePath',
        ARCHIVE_PATH,
        '-exportPath',
        BUILD_DIR,
        '-exportOptionsPlist',
        EXPORT_OPTIONS_PATH,
        ...signing,
      ]
      await exec('xcodebuild', exportArchive, INHERIT)
      await assertIpa(IPA_PATH, flavor)
    }
  })

  await assertDsyms(APP_BINARY_PATH, [DSYM_PATH], '_reflect_core_dispatch')
  const output = noSign ? ARCHIVE_PATH : IPA_PATH
  log(`built ${output} (${values.flavor} ${flavor.bundleIdentifier}, build ${buildNumber})`)
}

await main()
