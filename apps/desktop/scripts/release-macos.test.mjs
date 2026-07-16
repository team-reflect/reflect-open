import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  appendMacDownloadNotice,
  assertMacosProfileIdentityEntitlements,
  canLaunchTarget,
  compareReleaseVersions,
  createBetaFeedReleaseArgs,
  createBetaFeedUploadSteps,
  createDmgArgs,
  createExistingReleaseUploadArgs,
  createFinalizeReleaseArgs,
  createGenerateReleaseNotesArgs,
  createMacDownloadNotice,
  createReleaseDownloadArgs,
  createReleaseArgs,
  createTauriBuildArgs,
  createUpdaterArchiveArgs,
  createUpdaterManifest,
  describeError,
  macosEntitlementsPath,
  macosProvisioningProfilePath,
  macosTargetResourceConfig,
  mergeMacosProfileIdentityEntitlements,
  newestBetaVersionFromTags,
  parseKeychainList,
  signDmgArgs,
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

test('draft release uploads clobber so a crashed publish can retry', () => {
  expect(
    createExistingReleaseUploadArgs({
      assets: ['Reflect.dmg', 'Reflect.app.tar.gz', 'latest.json'],
      tag: 'v0.5.0-beta.1',
    }),
  ).toEqual(['release', 'upload', 'v0.5.0-beta.1', 'Reflect.dmg', 'Reflect.app.tar.gz', 'latest.json', '--clobber'])
})

test('finalizing a beta draft keeps the pre-release flag and undrafts last', () => {
  const args = createFinalizeReleaseArgs({
    keepDraft: false,
    notesPath: 'release-notes.md',
    prerelease: true,
    productName: 'Reflect Beta',
    tag: 'v0.5.0-beta.1',
    version: '0.5.0-beta.1',
  })

  expect(args).toEqual([
    'release',
    'edit',
    'v0.5.0-beta.1',
    '--title',
    'Reflect Beta 0.5.0-beta.1',
    '--notes-file',
    'release-notes.md',
    '--prerelease',
    '--latest=false',
    '--draft=false',
  ])
})

test('finalizing a stable draft promotes it to the latest release', () => {
  const args = createFinalizeReleaseArgs({
    keepDraft: false,
    notesPath: 'release-notes.md',
    prerelease: false,
    productName: 'Reflect',
    tag: 'v0.5.0',
    version: '0.5.0',
  })

  expect(args).toContain('--latest')
  expect(args).toContain('--prerelease=false')
  expect(args.at(-1)).toBe('--draft=false')
})

test('finalizing with --draft leaves the release a draft for review', () => {
  const args = createFinalizeReleaseArgs({
    keepDraft: true,
    notesPath: 'release-notes.md',
    prerelease: true,
    productName: 'Reflect Beta',
    tag: 'v0.5.0-beta.1',
    version: '0.5.0-beta.1',
  })

  expect(args).not.toContain('--draft=false')
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
  const notice = createMacDownloadNotice({ productName: 'Reflect Beta' })

  expect(notice).toContain('`Reflect.Beta_aarch64.dmg`')
  expect(notice).toContain('`Reflect.Beta_x86_64.dmg`')
  expect(notice).toContain('Apple Silicon (M-series Macs)')
  expect(notice).toContain('Apple menu -> About This Mac')
})

test('Mac download notice is appended after generated release notes', () => {
  const notes = appendMacDownloadNotice({
    body: "## What's Changed\n\n- Fixed sync\n\n**Full Changelog**: v0.3.6...v0.3.7\n",
    productName: 'Reflect',
  })

  expect(notes).toBe(
    "## What's Changed\n\n" +
      '- Fixed sync\n\n' +
      '**Full Changelog**: v0.3.6...v0.3.7\n\n' +
      '## Which Mac download should I choose?\n\n' +
      '- **Apple Silicon (M-series Macs):** download `Reflect_aarch64.dmg`.\n' +
      '- **Intel Macs:** download `Reflect_x86_64.dmg`.\n\n' +
      'To check your Mac, open **Apple menu -> About This Mac**. If it shows **Chip** with M1, M2, M3, M4, or newer, choose Apple Silicon. If it shows **Processor** with Intel, choose Intel.\n',
  )
})

test('Mac download notice is not duplicated when release notes are regenerated', () => {
  const notes = appendMacDownloadNotice({
    body: createMacDownloadNotice({ productName: 'Reflect' }),
    productName: 'Reflect',
  })

  expect(notes.match(/Which Mac download should I choose/g)).toHaveLength(1)
})

test('beta feed release carries the latest downloads without becoming the latest stable release', () => {
  expect(
    createBetaFeedReleaseArgs({
      assets: ['Reflect.Beta_aarch64.dmg', 'Reflect.Beta_x86_64.dmg', 'latest.json'],
      commit: 'abc123',
    }),
  ).toEqual([
    'release',
    'create',
    'updater-beta',
    'Reflect.Beta_aarch64.dmg',
    'Reflect.Beta_x86_64.dmg',
    'latest.json',
    '--title',
    'Latest Reflect Beta downloads',
    '--target',
    'abc123',
    '--prerelease',
    '--latest=false',
    '--notes',
    'Moving downloads and updater feed for the latest Reflect Beta release. Choose a DMG for a fresh install; installed beta apps use latest.json.',
  ])
})

test('beta feed replaces downloads before the updater manifest', () => {
  expect(
    createBetaFeedUploadSteps({
      dmgPaths: ['Reflect.Beta_aarch64.dmg', 'Reflect.Beta_x86_64.dmg'],
      manifestPath: 'latest.json',
    }),
  ).toEqual([
    {
      label: 'downloads',
      args: [
        'release',
        'upload',
        'updater-beta',
        'Reflect.Beta_aarch64.dmg',
        'Reflect.Beta_x86_64.dmg',
        '--clobber',
      ],
    },
    {
      label: 'updater feed',
      args: ['release', 'upload', 'updater-beta', 'latest.json', '--clobber'],
    },
  ])
})

test('beta feed recovery downloads exact assets from the tagged release', () => {
  expect(
    createReleaseDownloadArgs({
      assetNames: ['Reflect.Beta_aarch64.dmg', 'Reflect.Beta_x86_64.dmg', 'latest.json'],
      outputDir: '/tmp/release-assets',
      tag: 'v0.6.0-beta.14',
    }),
  ).toEqual([
    'release',
    'download',
    'v0.6.0-beta.14',
    '--dir',
    '/tmp/release-assets',
    '--pattern',
    'Reflect.Beta_aarch64.dmg',
    '--pattern',
    'Reflect.Beta_x86_64.dmg',
    '--pattern',
    'latest.json',
  ])
})

test('beta feed version comparison prevents rollback while allowing recovery', () => {
  expect(compareReleaseVersions('0.6.0-beta.13', '0.6.0-beta.14')).toBe(-1)
  expect(compareReleaseVersions('0.6.0-beta.14', '0.6.0-beta.14')).toBe(0)
  expect(compareReleaseVersions('0.6.0-beta.15', '0.6.0-beta.14')).toBe(1)
})

test('beta feed version comparison handles release-please beta boundaries', () => {
  expect(compareReleaseVersions('0.6.0-beta', '0.5.0-beta.99')).toBe(1)
  expect(compareReleaseVersions('0.6.0-beta.1', '0.6.0-beta')).toBe(1)
  expect(compareReleaseVersions('0.6.0', '0.6.0-beta.99')).toBe(1)
})

test('beta feed version comparison rejects unsupported versions', () => {
  expect(() => compareReleaseVersions('0.6.0-rc.1', '0.6.0-beta.14')).toThrow('unsupported release version')
})

test('beta feed selects the newest immutable published beta tag', () => {
  expect(
    newestBetaVersionFromTags([
      'updater-beta',
      'v0.5.0',
      'v0.5.0-beta.99',
      'v0.6.0-beta.9',
      'v0.6.0-beta.14',
      '',
    ]),
  ).toBe('0.6.0-beta.14')
  expect(() => newestBetaVersionFromTags(['updater-beta', 'v0.5.0'])).toThrow('published beta releases')
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

test('macOS provisioning profiles resolve per flavor and dev remains unprovisioned', () => {
  const srcTauri = join(process.cwd(), 'src-tauri')

  expect(macosProvisioningProfilePath('stable')).toBe(join(srcTauri, 'Reflect.provisionprofile'))
  expect(macosProvisioningProfilePath('beta')).toBe(join(srcTauri, 'Reflect-beta.provisionprofile'))
  expect(macosProvisioningProfilePath('dev')).toBeNull()
})

test('macOS signing keeps app entitlements and adds only profile identity entitlements', () => {
  const appEntitlements = {
    'com.apple.developer.icloud-services': ['CloudDocuments'],
    'com.apple.security.device.audio-input': true,
  }
  const profileEntitlements = {
    'com.apple.application-identifier': '789ULN5MZB.app.reflect.desktop.beta',
    'com.apple.developer.team-identifier': '789ULN5MZB',
    'keychain-access-groups': ['789ULN5MZB.*'],
  }

  expect(
    mergeMacosProfileIdentityEntitlements({
      appEntitlements,
      bundleIdentifier: 'app.reflect.desktop.beta',
      profileEntitlements,
    }),
  ).toEqual({
    ...appEntitlements,
    'com.apple.application-identifier': '789ULN5MZB.app.reflect.desktop.beta',
    'com.apple.developer.team-identifier': '789ULN5MZB',
  })
})

test('macOS signing rejects a provisioning profile for another flavor', () => {
  expect(() =>
    mergeMacosProfileIdentityEntitlements({
      appEntitlements: { 'com.apple.security.device.audio-input': true },
      bundleIdentifier: 'app.reflect.desktop.beta',
      profileEntitlements: {
        'com.apple.application-identifier': '789ULN5MZB.app.reflect.desktop',
        'com.apple.developer.team-identifier': '789ULN5MZB',
      },
    }),
  ).toThrow('does not match bundle identifier "app.reflect.desktop.beta"')
})

test('macOS signing compares the full profile bundle identifier, not only its suffix', () => {
  expect(() =>
    mergeMacosProfileIdentityEntitlements({
      appEntitlements: {},
      bundleIdentifier: 'app.reflect.desktop.beta',
      profileEntitlements: {
        'com.apple.application-identifier': '789ULN5MZB.other.app.reflect.desktop.beta',
        'com.apple.developer.team-identifier': '789ULN5MZB',
      },
    }),
  ).toThrow('does not match bundle identifier "app.reflect.desktop.beta"')
})

test.each(['com.apple.application-identifier', 'com.apple.developer.team-identifier'])(
  'macOS signing rejects a profile missing %s',
  (missingEntitlement) => {
    const profileEntitlements = {
      'com.apple.application-identifier': '789ULN5MZB.app.reflect.desktop.beta',
      'com.apple.developer.team-identifier': '789ULN5MZB',
    }
    delete profileEntitlements[missingEntitlement]

    expect(() =>
      mergeMacosProfileIdentityEntitlements({
        appEntitlements: {},
        bundleIdentifier: 'app.reflect.desktop.beta',
        profileEntitlements,
      }),
    ).toThrow(`missing string entitlement "${missingEntitlement}"`)
  },
)

test('macOS signing rejects a conflicting identity in the app entitlement file', () => {
  expect(() =>
    mergeMacosProfileIdentityEntitlements({
      appEntitlements: { 'com.apple.developer.team-identifier': 'WRONGTEAM' },
      bundleIdentifier: 'app.reflect.desktop',
      profileEntitlements: {
        'com.apple.application-identifier': '789ULN5MZB.app.reflect.desktop',
        'com.apple.developer.team-identifier': '789ULN5MZB',
      },
    }),
  ).toThrow('but the embedded provisioning profile requires "789ULN5MZB"')
})

test('macOS verification rejects a signed app that lost a profile identity entitlement', () => {
  expect(() =>
    assertMacosProfileIdentityEntitlements({
      bundleIdentifier: 'app.reflect.desktop.beta',
      profileEntitlements: {
        'com.apple.application-identifier': '789ULN5MZB.app.reflect.desktop.beta',
        'com.apple.developer.team-identifier': '789ULN5MZB',
      },
      signedEntitlements: {
        'com.apple.application-identifier': '789ULN5MZB.app.reflect.desktop.beta',
      },
    }),
  ).toThrow('signed app entitlement "com.apple.developer.team-identifier" is undefined')
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

test('described errors keep the stdout and stderr captured by execFileSync', () => {
  const error = new Error('Command failed: plutil -extract Entitlements json -o - -')
  error.stdout = '<stdin>: Could not extract value\n'
  error.stderr = ''

  expect(describeError(error)).toBe(
    'Command failed: plutil -extract Entitlements json -o - -\nstdout:\n<stdin>: Could not extract value',
  )
})

test('described errors without captured output stay a plain message', () => {
  expect(describeError(new Error('boom'))).toBe('boom')
  expect(describeError('not an error')).toBe('not an error')
})
