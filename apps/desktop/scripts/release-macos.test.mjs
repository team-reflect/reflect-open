import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  createBetaFeedReleaseArgs,
  createDmgArgs,
  createReleaseArgs,
  createTauriBuildArgs,
  createUpdaterManifest,
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
  const args = createTauriBuildArgs({ flavor: 'stable', hasUpdater: true, target: 'x86_64-apple-darwin' })

  expect(args.slice(0, 6)).toEqual(['tauri', 'build', '--target', 'x86_64-apple-darwin', '--bundles', 'app'])
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
  expect(createTauriBuildArgs({ flavor: 'beta', hasUpdater: false, target: 'aarch64-apple-darwin' })).toEqual([
    'tauri',
    'build',
    '--target',
    'aarch64-apple-darwin',
    '--bundles',
    'app',
    '--config',
    'src-tauri/tauri.beta.conf.json',
  ])
})

test('updater manifest includes both macOS release targets', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'reflect-release-test-'))
  try {
    const appleSignature = join(tempDir, 'Reflect Beta_0.3.4_aarch64.app.tar.gz.sig')
    const intelSignature = join(tempDir, 'Reflect Beta_0.3.4_x86_64.app.tar.gz.sig')
    writeFileSync(appleSignature, 'apple-signature\n')
    writeFileSync(intelSignature, 'intel-signature\n')

    expect(
      createUpdaterManifest({
        artifacts: [
          {
            platform: 'darwin-aarch64',
            updaterArchive: join(tempDir, 'Reflect Beta_0.3.4_aarch64.app.tar.gz'),
            updaterSignature: appleSignature,
          },
          {
            platform: 'darwin-x86_64',
            updaterArchive: join(tempDir, 'Reflect Beta_0.3.4_x86_64.app.tar.gz'),
            updaterSignature: intelSignature,
          },
        ],
        pubDate: '2026-06-26T00:00:00.000Z',
        slug: 'team-reflect/reflect-open',
        tag: 'v0.3.4',
        version: '0.3.4',
      }),
    ).toEqual({
      version: '0.3.4',
      pub_date: '2026-06-26T00:00:00.000Z',
      platforms: {
        'darwin-aarch64': {
          signature: 'apple-signature',
          url: 'https://github.com/team-reflect/reflect-open/releases/download/v0.3.4/Reflect.Beta_0.3.4_aarch64.app.tar.gz',
        },
        'darwin-x86_64': {
          signature: 'intel-signature',
          url: 'https://github.com/team-reflect/reflect-open/releases/download/v0.3.4/Reflect.Beta_0.3.4_x86_64.app.tar.gz',
        },
      },
    })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
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
