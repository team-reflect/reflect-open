// Builds the iOS app of the Swift shell (`apps/ios`) and checks the archive,
// its dSYM and the IPA.
//
//   pnpm build:ipa --build-number=<digits> --flavor=beta|stable
//
//   --build-number=<digits>   Required
//   --flavor=beta|stable      Required
//   --no-sign                 Unsigned archive without credentials and without an IPA
//
// `IOS_CERTIFICATE` (base64 `.p12`) and `IOS_CERTIFICATE_PASSWORD` give an
// Apple Development certificate for the archive. Without them, Xcode looks in
// the login keychain, and `-allowProvisioningUpdates` creates a new
// certificate when it finds none.

import { rmSync, writeFileSync } from 'node:fs'
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
  runWithSigningKeychain,
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

const EXPORT_OPTIONS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
</dict>
</plist>
`

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

    const build = async (keychain: string | null): Promise<void> => {
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
        ...(noSign ? ['CODE_SIGNING_ALLOWED=NO'] : signing),
        ...(keychain ? [`OTHER_CODE_SIGN_FLAGS=--keychain ${keychain}`] : []),
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
        const exportOptions = join(tempDir, 'ExportOptions.plist')
        writeFileSync(exportOptions, EXPORT_OPTIONS)
        const exportArchive = [
          '-exportArchive',
          '-archivePath',
          ARCHIVE_PATH,
          '-exportPath',
          BUILD_DIR,
          '-exportOptionsPlist',
          exportOptions,
          ...signing,
        ]
        await exec('xcodebuild', exportArchive, INHERIT)
        await assertIpa(IPA_PATH, flavor)
      }
    }
    if (noSign) {
      await build(null)
    } else {
      const certificate = {
        content: process.env.IOS_CERTIFICATE,
        password: process.env.IOS_CERTIFICATE_PASSWORD,
      }
      await runWithSigningKeychain(tempDir, certificate, build)
    }
  })

  await assertDsyms(APP_BINARY_PATH, [DSYM_PATH], '_reflect_core_dispatch')
  const output = noSign ? ARCHIVE_PATH : IPA_PATH
  log(`built ${output} (${values.flavor} ${flavor.bundleIdentifier}, build ${buildNumber})`)
}

await main()
