import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssetDescriptionRejectedError, describeAsset } from '../ai/describe-asset'
import type { AiProvidersState } from '../ai/provider-config'
import { ReflectError } from '../errors'
import { listDir, readAsset, readNote, writeNote } from '../graph/commands'
import { assetReferencingNotePaths } from '../indexing/asset-refs'
import { hashContent } from '../indexing/hash'
import { getSecret } from '../secrets/keychain'
import { descriptionPathFor } from '../graph/paths'
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
  listDir: vi.fn(),
  readAsset: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('../indexing/asset-refs', () => ({
  assetReferencingNotePaths: vi.fn(),
}))
vi.mock('../secrets/keychain', () => ({
  getSecret: vi.fn(),
}))
vi.mock('../ai/describe-asset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/describe-asset')>()),
  describeAsset: vi.fn(),
}))

const listDirMock = vi.mocked(listDir)
const readAssetMock = vi.mocked(readAsset)
const readNoteMock = vi.mocked(readNote)
const writeNoteMock = vi.mocked(writeNote)
const assetRefsMock = vi.mocked(assetReferencingNotePaths)
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

/** In-memory graph: notes + descriptions by path, assets by path, and the index refs. */
const files = new Map<string, string>()
const assets = new Map<string, string>()
const refs = new Map<string, string[]>()

beforeEach(() => {
  files.clear()
  assets.clear()
  refs.clear()
  vi.clearAllMocks()

  readNoteMock.mockImplementation(async (path: string) => {
    const value = files.get(path)
    if (value === undefined) {
      throw notFound()
    }
    return value
  })
  writeNoteMock.mockImplementation(async (path: string, contents: string) => {
    files.set(path, contents)
  })
  readAssetMock.mockImplementation(async (path: string) => {
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
  assetRefsMock.mockImplementation(async (assetPath: string) => refs.get(assetPath) ?? [])
  getSecretMock.mockResolvedValue('sk-live')
  describeMock.mockResolvedValue('A flow diagram.')
})

/** A public note referencing `assetPath`. */
function publicNote(assetPath: string): string {
  return `# Diagram\n\n![](${assetPath})\n`
}

/** A private note referencing `assetPath`. */
function privateNote(assetPath: string): string {
  return `---\nprivate: true\n---\n\n![](${assetPath})\n`
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
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('send')
  })

  it('blocks when any referer is private', async () => {
    files.set('notes/pub.md', publicNote('assets/a.png'))
    files.set('notes/secret.md', privateNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md', 'notes/secret.md'])
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-private')
  })

  it('skips when unreferenced', async () => {
    refs.set('assets/a.png', [])
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-unreferenced')
  })

  it('ignores a stale index referer whose live body no longer references the asset', async () => {
    files.set('notes/stale.md', '# Moved on\n\nno image here\n')
    refs.set('assets/a.png', ['notes/stale.md'])
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-unreferenced')
  })

  it('fails closed when a referer cannot be read', async () => {
    readNoteMock.mockRejectedValueOnce(new ReflectError('io', 'disk error'))
    refs.set('assets/a.png', ['notes/pub.md'])
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-private')
  })

  it('treats a deleted referer (notFound) as not a live referer', async () => {
    refs.set('assets/a.png', ['notes/gone.md']) // never seeded → readNote throws notFound
    expect(await classifyAsset('assets/a.png', GENERATION)).toBe('skip-unreferenced')
  })
})

describe('reconcileAssetDescriptions', () => {
  it('describes a public asset and writes a managed, generation-pinned description', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])

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
    expect(writeNoteMock).toHaveBeenCalledWith('assets/a.png.reflect.md', expect.any(String), GENERATION)
  })

  it('skips an up-to-date managed description without calling the provider', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])
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
    refs.set('assets/a.png', ['notes/pub.md'])
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

    expect(readAssetMock).toHaveBeenCalled() // the bytes are read + rehashed
    expect(outcome.described).toBe(1) // hash differs → re-described, not skipped
    expect(outcome.skippedUpToDate).toBe(0)
  })

  it('regenerates a managed description when the source hash changed', async () => {
    assets.set('assets/a.png', 'bmV3Qnl0ZXM=') // different bytes
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])
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
    refs.set('assets/a.png', ['notes/pub.md'])
    files.set('assets/a.png.reflect.md', '# My own caption\n')

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.skippedUserAuthored).toBe(1)
    expect(outcome.described).toBe(0)
    expect(files.get('assets/a.png.reflect.md')).toBe('# My own caption\n')
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('blocks an asset referenced by a private note', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/secret.md', privateNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/secret.md'])

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.skippedPrivate).toBe(1)
    expect(outcome.described).toBe(0)
    expect(describeMock).not.toHaveBeenCalled()
    expect(files.has('assets/a.png.reflect.md')).toBe(false)
  })

  it('skips an unreferenced asset', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    refs.set('assets/a.png', [])

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.skippedUnreferenced).toBe(1)
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('never reads an asset until a non-private note is associated (gate before attempt)', async () => {
    assets.set('assets/secret.png', 'aGVsbG8=')
    assets.set('assets/orphan.png', 'aGVsbG8=')
    files.set('notes/secret.md', privateNote('assets/secret.png'))
    refs.set('assets/secret.png', ['notes/secret.md']) // referenced only by a private note
    refs.set('assets/orphan.png', []) // referenced by nothing

    const outcome = await reconcileAssetDescriptions(
      input({ changed: ['assets/secret.png', 'assets/orphan.png'] }),
    )

    expect(outcome.skippedPrivate).toBe(1)
    expect(outcome.skippedUnreferenced).toBe(1)
    expect(readAssetMock).not.toHaveBeenCalled() // bytes never touched
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('logs a permanent refusal and writes no description, continuing the pass', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    assets.set('assets/b.pdf', 'JVBERg==')
    files.set('notes/pub.md', `# Both\n\n![](assets/a.png)\n![](assets/b.pdf)\n`)
    refs.set('assets/a.png', ['notes/pub.md'])
    refs.set('assets/b.pdf', ['notes/pub.md'])
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
    refs.set('assets/a.png', ['notes/pub.md'])
    describeMock.mockRejectedValueOnce(new ReflectError('network', 'offline'))

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.stopped).toEqual({ reason: 'network', message: 'offline' })
    expect(outcome.described).toBe(0)
    expect(files.has('assets/a.png.reflect.md')).toBe(false)
  })

  it('stops with a config reason when no provider is configured', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    refs.set('assets/a.png', ['notes/pub.md'])

    const outcome = await reconcileAssetDescriptions(input({ providers: NO_PROVIDERS }))

    expect(outcome.stopped?.reason).toBe('config')
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('stops with a config reason when the API key is missing from the keychain', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    refs.set('assets/a.png', ['notes/pub.md'])
    getSecretMock.mockRejectedValue(new Error('no key'))

    const outcome = await reconcileAssetDescriptions(input())

    expect(outcome.stopped?.reason).toBe('config')
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('aborts before processing when the graph session ends', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    files.set('notes/pub.md', publicNote('assets/a.png'))
    refs.set('assets/a.png', ['notes/pub.md'])

    const outcome = await reconcileAssetDescriptions(input({ isStale: () => true }))

    expect(outcome.stopped?.reason).toBe('stale')
    expect(outcome.described).toBe(0)
    expect(describeMock).not.toHaveBeenCalled()
  })

  it('backfill enumerates every eligible asset and reports progress', async () => {
    assets.set('assets/a.png', 'aGVsbG8=')
    assets.set('assets/b.pdf', 'JVBERg==')
    assets.set('assets/notes.txt', 'aGk=') // ineligible — never listed as a candidate
    files.set('notes/pub.md', `# Both\n\n![](assets/a.png)\n![](assets/b.pdf)\n`)
    refs.set('assets/a.png', ['notes/pub.md'])
    refs.set('assets/b.pdf', ['notes/pub.md'])
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
