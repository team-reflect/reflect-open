import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileMeta } from '../graph/schemas'
import { describeAsset } from '../ai/describe-asset'
import { getSecret } from '../secrets/keychain'
import { listDir, listFiles, readAsset, readNote, writeNote } from '../graph/commands'
import {
  assetDescriptionSidecarPath,
  assetPathFromDescriptionSidecar,
  isDescribableAssetPath,
  parseAssetDescriptionSidecarMeta,
  reconcileAssetDescriptions,
} from './asset-description'
import { subscribeFileChanges, type FileChange } from '../indexing/file-changes'
import { setBridge } from '../ipc/bridge'

vi.mock('../graph/commands', () => ({
  listDir: vi.fn(),
  listFiles: vi.fn(),
  readAsset: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))

vi.mock('../secrets/keychain', () => ({
  getSecret: vi.fn(),
}))

vi.mock('../ai/describe-asset', () => ({
  describeAsset: vi.fn(),
  isAssetDescriptionRejected: (value: unknown) =>
    value instanceof Error && value.name === 'AssetDescriptionRejectedError',
}))

const listDirMock = vi.mocked(listDir)
const listFilesMock = vi.mocked(listFiles)
const readAssetMock = vi.mocked(readAsset)
const readNoteMock = vi.mocked(readNote)
const writeNoteMock = vi.mocked(writeNote)
const getSecretMock = vi.mocked(getSecret)
const describeAssetMock = vi.mocked(describeAsset)

afterEach(() => {
  setBridge(null)
})

const PROVIDERS = {
  providers: [{ id: 'cfg-openai', provider: 'openai' as const, model: 'gpt-5.5', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}

function file(path: string, size = 5): FileMeta {
  return { path, size, modifiedMs: 1 }
}

function encoded(value: string): string {
  return Buffer.from(value).toString('base64')
}

function note(source: string, path = 'notes/source.md'): FileMeta & { source: string } {
  return { ...file(path), source }
}

function setupNotes(entries: Array<FileMeta & { source: string }>): void {
  listFilesMock.mockResolvedValue(entries)
  readNoteMock.mockImplementation(async (path) => {
    const found = entries.find((entry) => entry.path === path)
    if (found) {
      return found.source
    }
    throw { kind: 'notFound', message: 'missing' }
  })
}

describe('asset description helpers', () => {
  it('names adjacent sidecars and detects supported source assets', () => {
    expect(assetDescriptionSidecarPath('assets/photo.png')).toBe('assets/photo.png.reflect.md')
    expect(assetPathFromDescriptionSidecar('assets/photo.png.reflect.md')).toBe('assets/photo.png')
    expect(assetPathFromDescriptionSidecar('assets/movie.mov.reflect.md')).toBeNull()
    expect(isDescribableAssetPath('assets/photo.png')).toBe(true)
    expect(isDescribableAssetPath('assets/report.pdf')).toBe(true)
    expect(isDescribableAssetPath('assets/photo.png.reflect.md')).toBe(false)
    expect(isDescribableAssetPath('notes/photo.png')).toBe(false)
    expect(isDescribableAssetPath('assets/movie.mov')).toBe(false)
  })

  it('parses managed sidecar frontmatter', () => {
    const meta = parseAssetDescriptionSidecarMeta(
      [
        '---',
        'reflectAssetDescription: 1',
        'source: assets/photo.png',
        'sourceHash: abc',
        'sourceSize: 5',
        'provider: openai',
        'model: gpt-5.5',
        'generatedAt: "2026-06-16T00:00:00.000Z"',
        '---',
        '',
        'body',
      ].join('\n'),
    )

    expect(meta).toMatchObject({ source: 'assets/photo.png', sourceHash: 'abc' })
    expect(parseAssetDescriptionSidecarMeta('# user file')).toBeNull()
  })
})

describe('reconcileAssetDescriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setBridge({ invoke: vi.fn(), listen: async () => () => {} })
    getSecretMock.mockResolvedValue('sk-live')
    readAssetMock.mockResolvedValue(encoded('image'))
    writeNoteMock.mockResolvedValue(undefined)
    describeAssetMock.mockResolvedValue('A generated description.')
    listDirMock.mockResolvedValue([file('assets/photo.png')])
    setupNotes([note('![photo](assets/photo.png)')])
  })

  it('describes a public referenced asset and writes a managed sidecar', async () => {
    const changes: FileChange[][] = []
    const unlisten = await subscribeFileChanges((batch) => changes.push(batch))
    const outcome = await reconcileAssetDescriptions({
      providers: PROVIDERS,
      generation: 3,
      assetPaths: ['assets/photo.png'],
    })
    unlisten()

    expect(outcome).toMatchObject({ considered: 1, described: 1, stopped: null })
    expect(describeAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'assets/photo.png',
        mediaType: 'image/png',
      }),
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      'assets/photo.png.reflect.md',
      expect.stringContaining('A generated description.'),
      3,
    )
    const sidecar = writeNoteMock.mock.calls[0]?.[1]
    expect(sidecar).toContain('reflectAssetDescription: 1')
    expect(sidecar).toContain('source: assets/photo.png')
    expect(changes).toEqual([
      [expect.objectContaining({ path: 'assets/photo.png.reflect.md', kind: 'upsert' })],
    ])
  })

  it('skips private, mixed, and unreferenced assets before provider calls', async () => {
    setupNotes([
      note('![public](assets/public.png)', 'notes/public.md'),
      note('---\nprivate: true\n---\n![secret](assets/private.png)', 'notes/private.md'),
      note('![mixed](assets/mixed.png)', 'notes/mixed-public.md'),
      note('---\nprivate: true\n---\n![mixed](assets/mixed.png)', 'notes/mixed-private.md'),
    ])

    const outcome = await reconcileAssetDescriptions({
      providers: PROVIDERS,
      generation: 3,
      assetPaths: [
        'assets/public.png',
        'assets/private.png',
        'assets/mixed.png',
        'assets/unreferenced.png',
      ],
    })

    expect(outcome.skipped.private).toBe(2)
    expect(outcome.skipped.unreferenced).toBe(1)
    expect(describeAssetMock).toHaveBeenCalledTimes(1)
    expect(describeAssetMock).toHaveBeenCalledWith(expect.objectContaining({ path: 'assets/public.png' }))
  })

  it('does not overwrite an unmanaged sidecar', async () => {
    readNoteMock.mockImplementation(async (path) => {
      if (path === 'notes/source.md') {
        return '![photo](assets/photo.png)'
      }
      if (path === 'assets/photo.png.reflect.md') {
        return '# user sidecar\n'
      }
      throw { kind: 'notFound', message: 'missing' }
    })

    const outcome = await reconcileAssetDescriptions({
      providers: PROVIDERS,
      generation: 3,
      assetPaths: ['assets/photo.png'],
    })

    expect(outcome.skipped.unmanagedSidecar).toBe(1)
    expect(describeAssetMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('rewrites a stale managed sidecar', async () => {
    readNoteMock.mockImplementation(async (path) => {
      if (path === 'notes/source.md') {
        return '![photo](assets/photo.png)'
      }
      if (path === 'assets/photo.png.reflect.md') {
        return [
          '---',
          'reflectAssetDescription: 1',
          'source: assets/photo.png',
          'sourceHash: old',
          'sourceSize: 5',
          'provider: openai',
          'model: gpt-5.4',
          'generatedAt: "2026-06-16T00:00:00.000Z"',
          '---',
          '',
          'old description',
        ].join('\n')
      }
      throw { kind: 'notFound', message: 'missing' }
    })

    const outcome = await reconcileAssetDescriptions({
      providers: PROVIDERS,
      generation: 3,
      assetPaths: ['assets/photo.png'],
    })

    expect(outcome.described).toBe(1)
    expect(writeNoteMock).toHaveBeenCalledTimes(1)
  })

  it('manual backfill scans assets only when assetPaths is omitted', async () => {
    await reconcileAssetDescriptions({ providers: PROVIDERS, generation: 3 })

    expect(listDirMock).toHaveBeenCalledWith('assets', 3)
    expect(describeAssetMock).toHaveBeenCalledTimes(1)
  })
})
