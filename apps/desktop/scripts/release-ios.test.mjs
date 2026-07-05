import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  appStoreConnectPrivateKeySearchPaths,
  createAltoolListAppsArgs,
  createAltoolUploadArgs,
  createAltoolValidateArgs,
  createApiKeyAltoolArgs,
  createTauriIosBuildEnv,
  createTauriIosBuildArgs,
  findIpaInfoPlistPath,
  isFalsePlistValue,
  normalizeApiKeyContent,
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
    CI: 'true',
  })
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

test('Info.plist export-compliance false values are normalized', () => {
  expect(isFalsePlistValue('false')).toBe(true)
  expect(isFalsePlistValue('NO')).toBe(true)
  expect(isFalsePlistValue('0')).toBe(true)
  expect(isFalsePlistValue('true')).toBe(false)
})
