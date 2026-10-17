import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AppError } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { createTestNoteFileService, type TestNoteFileService } from '../testing/index.ts'
import {
  createAssetDescriptionText,
  MAX_ASSET_TEXT_CHARS,
  type AssetDescriptionText,
} from './asset-description-text.ts'

let noteFile: TestNoteFileService
let readNoteMock: MockInstance<NoteFileService['readLocal']>
let assetText: AssetDescriptionText

beforeEach(() => {
  noteFile = createTestNoteFileService()
  readNoteMock = vi.spyOn(noteFile, 'readLocal')
  assetText = createAssetDescriptionText({ noteFile })
})

describe('AssetDescriptionText.gatherText', () => {
  it('returns empty for no assets', async () => {
    expect(await assetText.gatherText([], 1)).toBe('')
  })

  it('reads each asset description body, stripping frontmatter, joined', async () => {
    noteFile.set(
      'assets/a.png.reflect.md',
      '---\nreflectAsset: true\nsource: assets/a.png\n---\n\nA flow diagram of the pipeline.\n',
    )
    noteFile.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nQ4 revenue report.\n')

    const text = await assetText.gatherText(['assets/a.png', 'assets/b.pdf'], 1)

    expect(text).toBe('A flow diagram of the pipeline.\n\nQ4 revenue report.')
    expect(text).not.toContain('reflectAsset')
  })

  it('skips assets with no description file', async () => {
    noteFile.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nDescribed.\n')
    // assets/b.pdf has no description yet
    expect(await assetText.gatherText(['assets/a.png', 'assets/b.pdf'], 1)).toBe('Described.')
  })

  it('folds an asset referenced twice only once', async () => {
    noteFile.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nOnce.\n')
    expect(await assetText.gatherText(['assets/a.png', 'assets/a.png'], 1)).toBe('Once.')
    expect(readNoteMock).toHaveBeenCalledTimes(1)
  })

  it('also folds a user-authored description file (no managed marker)', async () => {
    noteFile.set(
      'assets/a.png.reflect.md',
      '# My own caption\n\nHand-written notes about this image.\n',
    )
    const text = await assetText.gatherText(['assets/a.png'], 1)
    expect(text).toContain('Hand-written notes about this image.')
  })

  it('caps the combined text', async () => {
    noteFile.set('assets/a.png.reflect.md', 'x'.repeat(MAX_ASSET_TEXT_CHARS + 5_000))
    const text = await assetText.gatherText(['assets/a.png'], 1)
    expect(text.length).toBe(MAX_ASSET_TEXT_CHARS)
  })

  it('skips an iCloud-evicted description instead of forcing a download', async () => {
    noteFile.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nStill local.\n')
    noteFile.set('assets/a.png.reflect.md', 'Not local.')
    noteFile.evict('assets/a.png.reflect.md')
    const text = await assetText.gatherText(['assets/a.png', 'assets/b.pdf'], 1)
    expect(text).toBe('Still local.')
  })

  it('propagates a non-notFound read error', async () => {
    readNoteMock.mockRejectedValueOnce(new AppError('io', 'disk error'))
    await expect(assetText.gatherText(['assets/a.png'], 1)).rejects.toMatchObject({ kind: 'io' })
  })
})

describe('AssetDescriptionText.gatherBodies', () => {
  it('returns per-asset bodies attributed to their asset paths', async () => {
    noteFile.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nA flow diagram.\n')
    noteFile.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nQ4 revenue report.\n')

    const { bodies, evicted } = await assetText.gatherBodies(['assets/a.png', 'assets/b.pdf'], 1)

    expect(bodies).toEqual([
      { assetPath: 'assets/a.png', body: 'A flow diagram.' },
      { assetPath: 'assets/b.pdf', body: 'Q4 revenue report.' },
    ])
    expect(evicted).toEqual([])
  })

  it('skips missing descriptions, empty bodies, and repeated assets', async () => {
    noteFile.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nDescribed.\n')
    noteFile.set('assets/empty.png.reflect.md', '---\nreflectAsset: true\n---\n\n  \n')

    const { bodies } = await assetText.gatherBodies(
      ['assets/a.png', 'assets/a.png', 'assets/empty.png', 'assets/missing.pdf'],
      1,
    )

    expect(bodies).toEqual([{ assetPath: 'assets/a.png', body: 'Described.' }])
    expect(readNoteMock).toHaveBeenCalledTimes(3) // the repeat never re-reads
  })

  it('stops accumulating once the combined length reaches the cap', async () => {
    noteFile.set('assets/a.png.reflect.md', 'x'.repeat(MAX_ASSET_TEXT_CHARS))
    noteFile.set('assets/b.png.reflect.md', 'never reached')

    const { bodies } = await assetText.gatherBodies(['assets/a.png', 'assets/b.png'], 1)

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.assetPath).toBe('assets/a.png')
  })

  it('reports an evicted sidecar so full-replace consumers can skip the write', async () => {
    noteFile.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nStill local.\n')
    noteFile.set('assets/a.png.reflect.md', 'Not local.')
    noteFile.evict('assets/a.png.reflect.md')

    const { bodies, evicted } = await assetText.gatherBodies(['assets/a.png', 'assets/b.pdf'], 1)

    expect(bodies).toEqual([{ assetPath: 'assets/b.pdf', body: 'Still local.' }])
    expect(evicted).toEqual(['assets/a.png'])
  })
})
