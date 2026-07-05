import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  appendMacDownloadNotice,
  canLaunchTarget,
  createBetaFeedReleaseArgs,
  createDmgArgs,
  createGenerateReleaseNotesArgs,
  createMacDownloadNotice,
  createReleaseArgs,
  createTauriBuildArgs,
  createUpdaterArchiveArgs,
  createUpdaterManifest,
  macosEntitlementsPath,
  macosTargetResourceConfig,
  parseKeychainList,
  signDmgArgs,
  uploadBetaFeedArgs,
} from './release-macos.mjs'

const baseInput = {
  assets: ['Reflect.dmg', 'Reflect.app.tar.gz', 'Reflect.app.tar.gz.sig', 'latest.json'],
  commit: 'abc123',
  draft: false,
  notesPath: 'release-notes.md',
  productName: 'Reflect',
}

test('pre-release publish uses prepared notes and opts out of GitHub latest heuristics', () => {
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
    '--notes-file',
    'release-notes.md',
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
  expect(args).not.toContain('--generate-notes')
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

test('generated release notes API targets the release tag and commit', () => {
  expect(createGenerateReleaseNotesArgs({ commit: 'abc123', tag: 'v0.4.0' })).toEqual([
    'api',
    'repos/{owner}/{repo}/releases/generate-notes',
    '--method',
    'POST',
    '-f',
    'tag_name=v0.4.0',
    '-f',
    'target_commitish=abc123',
  ])
})

test('Mac download notice points each processor at the matching DMG', () => {
  const notice = createMacDownloadNotice({ productName: 'Reflect Beta', version: '0.4.0-beta.8' })

  expect(notice).toContain('`Reflect.Beta_0.4.0-beta.8_aarch64.dmg`')
  expect(notice).toContain('`Reflect.Beta_0.4.0-beta.8_x86_64.dmg`')
  expect(notice).toContain('Apple Silicon (M-series Macs)')
  expect(notice).toContain('Apple menu -> About This Mac')
})

test('Mac download notice is appended after generated release notes', () => {
  const notes = appendMacDownloadNotice({
    body: "## What's Changed\n\n- Fixed sync\n\n**Full Changelog**: v0.3.6...v0.3.7\n",
    productName: 'Reflect',
    version: '0.3.7',
  })

  expect(notes).toBe(
    "## What's Changed\n\n" +
      '- Fixed sync\n\n' +
      '**Full Changelog**: v0.3.6...v0.3.7\n\n' +
      '## Which Mac download should I choose?\n\n' +
      '- **Apple Silicon (M-series Macs):** download `Reflect_0.3.7_aarch64.dmg`.\n' +
      '- **Intel Macs:** download `Reflect_0.3.7_x86_64.dmg`.\n\n' +
      'To check your Mac, open **Apple menu -> About This Mac**. If it shows **Chip** with M1, M2, M3, M4, or newer, choose Apple Silicon. If it shows **Processor** with Intel, choose Intel.\n',
  )
})

test('Mac download notice is not duplicated when release notes are regenerated', () => {
  const notes = appendMacDownloadNotice({
    body: createMacDownloadNotice({ productName: 'Reflect', version: '0.3.7' }),
    productName: 'Reflect',
    version: '0.3.7',
  })

  expect(notes.match(/Which Mac download should I choose/g)).toHaveLength(1)
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
  const args = createTauriBuildArgs({ flavor: 'stable', target: 'x86_64-apple-darwin' })

  expect(args.slice(0, 6)).toEqual(['tauri', 'build', '--target', 'x86_64-apple-darwin', '--bundles', 'app'])
  expect(args).not.toContain('dmg')
  expect(args).not.toContain(JSON.stringify({ bundle: { createUpdaterArtifacts: true } }))
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

test('Intel release builds include the bundled ONNX Runtime resource', () => {
  const resourceConfig = macosTargetResourceConfig('x86_64-apple-darwin')
  const args = createTauriBuildArgs({
    flavor: 'stable',
    resourceConfig,
    target: 'x86_64-apple-darwin',
  })

  expect(args).toContain(JSON.stringify(resourceConfig))
})

test('Apple Silicon release builds do not include Intel-only runtime resources', () => {
  expect(macosTargetResourceConfig('aarch64-apple-darwin')).toBeNull()
})

test('beta release builds keep the beta flavor overlay', () => {
  expect(createTauriBuildArgs({ flavor: 'beta', target: 'aarch64-apple-darwin' })).toEqual([
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

test('macOS entitlements resolve through platform and flavor overlays', () => {
  const srcTauri = join(process.cwd(), 'src-tauri')

  expect(macosEntitlementsPath('stable')).toBe(join(srcTauri, 'Entitlements.plist'))
  expect(macosEntitlementsPath('beta')).toBe(join(srcTauri, 'Entitlements.plist'))
  expect(macosEntitlementsPath('dev')).toBe(join(srcTauri, 'Entitlements.dev.plist'))
})

test('sidecar launch checks cover native targets and Intel under Rosetta', () => {
  expect(canLaunchTarget('aarch64-apple-darwin', 'arm64')).toBe(true)
  expect(canLaunchTarget('aarch64-apple-darwin', 'x64')).toBe(false)
  expect(canLaunchTarget('x86_64-apple-darwin', 'x64')).toBe(true)
  expect(canLaunchTarget('x86_64-apple-darwin', 'arm64')).toBe(true)
})

test('updater archive is created from the finalized app bundle', () => {
  expect(createUpdaterArchiveArgs({ app: '/tmp/build/Reflect.app', archive: '/tmp/build/Reflect.app.tar.gz' })).toEqual([
    '-czf',
    '/tmp/build/Reflect.app.tar.gz',
    '-C',
    '/tmp/build',
    'Reflect.app',
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
