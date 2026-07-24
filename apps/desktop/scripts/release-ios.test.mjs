import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  appStoreConnectPrivateKeySearchPaths,
  createAltoolListAppsArgs,
  createAltoolUploadArgs,
  createAltoolValidateArgs,
  createApiKeyAltoolArgs,
  createSentryDebugFilesUploadArgs,
  createTimestampBuildNumber,
  createTauriIosBuildEnv,
  createTauriIosBuildArgs,
  findIpaAppexPaths,
  findIpaInfoPlistPath,
  inspectNativeSentryConfiguration,
  isFalsePlistValue,
  isProductionSentryDsn,
  normalizeApiKeyContent,
  parseDwarfdumpUuids,
  resolveBuildNumber,
} from './release-ios.mjs'

test('iOS release builds pass App Store Connect export and build number through Tauri', () => {
  expect(
    createTauriIosBuildArgs({
      buildNumber: '492',
      exportMethod: 'app-store-connect',
    }),
  ).toEqual([
    'tauri',
    'ios',
    'build',
    '--export-method',
    'app-store-connect',
    '--ci',
    '--config',
    JSON.stringify({ bundle: { iOS: { bundleVersion: '492' } } }),
  ])
})

test('iOS release builds can rely on local Xcode accounts when no API key is supplied', () => {
  expect(createTauriIosBuildArgs({ exportMethod: 'release-testing' })).toEqual([
    'tauri',
    'ios',
    'build',
    '--export-method',
    'release-testing',
    '--ci',
  ])
})

test('timestamp build numbers use UTC YYYYMMDDHHmm format', () => {
  expect(createTimestampBuildNumber(new Date('2026-07-05T09:04:30Z'))).toBe('202607050904')
})

test('required iOS release commands generate timestamp build numbers instead of using GitHub run numbers', () => {
  const previousBuildNumber = process.env.BUILD_NUMBER
  const previousRunNumber = process.env.GITHUB_RUN_NUMBER

  try {
    delete process.env.BUILD_NUMBER
    process.env.GITHUB_RUN_NUMBER = '10'

    expect(resolveBuildNumber(null, { required: true, now: new Date('2026-07-05T09:04:30Z') })).toBe(
      '202607050904',
    )
  } finally {
    if (previousBuildNumber === undefined) {
      delete process.env.BUILD_NUMBER
    } else {
      process.env.BUILD_NUMBER = previousBuildNumber
    }
    if (previousRunNumber === undefined) {
      delete process.env.GITHUB_RUN_NUMBER
    } else {
      process.env.GITHUB_RUN_NUMBER = previousRunNumber
    }
  }
})

test('iOS release builds expose the staged API key path to Tauri signing', () => {
  expect(
    createTauriIosBuildEnv({
      baseEnv: {
        APPLE_API_ISSUER: 'issuer-uuid',
        APPLE_API_KEY: 'ABC123DEFG',
        CI: '',
      },
      apiKeyCredentials: {
        env: {
          APPLE_API_KEY_PATH: '/tmp/AuthKey_ABC123DEFG.p8',
        },
      },
    }),
  ).toEqual({
    APPLE_API_ISSUER: 'issuer-uuid',
    APPLE_API_KEY: 'ABC123DEFG',
    APPLE_API_KEY_PATH: '/tmp/AuthKey_ABC123DEFG.p8',
    CARGO_PROFILE_RELEASE_DEBUG: 'line-tables-only',
    CI: 'true',
  })
})

test('native debug upload targets dSYMs without uploading source bundles', () => {
  expect(createSentryDebugFilesUploadArgs('/tmp/ios-build')).toEqual([
    'debug-files',
    'upload',
    '--org',
    'reflect-64',
    '--project',
    'reflect-open',
    '--type',
    'dsym',
    '--no-sources',
    '--wait-for',
    '60',
    '/tmp/ios-build',
  ])
})

test('native diagnostics accept only the production Reflect Sentry DSN', () => {
  expect(
    isProductionSentryDsn(
      'https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/4511705649971200',
    ),
  ).toBe(true)
  expect(
    isProductionSentryDsn(
      'https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/1',
    ),
  ).toBe(false)
  expect(isProductionSentryDsn('https://public@example.test/4511705649971200')).toBe(false)
})

test('native symbol upload rejects partial Sentry configuration', () => {
  expect(inspectNativeSentryConfiguration({})).toEqual({
    enabled: false,
    error: null,
  })
  expect(
    inspectNativeSentryConfiguration({
      VITE_SENTRY_DSN:
        'https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/4511705649971200',
    }),
  ).toEqual({
    enabled: false,
    error:
      'native Sentry configuration is incomplete; set both SENTRY_AUTH_TOKEN and VITE_SENTRY_DSN',
  })
})

test('Mach-O UUID parsing normalizes every archive architecture', () => {
  expect(
    parseDwarfdumpUuids(
      [
        'UUID: abcdefab-cdef-abcd-efab-cdefabcdefab (arm64) /tmp/Reflect',
        'UUID: 01234567-89AB-CDEF-0123-456789ABCDEF (arm64e) /tmp/Reflect',
      ].join('\n'),
    ),
  ).toEqual([
    '01234567-89AB-CDEF-0123-456789ABCDEF',
    'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB',
  ])
})

test('altool upload uses package upload with API key auth and optional processing wait', () => {
  const authArgs = createApiKeyAltoolArgs({
    issuerId: 'issuer-uuid',
    keyId: 'ABC123DEFG',
    keyPath: '/tmp/AuthKey_ABC123DEFG.p8',
  })

  expect(createAltoolUploadArgs({ authArgs, ipa: '/tmp/Reflect.ipa', wait: true })).toEqual([
    'altool',
    '--upload-package',
    '/tmp/Reflect.ipa',
    '--api-key',
    'ABC123DEFG',
    '--api-issuer',
    'issuer-uuid',
    '--p8-file-path',
    '/tmp/AuthKey_ABC123DEFG.p8',
    '--output-format',
    'json',
    '--show-progress',
    '--wait',
  ])
})

test('altool validation uses the same upload credentials', () => {
  const authArgs = ['--username', 'release@example.com', '--password', '@env:APPLE_PASSWORD']

  expect(createAltoolValidateArgs({ authArgs, ipa: '/tmp/Reflect.ipa' })).toEqual([
    'altool',
    '--validate-app',
    '/tmp/Reflect.ipa',
    '--username',
    'release@example.com',
    '--password',
    '@env:APPLE_PASSWORD',
    '--output-format',
    'json',
  ])
})

test('altool app lookup filters by bundle identifier', () => {
  const authArgs = ['--api-key', 'ABC123DEFG', '--api-issuer', 'issuer-uuid']

  expect(createAltoolListAppsArgs({ authArgs, bundleIdentifier: 'app.reflect.ios' })).toEqual([
    'altool',
    '--list-apps',
    '--filter-bundle-id',
    'app.reflect.ios',
    '--api-key',
    'ABC123DEFG',
    '--api-issuer',
    'issuer-uuid',
    '--output-format',
    'json',
  ])
})

test('standard App Store Connect private key paths match altool lookup locations', () => {
  expect(
    appStoreConnectPrivateKeySearchPaths({
      cwd: '/repo',
      homeDir: '/Users/alex',
      keyId: 'ABC123DEFG',
    }),
  ).toEqual([
    join('/repo', 'private_keys', 'AuthKey_ABC123DEFG.p8'),
    join('/Users/alex', 'private_keys', 'AuthKey_ABC123DEFG.p8'),
    join('/Users/alex', '.private_keys', 'AuthKey_ABC123DEFG.p8'),
    join('/Users/alex', '.appstoreconnect', 'private_keys', 'AuthKey_ABC123DEFG.p8'),
  ])
})

test('API key content accepts raw p8 text and base64-wrapped p8 text', () => {
  const raw = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  expect(normalizeApiKeyContent(raw)).toBe(`${raw}\n`)
  expect(normalizeApiKeyContent(Buffer.from(raw).toString('base64'))).toBe(`${raw}\n`)
})

test('IPA Info.plist lookup targets the app payload plist', () => {
  expect(
    findIpaInfoPlistPath(
      [
        'Payload/',
        'Payload/Reflect.app/',
        'Payload/Reflect.app/Info.plist',
        'Payload/Reflect.app/LaunchScreen.storyboardc/Info.plist',
        'Symbols/Reflect.symbols',
      ].join('\n'),
    ),
  ).toBe('Payload/Reflect.app/Info.plist')
})

test('IPA Info.plist lookup rejects ambiguous payloads', () => {
  expect(() =>
    findIpaInfoPlistPath(
      ['Payload/Reflect.app/Info.plist', 'Payload/Other.app/Info.plist'].join('\n'),
    ),
  ).toThrow('expected exactly one app Info.plist')
})

test('IPA appex lookup finds each embedded extension bundle once', () => {
  expect(
    findIpaAppexPaths(
      [
        'Payload/',
        'Payload/Reflect.app/',
        'Payload/Reflect.app/Info.plist',
        'Payload/Reflect.app/PlugIns/ShareExtension.appex/',
        'Payload/Reflect.app/PlugIns/ShareExtension.appex/Info.plist',
        'Payload/Reflect.app/PlugIns/ShareExtension.appex/ShareExtension',
        'Symbols/Reflect.symbols',
      ].join('\n'),
    ),
  ).toEqual(['Payload/Reflect.app/PlugIns/ShareExtension.appex'])
})

test('IPA appex lookup returns empty for an IPA without extensions', () => {
  expect(findIpaAppexPaths(['Payload/Reflect.app/', 'Payload/Reflect.app/Info.plist'].join('\n'))).toEqual([])
})

test('Info.plist export-compliance false values are normalized', () => {
  expect(isFalsePlistValue('false')).toBe(true)
  expect(isFalsePlistValue('NO')).toBe(true)
  expect(isFalsePlistValue('0')).toBe(true)
  expect(isFalsePlistValue('true')).toBe(false)
})
