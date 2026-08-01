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

    expect(
      resolveBuildNumber(null, { required: true, now: new Date('2026-07-05T09:04:30Z') }),
    ).toBe('202607050904')
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

test('iOS release builds emit Rust line tables so the app dSYM can symbolicate native frames', () => {
  expect(createTauriIosBuildEnv({ baseEnv: {} }).CARGO_PROFILE_RELEASE_DEBUG).toBe(
    'line-tables-only',
  )
  expect(
    createTauriIosBuildEnv({ baseEnv: { CARGO_PROFILE_RELEASE_DEBUG: 'full' } })
      .CARGO_PROFILE_RELEASE_DEBUG,
  ).toBe('full')
})

test('native dSYMs upload without source bundles', () => {
  expect(createSentryDebugFilesUploadArgs('/build/reflect-open_iOS.xcarchive')).toEqual([
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
    '/build/reflect-open_iOS.xcarchive',
  ])
})

test('only the production Reflect Sentry project enables native symbol upload', () => {
  const dsn =
    'https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/4511705649971200'
  expect(isProductionSentryDsn(dsn)).toBe(true)
  expect(isProductionSentryDsn('https://public@example.test/1')).toBe(false)
  expect(isProductionSentryDsn(undefined)).toBe(false)

  expect(
    inspectNativeSentryConfiguration({ SENTRY_AUTH_TOKEN: 'token', VITE_SENTRY_DSN: dsn }),
  ).toEqual({ enabled: true, error: null })
  expect(inspectNativeSentryConfiguration({})).toEqual({ enabled: false, error: null })
})

test('partial or foreign native Sentry configuration fails the release instead of shipping blind', () => {
  const dsn =
    'https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/4511705649971200'
  expect(inspectNativeSentryConfiguration({ SENTRY_AUTH_TOKEN: 'token' }).error).toMatch(
    /incomplete/,
  )
  expect(inspectNativeSentryConfiguration({ VITE_SENTRY_DSN: dsn }).error).toMatch(/incomplete/)
  expect(
    inspectNativeSentryConfiguration({
      SENTRY_AUTH_TOKEN: 'token',
      VITE_SENTRY_DSN: 'https://public@example.test/1',
    }).error,
  ).toMatch(/production Reflect Sentry project/)
})

test('dwarfdump UUIDs are parsed per architecture and compared order-independently', () => {
  expect(
    parseDwarfdumpUuids(
      [
        'UUID: 3fbb0e0d-6cbb-3d0e-9e26-06f2ff1a09f2 (arm64) /build/Reflect.app/Reflect',
        'warning: no debug map',
      ].join('\n'),
    ),
  ).toEqual(['3FBB0E0D-6CBB-3D0E-9E26-06F2FF1A09F2'])
  expect(parseDwarfdumpUuids('')).toEqual([])
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
  expect(
    findIpaAppexPaths(['Payload/Reflect.app/', 'Payload/Reflect.app/Info.plist'].join('\n')),
  ).toEqual([])
})

test('Info.plist export-compliance false values are normalized', () => {
  expect(isFalsePlistValue('false')).toBe(true)
  expect(isFalsePlistValue('NO')).toBe(true)
  expect(isFalsePlistValue('0')).toBe(true)
  expect(isFalsePlistValue('true')).toBe(false)
})
