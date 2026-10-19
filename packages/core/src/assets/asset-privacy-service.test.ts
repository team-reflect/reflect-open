import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestAssetReferences } from '../testing/assets.ts'
import { createTestXArchiveService } from '../testing/capture.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createAssetPrivacyService, type AssetPrivacyService } from './asset-privacy-service.ts'

const asset = `assets/x/url_sha256_${'a'.repeat(64)}.png`

/**
 * Every `XArchiveService.owners` call, as `[assetPath, generation]`.
 */
let ownerCalls: Array<[string, number | undefined]>
/**
 * When set, the archive ownership read rejects with it.
 */
let ownersError: Error | null
let privacy: AssetPrivacyService

/**
 * The real gate over `deps`, with a fresh test double for each one left out.
 */
function createPrivacy(
  deps?: Partial<Parameters<typeof createAssetPrivacyService>[0]>,
): AssetPrivacyService {
  return createAssetPrivacyService({
    noteFile: deps?.noteFile ?? createTestNoteFileService(),
    xArchive: deps?.xArchive ?? createTestXArchiveService(),
    assetReferences: deps?.assetReferences ?? createTestAssetReferences(),
  })
}

beforeEach(() => {
  ownerCalls = []
  ownersError = null
  const xArchive = createTestXArchiveService()
  vi.spyOn(xArchive, 'owners').mockImplementation((assetPath, generation) => {
    ownerCalls.push([assetPath, generation])
    if (ownersError !== null) {
      return Promise.reject(ownersError)
    }
    return Promise.resolve(['assets/x/post-123.json'])
  })
  privacy = createPrivacy({
    xArchive,
  })
})

it('keeps private tweet references when the same media has a public direct reference', async () => {
  const sources = new Map([
    ['public.md', `![Image](${asset})`],
    ['private.md', '---\nprivate: true\n---\n![](https://x.com/jack/status/123)'],
  ])
  expect(
    await privacy.classifyAssetFromNotes(asset, [...sources.keys()], (path) => {
      return Promise.resolve(sources.get(path)!)
    }),
  ).toBe('skip-private')
})

it('checks live ownership instead of treating every private candidate as a reference', async () => {
  const sources = new Map([
    ['public.md', `![Image](${asset})`],
    ['private.md', '---\nprivate: true\n---\n![](https://x.com/jack/status/456)'],
  ])
  expect(
    await privacy.classifyAssetFromNotes(asset, [...sources.keys()], (path) => {
      return Promise.resolve(sources.get(path)!)
    }),
  ).toBe('send')
})

it('recognizes a public tweet reference without a direct media link', async () => {
  expect(
    await privacy.classifyAssetFromNotes(asset, ['public.md'], () => {
      return Promise.resolve('![](https://x.com/jack/status/123)')
    }),
  ).toBe('send')
})

it('does not return a send verdict when archive ownership cannot be read', async () => {
  ownersError = new Error('unreadable archive')
  await expect(
    privacy.classifyAssetFromNotes(asset, ['public.md'], () => {
      return Promise.resolve(`![Image](${asset})`)
    }),
  ).rejects.toThrow('unreadable archive')
})

describe('classifyAssetFromNotes: vault-wide references', () => {
  it('blocks an asset a private note embeds by bare filename', async () => {
    // The index stored `photo.png`; the file is `Media/photo.png`.
    await expect(
      privacy.classifyAssetFromNotes('Media/photo.png', ['private.md'], () => {
        return Promise.resolve('---\nprivate: true\n---\n\n![[photo.png]]\n')
      }),
    ).resolves.toBe('skip-private')
  })

  it('authorizes an asset a public note embeds by bare filename', async () => {
    await expect(
      privacy.classifyAssetFromNotes('Media/photo.png', ['public.md'], () => {
        return Promise.resolve('![[photo.png]]\n')
      }),
    ).resolves.toBe('send')
  })

  it('still blocks an asset a private note references by an old vault-root href', async () => {
    await expect(
      privacy.classifyAssetFromNotes('assets/a.png', ['notes/private.md'], () => {
        return Promise.resolve('---\nprivate: true\n---\n\n![](assets/a.png)\n')
      }),
    ).resolves.toBe('skip-private')
  })
})

it('reuses supplied ownership during live private-note validation', async () => {
  expect(
    await privacy.classifyAssetFromNotes(
      asset,
      ['private.md'],
      () => Promise.resolve('---\nprivate: true\n---\n![](https://x.com/jack/status/123)'),
      ['assets/x/post-123.json'],
    ),
  ).toBe('skip-private')
  expect(ownerCalls).toEqual([])
})

it('pins archive ownership to the classification graph generation', async () => {
  ownersError = new Error('stale graph')
  await expect(privacy.classifyAsset(asset, 42)).rejects.toThrow('stale graph')
  expect(ownerCalls).toEqual([[asset, 42]])
})

describe('classifyAsset (privacy gate)', () => {
  const GENERATION = 7

  /**
   * A public note referencing `assetPath`.
   */
  function publicNote(assetPath: string): string {
    return `# Diagram\n\n![](${assetPath})\n`
  }

  /**
   * A private note referencing `assetPath`.
   */
  function privateNote(assetPath: string): string {
    return `---\nprivate: true\n---\n\n![](${assetPath})\n`
  }

  /**
   * The gate over a graph of `files`, with the index reporting `refs` for `assets/a.png`.
   */
  function classify(files: Readonly<Record<string, string>>, refs: readonly string[]) {
    return createPrivacy({
      noteFile: createTestNoteFileService({ files }),
      assetReferences: createTestAssetReferences({ 'assets/a.png': refs }),
    }).classifyAsset('assets/a.png', GENERATION)
  }

  it('sends when referenced only by public notes', async () => {
    expect(await classify({ 'notes/pub.md': publicNote('assets/a.png') }, ['notes/pub.md'])).toBe(
      'send',
    )
  })

  it('blocks when any referer is private', async () => {
    expect(
      await classify(
        {
          'notes/pub.md': publicNote('assets/a.png'),
          'notes/secret.md': privateNote('assets/a.png'),
        },
        ['notes/pub.md', 'notes/secret.md'],
      ),
    ).toBe('skip-private')
  })

  it('skips when unreferenced', async () => {
    expect(await classify({}, [])).toBe('skip-unreferenced')
  })

  it('ignores a stale index referer whose live body no longer references the asset', async () => {
    expect(
      await classify({ 'notes/stale.md': '# Moved on\n\nno image here\n' }, ['notes/stale.md']),
    ).toBe('skip-unreferenced')
  })

  it('fails closed when a referer cannot be read', async () => {
    const noteFile = createTestNoteFileService()
    vi.spyOn(noteFile, 'read').mockRejectedValue(new AppError('io', 'disk error'))
    const service = createPrivacy({
      noteFile,
      assetReferences: createTestAssetReferences({ 'assets/a.png': ['notes/pub.md'] }),
    })
    expect(await service.classifyAsset('assets/a.png', GENERATION)).toBe('skip-private')
  })

  it('treats a deleted referer (notFound) as not a live referer', async () => {
    // Never seeded, so the read rejects with `notFound`.
    expect(await classify({}, ['notes/gone.md'])).toBe('skip-unreferenced')
  })
})
