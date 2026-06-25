import { expect, test } from 'vitest'

import {
  createBetaFeedReleaseArgs,
  createDmgArgs,
  createReleaseArgs,
  createTauriBuildArgs,
  parseKeychainList,
  signDmgArgs,
  uploadBetaFeedArgs,
} from './release-macos.mjs'

const baseInput = {
  assets: ['Reflect.dmg', 'Reflect.app.tar.gz', 'Reflect.app.tar.gz.sig', 'latest.json'],
  commit: 'abc123',
  draft: false,
  productName: 'Reflect',
}

test('pre-release publish opts out of GitHub latest heuristics', () => {
  const args = createReleaseArgs({
    ...baseInput,
    prerelease: true,
    tag: 'v0.2.0-beta.14',
    version: '0.2.0-beta.14',
  })

  expect(args).toEqual([
    'release',
    'create',
    'v0.2.0-beta.14',
    'Reflect.dmg',
    'Reflect.app.tar.gz',
    'Reflect.app.tar.gz.sig',
    'latest.json',
    '--title',
    'Reflect 0.2.0-beta.14',
    '--target',
    'abc123',
    '--generate-notes',
    '--prerelease',
    '--latest=false',
  ])
})

test('stable publish marks the release as latest', () => {
  const args = createReleaseArgs({
    ...baseInput,
    prerelease: false,
    tag: 'v0.2.0',
    version: '0.2.0',
  })

  expect(args).toContain('--latest')
  expect(args).not.toContain('--prerelease')
  expect(args).not.toContain('--latest=false')
})

test('draft publish keeps the draft flag last', () => {
  const args = createReleaseArgs({
    ...baseInput,
    draft: true,
    prerelease: true,
    tag: 'v0.2.0-beta.15',
    version: '0.2.0-beta.15',
  })

  expect(args.at(-1)).toBe('--draft')
})

test('beta feed release is a non-latest prerelease pointer', () => {
  expect(createBetaFeedReleaseArgs({ commit: 'abc123', manifestPath: 'latest.json' })).toEqual([
    'release',
    'create',
    'updater-beta',
    'latest.json',
    '--title',
    'Reflect beta updater feed',
    '--target',
    'abc123',
    '--prerelease',
    '--latest=false',
    '--notes',
    'Moving updater feed for beta builds. Do not install this release directly.',
  ])
})

test('beta feed upload replaces the moving manifest', () => {
  expect(uploadBetaFeedArgs({ manifestPath: 'latest.json' })).toEqual([
    'release',
    'upload',
    'updater-beta',
    'latest.json',
    '--clobber',
  ])
})

test('release builds ask Tauri for the app bundle only', () => {
  const args = createTauriBuildArgs({ flavor: 'stable', hasUpdater: true })

  expect(args.slice(0, 4)).toEqual(['tauri', 'build', '--bundles', 'app'])
  expect(args).not.toContain('dmg')
  expect(args).toContain(JSON.stringify({ bundle: { createUpdaterArtifacts: true } }))
  expect(args).toContain(
    JSON.stringify({
      plugins: {
        updater: {
          endpoints: ['https://github.com/team-reflect/reflect-open/releases/latest/download/latest.json'],
        },
      },
    }),
  )
})

test('beta release builds keep the beta flavor overlay', () => {
  expect(createTauriBuildArgs({ flavor: 'beta', hasUpdater: false })).toEqual([
    'tauri',
    'build',
    '--bundles',
    'app',
    '--config',
    'src-tauri/tauri.beta.conf.json',
  ])
})

test('DMG creation uses direct hdiutil packaging', () => {
  expect(createDmgArgs({ dmg: 'Reflect.dmg', sourceFolder: '/tmp/stage', volumeName: 'Reflect' })).toEqual([
    'create',
    '-volname',
    'Reflect',
    '-srcfolder',
    '/tmp/stage',
    '-ov',
    '-format',
    'UDZO',
    'Reflect.dmg',
  ])
})

test('DMG signing timestamps the container', () => {
  expect(signDmgArgs({ dmg: 'Reflect.dmg', identity: 'Developer ID Application: Reflect App, LLC (789ULN5MZB)' })).toEqual(
    ['--force', '--sign', 'Developer ID Application: Reflect App, LLC (789ULN5MZB)', '--timestamp', 'Reflect.dmg'],
  )
})

test('DMG signing can target a temporary CI keychain', () => {
  expect(
    signDmgArgs({
      dmg: 'Reflect.dmg',
      identity: 'Developer ID Application: Reflect App, LLC (789ULN5MZB)',
      keychain: '/tmp/reflect-signing.keychain-db',
    }),
  ).toEqual([
    '--force',
    '--sign',
    'Developer ID Application: Reflect App, LLC (789ULN5MZB)',
    '--timestamp',
    '--keychain',
    '/tmp/reflect-signing.keychain-db',
    'Reflect.dmg',
  ])
})

test('macOS keychain list output is parsed as paths', () => {
  expect(
    parseKeychainList(`    "/Users/runner/Library/Keychains/login.keychain-db"
    "/Library/Keychains/System.keychain"
`),
  ).toEqual(['/Users/runner/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain'])
})
