import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readManagedAssetDescription } from '../graph/commands'
import {
  gatherAssetDescriptionBodies,
  gatherAssetDescriptionText,
  MAX_ASSET_TEXT_CHARS,
} from './asset-description-text'

vi.mock('../graph/commands', () => ({
  readManagedAssetDescription: vi.fn(),
}))

const readDescriptionMock = vi.mocked(readManagedAssetDescription)

/** Description files keyed by their `.reflect.md` path. */
const files = new Map<string, string>()

beforeEach(() => {
  files.clear()
  vi.clearAllMocks()
  readDescriptionMock.mockImplementation(async (path: string) =>
    files.get(`${path}.reflect.md`) ?? null,
  )
})

describe('gatherAssetDescriptionText', () => {
  it('returns empty for no assets', async () => {
    expect(await gatherAssetDescriptionText([])).toBe('')
  })

  it('ignores index sentinels, imported paths, and unsupported managed files', async () => {
    const text = await gatherAssetDescriptionText([
      ':reflect:attachment-basename:a.png',
      'Media/a.png',
      'assets/audio.mp3',
      'assets/readme.txt',
      'assets/../secret.png',
    ])

    expect(text).toBe('')
    expect(readDescriptionMock).not.toHaveBeenCalled()
  })

  it('reads each asset description body, stripping frontmatter, joined', async () => {
    files.set(
      'assets/a.png.reflect.md',
      '---\nreflectAsset: true\nsource: assets/a.png\n---\n\nA flow diagram of the pipeline.\n',
    )
    files.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nQ4 revenue report.\n')

    const text = await gatherAssetDescriptionText(['assets/a.png', 'assets/b.pdf'])

    expect(text).toBe('A flow diagram of the pipeline.\n\nQ4 revenue report.')
    expect(text).not.toContain('reflectAsset')
  })

  it('skips assets with no description file', async () => {
    files.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nDescribed.\n')
    // assets/b.pdf has no description yet
    expect(await gatherAssetDescriptionText(['assets/a.png', 'assets/b.pdf'])).toBe('Described.')
  })

  it('folds an asset referenced twice only once', async () => {
    files.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nOnce.\n')
    expect(await gatherAssetDescriptionText(['assets/a.png', 'assets/a.png'])).toBe('Once.')
    expect(readDescriptionMock).toHaveBeenCalledTimes(1)
  })

  it('also folds a user-authored description file (no managed marker)', async () => {
    files.set('assets/a.png.reflect.md', '# My own caption\n\nHand-written notes about this image.\n')
    const text = await gatherAssetDescriptionText(['assets/a.png'])
    expect(text).toContain('Hand-written notes about this image.')
  })

  it('caps the combined text', async () => {
    files.set('assets/a.png.reflect.md', 'x'.repeat(MAX_ASSET_TEXT_CHARS + 5_000))
    const text = await gatherAssetDescriptionText(['assets/a.png'])
    expect(text.length).toBe(MAX_ASSET_TEXT_CHARS)
  })

  it('propagates a non-notFound read error', async () => {
    readDescriptionMock.mockRejectedValueOnce({ kind: 'io', message: 'disk error' })
    await expect(gatherAssetDescriptionText(['assets/a.png'])).rejects.toMatchObject({ kind: 'io' })
  })
})

describe('gatherAssetDescriptionBodies', () => {
  it('pins managed description reads to the caller generation', async () => {
    files.set('assets/a.png.reflect.md', 'Pinned description.\n')

    await gatherAssetDescriptionBodies(['assets/a.png'], 7)

    expect(readDescriptionMock).toHaveBeenCalledWith('assets/a.png', 7)
  })

  it('returns per-asset bodies attributed to their asset paths', async () => {
    files.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nA flow diagram.\n')
    files.set('assets/b.pdf.reflect.md', '---\nreflectAsset: true\n---\n\nQ4 revenue report.\n')

    const bodies = await gatherAssetDescriptionBodies(['assets/a.png', 'assets/b.pdf'])

    expect(bodies).toEqual([
      { assetPath: 'assets/a.png', body: 'A flow diagram.' },
      { assetPath: 'assets/b.pdf', body: 'Q4 revenue report.' },
    ])
  })

  it('skips missing descriptions, empty bodies, and repeated assets', async () => {
    files.set('assets/a.png.reflect.md', '---\nreflectAsset: true\n---\n\nDescribed.\n')
    files.set('assets/empty.png.reflect.md', '---\nreflectAsset: true\n---\n\n  \n')

    const bodies = await gatherAssetDescriptionBodies([
      'assets/a.png',
      'assets/a.png',
      'assets/empty.png',
      'assets/missing.pdf',
    ])

    expect(bodies).toEqual([{ assetPath: 'assets/a.png', body: 'Described.' }])
    expect(readDescriptionMock).toHaveBeenCalledTimes(3) // the repeat never re-reads
  })

  it('stops accumulating once the combined length reaches the cap', async () => {
    files.set('assets/a.png.reflect.md', 'x'.repeat(MAX_ASSET_TEXT_CHARS))
    files.set('assets/b.png.reflect.md', 'never reached')

    const bodies = await gatherAssetDescriptionBodies(['assets/a.png', 'assets/b.png'])

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.assetPath).toBe('assets/a.png')
  })
})
