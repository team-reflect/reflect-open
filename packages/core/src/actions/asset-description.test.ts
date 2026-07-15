import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetDescriptionRejectedError, describeAsset } from '../ai/describe-asset'
import type { AiProvidersState } from '../ai/provider-config'
import { ReflectError } from '../errors'
import {
  assetPrivacySnapshot,
  listDir,
  readManagedAsset,
  readManagedAssetDescription,
  writeManagedAssetDescription,
} from '../graph/commands'
import { hashContent } from '../indexing/hash'
import { getSecret } from '../secrets/keychain'
import { descriptionPathFor, isNotePath } from '../graph/paths'
import {
  assetTypeFor,
  base64ByteLength,
  buildDescriptionSource,
  classifyAsset,
  isEligibleAssetPath,
  readManagedDescription,
  reconcileAssetDescriptions,
  type ReconcileAssetDescriptionsInput,
} from './asset-description'

vi.mock('../graph/commands', () => ({
  assetPrivacySnapshot: vi.fn(),
  listDir: vi.fn(),
  readManagedAsset: vi.fn(),
  readManagedAssetDescription: vi.fn(),
  writeManagedAssetDescription: vi.fn(),
}))
vi.mock('../secrets/keychain', () => ({
  getSecret: vi.fn(),
}))
vi.mock('../ai/describe-asset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/describe-asset')>()),
  describeAsset: vi.fn(),
}))

const listDirMock = vi.mocked(listDir)
const assetPrivacySnapshotMock = vi.mocked(assetPrivacySnapshot)
const readManagedAssetMock = vi.mocked(readManagedAsset)
const readManagedAssetDescriptionMock = vi.mocked(readManagedAssetDescription)
const writeDescriptionMock = vi.mocked(writeManagedAssetDescription)
const getSecretMock = vi.mocked(getSecret)
const describeMock = vi.mocked(describeAsset)

const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-anthropic', provider: 'anthropic', model: 'claude-opus-4-8', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-anthropic',
}
const NO_PROVIDERS: AiProvidersState = { providers: [], defaultProviderId: null }

const GENERATION = 7
const NOW = (): Date => new Date('2026-06-16T00:00:00.000Z')

const notFound = (): unknown => ({ kind: 'notFound', message: 'missing' })

/** In-memory graph: notes + descriptions by path, and assets by path. */
const files = new Map<string, string>()
const assets = new Map<string, string>()

beforeEach(() => {
  files.clear()
  assets.clear()
  vi.clearAllMocks()

  readManagedAssetDescriptionMock.mockImplementation(async (path: string) => {
    const value = files.get(descriptionPathFor(path))
    if (value === undefined) {
      return null
    }
    return value
  })
  writeDescriptionMock.mockImplementation(async (path: string, contents: string) => {
    files.set(descriptionPathFor(path), contents)
  })
  readManagedAssetMock.mockImplementation(async (path: string) => {
    const value = assets.get(path)
    if (value === undefined) {
      throw notFound()
    }
    return value
  })
  listDirMock.mockImplementation(async (dir: string) => {
    if (dir !== 'assets') {
      return []
    }
    return [...assets.entries()].map(([path, value]) => ({
      path,
      size: base64ByteLength(value),
      modifiedMs: 1, // epoch+1ms — far before any ISO `generatedAt`
    }))
  })
  assetPrivacySnapshotMock.mockImplementation(async () => ({
    revision: 1,
    notes: [...files.entries()]
      .filter(([path]) => isNotePath(path))
      .map(([path, source]) => ({ path, source })),
    attachments: [...assets.entries()].map(([path, value]) => ({
      path,
      size: base64ByteLength(value),
      modifiedMs: 1,
    })),
  }))
  getSecretMock.mockResolvedValue('sk-live')
  describeMock.mockResolvedValue('A flow diagram.')
})

/** A public note referencing `assetPath`. */
function publicNote(assetPath: string): string {
  return `---\nid: 01abcdefghjkmnpqrstvwxyz00\n---\n# Diagram\n\n![](${assetPath})\n`
}

/** A private note referencing `assetPath`. */
function privateNote(assetPath: string): string {
  return `---\nid: 01abcdefghjkmnpqrstvwxyz01\nprivate: true\n---\n\n![](${assetPath})\n`
}

function input(overrides: Partial<ReconcileAssetDescriptionsInput> = {}): ReconcileAssetDescriptionsInput {
  return {
    providers: PROVIDERS,
    generation: GENERATION,
    mode: 'incremental',
    changed: ['assets/a.png'],
    now: NOW,
    ...overrides,
  }
}

describe('pure helpers', () => {
  it('assetTypeFor maps eligible extensions and rejects the rest', () => {
    expect(assetTypeFor('assets/a.png')).toEqual({ kind: 'image', mediaType: 'image/png' })
    expect(assetTypeFor('assets/a.JPG')).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(assetTypeFor('assets/a.jpeg')).toEqual({ kind: 'image', mediaType: 'image/jpeg' })
    expect(assetTypeFor('assets/a.gif')).toEqual({ kind: 'image', mediaType: 'image/gif' })
    expect(assetTypeFor('assets/a.webp')).toEqual({ kind: 'image', mediaType: 'image/webp' })
    expect(assetTypeFor('assets/a.svg')).toEqual({ kind: 'svg', mediaType: 'image/svg+xml' })
    expect(assetTypeFor('assets/a.pdf')).toEqual({ kind: 'pdf', mediaType: 'application/pdf' })
    expect(assetTypeFor('assets/a.txt')).toBeNull()
    expect(assetTypeFor('notes/a.png')).toBeNull()
    expect(assetTypeFor('assets/a.png.reflect.md')).toBeNull() // never describe a description
    expect(assetTypeFor('assets/../secret.png')).toBeNull()
    expect(assetTypeFor('assets/.hidden/a.png')).toBeNull()
    expect(assetTypeFor('assets//a.png')).toBeNull()
    expect(assetTypeFor('assets/noext')).toBeNull()
  })

  it('isEligibleAssetPath and descriptionPathFor', () => {
    expect(isEligibleAssetPath('assets/a.png')).toBe(true)
    expect(isEligibleAssetPath('assets/a.png.reflect.md')).toBe(false)
    expect(descriptionPathFor('assets/a.png')).toBe('assets/a.png.reflect.md')
  })

  it('base64ByteLength matches the decoded size', () => {
    expect(base64ByteLength('aGVsbG8=')).toBe(5) // "hello"
    expect(base64ByteLength('')).toBe(0)
    expect(base64ByteLength('YWJjZA==')).toBe(4) // "abcd"
  })

  it('readManagedDescription recognizes managed files and rejects user-authored ones', async () => {
    const built = buildDescriptionSource(
      {
        source: 'assets/a.png',
        sourceHash: 'abc',
        sourceSize: 5,
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        generatedAt: '2026-06-16T00:00:00.000Z',
      },
      'A flow diagram.',
    )
    expect(readManagedDescription(built)).toEqual({
      sourcePath: 'assets/a.png',
      sourceHash: 'abc',
      sourceSize: 5,
      generatedAtMs: Date.parse('2026-06-16T00:00:00.000Z'),
    })
    expect(built).toContain('A flow diagram.')
    expect(built).toContain('source: assets/a.png')
    // A file the user wrote (no managed marker) is never claimed.
    expect(readManagedDescription('# My own notes about this image\n')).toBeNull()
    expect(readManagedDescription('---\ntitle: Hand written\n---\n\nbody\n')).toBeNull()
  })
})

describe('classifyAsset (privacy gate)', () => {
  it('sends when referenced only by public notes', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('send')
    expect(assetPrivacySnapshotMock).toHaveBeenCalledWith(GENERATION)
  })

  it('blocks when any referer is private', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    files.set('notes/secret.md', privateNote('assets/a.png'))
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-private')
  })

  it('blocks when a private referer uses Obsidian wiki-embed syntax', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    files.set(
      'notes/secret.md',
      '---\nid: 01abcdefghjkmnpqrstvwxyz01\nprivate: true\n---\n\n![[assets/a.png]]\n',
    )

    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-private')
  })

  it('skips when unreferenced', async () => {
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-unreferenced')
  })

  it('uses the live body rather than stale derived reference rows', async () => {
    files.set('notes/stale.md', '# Moved on\n\nno image here\n')
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-unreferenced')
  })

  it('fails closed when a listed live note cannot be read', async () => {
    assetPrivacySnapshotMock.mockRejectedValueOnce(new ReflectError('io', 'disk error'))
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-private')
  })

  it('fails closed when the generation-pinned attachment catalog is unavailable', async () => {
    files.set('notes/pub.md', publicNote('assets/a.png'))
    assetPrivacySnapshotMock.mockRejectedValueOnce(new ReflectError('io', 'catalog error'))

    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-private')
  })

  it('ignores a deleted note regardless of stale derived reference rows', async () => {
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-unreferenced')
  })
})

describe('reconcileAssetDescriptions', () => {
  it('describes a public asset and writes a managed, generation-pinned description', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.described).toBe(1)
    expect(outcome.describedAssetPaths).toEqual(['assets/a.png'])
    expect(outcome.stopped).toBeNull()
    const hash = await hashContent('aGVsbG8=')
    const written = files.get('assets/a.png.reflect.md')!
    expect(readManagedDescription(written)).toMatchObject({ sourceHash: hash })
    expect(written).toContain('A flow diagram.')
    expect(written).toContain('provider: anthropic')
    expect(written).toContain('generatedAt: 2026-06-16T00:00:00.000Z')
    expect(writeDescriptionMock).toHaveBeenCalledWith('assets/a.png', expect.any(String), GENERATION)
  })

  it('skips an up-to-date managed description without calling the provider', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    const hash = await hashContent('aGVsbG8=')
    files.set(
      'assets/a.png.reflect.md',
      buildDescriptionSource(
        { source: 'assets/a.png', sourceHash: hash, sourceSize: 5, provider: 'anthropic', model: 'm', generatedAt: 'x' },
        'old',
      ),
    )

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.skippedUpToDate).toBe(1)
    expect(outcome.described).toBe(0)
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('re-reads and rehashes a same-size replacement instead of trusting mtime/size', async () => {
    // A `cp -p`-style replacement: same byte size, mtime not advanced, different
    // content. The hash differs, so it must be re-described — never stat-skipped.
    assets.set('assets/a.png', 'Ym9keTI=') // "body2", 5 bytes
    files.set('notes/pub.md', publicNote('assets/a.png'))
    files.set(
      'assets/a.png.reflect.md',
      buildDescriptionSource(
        {
          source: 'assets/a.png',
          sourceHash: 'stale-hash-of-the-old-5-byte-file',
          sourceSize: 5, // same size as the new bytes
          provider: 'anthropic',
          model: 'm',
          generatedAt: '2026-06-16T00:00:00.000Z', // at/after the stat mtime
        },
        'old description',
      ),
    )

    const outcome = await reconcileAssetDescriptions(input())

    expect(readManagedAssetMock).toHaveBeenCalled() // the bytes are read + rehashed
    expect(outcome.described).toBe(1) // hash differs → re-described, not skipped
    expect(outcome.skippedUpToDate).toBe(0)
  })

  it('regenerates a managed description when the source hash changed', async () => {
    assets.set('assets/a.png', 'bmV3Qnl0ZXM=') // different bytes
    files.set('notes/pub.md', publicNote('assets/a.png'))
    files.set(
      'assets/a.png.reflect.md',
      buildDescriptionSource(
        { source: 'assets/a.png', sourceHash: 'oldhash', sourceSize: 5, provider: 'anthropic', model: 'm', generatedAt: 'x' },
        'old',
      ),
    )

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.described).toBe(1)
    expect(files.get('assets/a.png.reflect.md')).toContain('A flow diagram.')
  })

  it('never overwrites a user-authored description', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    files.set('assets/a.png.reflect.md', '# My own caption\n')

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.skippedUserAuthored).toBe(1)
    expect(outcome.described).toBe(0)
    expect(files.get('assets/a.png.reflect.md')).toBe('# My own caption\n')
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('blocks a newly private reference absent from every derived index row', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/secret.md', privateNote('assets/a.png'))

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.skippedPrivate).toBe(1)
    expect(outcome.described).toBe(0)
    expect(getSecretMock).not.toHaveBeenCalled()
    expect(readManagedAssetMock).not.toHaveBeenCalled()
    expect(describeMock).not.toHaveBeenCalled()
    expect(writeDescriptionMock).not.toHaveBeenCalled()
    expect(files.has('assets/a.png.reflect.md')).toBe(false)
  })

  it('never reaches the provider or output when a managed sidecar or asset read is unsafe', async () => {
    for (const unsafe of ['sidecar', 'asset'] as const) {
      vi.clearAllMocks()
      assets.set('assets/a.png', 'aGVsbG8=')
      files.set('notes/pub.md', publicNote('assets/a.png'))
      getSecretMock.mockResolvedValue('sk-live')
      describeMock.mockResolvedValue('must not be emitted')
      if (unsafe === 'sidecar') {
        readManagedAssetDescriptionMock.mockRejectedValueOnce(
          new ReflectError('traversal', 'symlinked sidecar'),
        )
      } else {
        readManagedAssetMock.mockRejectedValueOnce(
          new ReflectError('traversal', 'symlinked asset'),
        )
      }

      const outcome = await reconcileAssetDescriptions(input())

      expect(outcome.described).toBe(0)
      expect(outcome.stopped?.reason).toBe('traversal')
      expect(describeMock).not.toHaveBeenCalled()
      expect(writeDescriptionMock).not.toHaveBeenCalled()
    }
  })

  it('skips an unreferenced asset', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.skippedUnreferenced).toBe(1)
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('never reads an asset until a non-private note is associated (gate before attempt)', async () => {
    assets.set('assets/secret.png', 'aGVsbG8=')
    assets.set('assets/orphan.png', 'aGVsbG8=')
    files.set('notes/secret.md', privateNote('assets/secret.png'))

    const outcome = await reconcileAssetDescriptions(
      input({ changed: ['assets/secret.png', 'assets/orphan.png'] }),
    )

    expect(outcome.skippedPrivate).toBe(1)
    expect(outcome.skippedUnreferenced).toBe(1)
    expect(readManagedAssetDescriptionMock).not.toHaveBeenCalled()
    expect(getSecretMock).not.toHaveBeenCalled()
    expect(readManagedAssetMock).not.toHaveBeenCalled() // bytes never touched
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('classifies a ten-asset reconcile batch with one live graph scan', async () => {
    const paths = Array.from({ length: 10 }, (_, index) => `assets/${index}.png`)
    for (const path of paths) {
      assets.set(path, 'aGVsbG8=')
    }
    files.set(
      'Projects/all-assets.md',
      paths.map((path) => `![](../${path})`).join('\n'),
    )

    const outcome = await reconcileAssetDescriptions(input({ changed: paths }))

    expect(outcome.described).toBe(10)
    expect(assetPrivacySnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('blocks the whole reconcile batch before sidecars, bytes, or providers when a note is unavailable', async () => {
    const paths = ['assets/a.png', 'assets/b.png']
    for (const path of paths) {
      assets.set(path, 'aGVsbG8=')
    }

    for (const unavailable of ['placeholder', 'missing'] as const) {
      vi.clearAllMocks()
      getSecretMock.mockResolvedValue('sk-live')
      describeMock.mockResolvedValue('A flow diagram.')
      assetPrivacySnapshotMock.mockRejectedValueOnce(
        new ReflectError('notFound', `${unavailable} note unavailable`),
      )

      const outcome = await reconcileAssetDescriptions(input({ changed: paths }))

      expect(outcome.skippedPrivate).toBe(2)
      expect(outcome.described).toBe(0)
      expect(readManagedAssetDescriptionMock).not.toHaveBeenCalled()
      expect(getSecretMock).not.toHaveBeenCalled()
      expect(readManagedAssetMock).not.toHaveBeenCalled()
      expect(describeMock).not.toHaveBeenCalled()
      expect(writeDescriptionMock).not.toHaveBeenCalled()
    }
  })

  it('logs a permanent refusal and writes no description, continuing the pass', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    assets.set('assets/b.pdf', 'JVBERg==')
    files.set(
      'notes/pub.md',
      '---\nid: 01abcdefghjkmnpqrstvwxyz00\n---\n# Both\n\n![](assets/a.png)\n![](assets/b.pdf)\n',
    )
    describeMock
      .mockRejectedValueOnce(new AssetDescriptionRejectedError('unsupported'))
      .mockResolvedValueOnce('A PDF.')

    const outcome = await reconcileAssetDescriptions(input({ changed: ['assets/a.png', 'assets/b.pdf'] }))

    expect(outcome.refused).toBe(1)
    expect(outcome.described).toBe(1)
    expect(outcome.stopped).toBeNull()
    expect(files.has('assets/a.png.reflect.md')).toBe(false)
    expect(files.has('assets/b.pdf.reflect.md')).toBe(true)
  })

  it('stops the pass on a transient (network) provider error for a later retry', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    describeMock.mockRejectedValueOnce(new ReflectError('network', 'offline'))

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.stopped).toEqual({ reason: 'network', message: 'offline' })
    expect(outcome.described).toBe(0)
    expect(files.has('assets/a.png.reflect.md')).toBe(false)
  })

  it('stops with a config reason when no provider is configured', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))

    const outcome = await reconcileAssetDescriptions(input({ providers: NO_PROVIDERS }))

    expect(outcome.stopped?.reason).toBe('config')
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('stops with a config reason when the API key is missing from the keychain', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    getSecretMock.mockRejectedValue(new Error('no key'))

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.stopped?.reason).toBe('config')
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('aborts before processing when the graph session ends', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))

    const outcome = await reconcileAssetDescriptions(input({ isStale: () => true }))

    expect(outcome.stopped?.reason).toBe('stale')
    expect(outcome.described).toBe(0)
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('backfill enumerates every eligible asset and reports progress', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    assets.set('assets/b.pdf', 'JVBERg==')
    assets.set('assets/notes.txt', 'aGk=') // ineligible — never listed as a candidate
    files.set(
      'notes/pub.md',
      '---\nid: 01abcdefghjkmnpqrstvwxyz00\n---\n# Both\n\n![](assets/a.png)\n![](assets/b.pdf)\n',
    )
    const progress: Array<[number, number]> = []

    const outcome = await reconcileAssetDescriptions(
      // `changed` is ignored in backfill mode — listDir enumerates the candidates.
      input({ mode: 'backfill', onProgress: (done, total) => void progress.push([done, total]) }),
    )

    expect(outcome.pending).toBe(2)
    expect(outcome.described).toBe(2)
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ])
  })
})
