import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readNote } from '../graph/commands'
import {
  gatherAssetDescriptionBodies,
  gatherAssetDescriptionText,
  MAX_ASSET_TEXT_CHARS,
} from './asset-description-text'

vi.mock('../graph/commands', () => ({
  readNote: vi.fn(),
}))

const readNoteMock = vi.mocked(readNote)

const notFound = (): unknown => ({ kind: 'notFound', message: 'missing' })

/** Description files keyed by their `.reflect.md` path. */
const files = new Map<string, string>()

beforeEach(() => {
  files.clear()
  vi.clearAllMocks()
  readNoteMock.mockImplementation(async (path: string) => {
    const value = files.get(path)
    if (value === undefined) {
      throw notFound()
    }
    return value
  })
})

describe('gatherAssetDescriptionText', () => {
  it('returns empty for no assets', async () => {
    expect(await gatherAssetDescriptionText([])).toBe('')
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
    expect(readNoteMock).toHaveBeenCalledTimes(1)
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
    readNoteMock.mockRejectedValueOnce({ kind: 'io', message: 'disk error' })
    await expect(gatherAssetDescriptionText(['assets/a.png'])).rejects.toMatchObject({ kind: 'io' })
  })
})

describe('gatherAssetDescriptionBodies', () => {
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
    expect(readNoteMock).toHaveBeenCalledTimes(3) // the repeat never re-reads
  })

  it('stops accumulating once the combined length reaches the cap', async () => {
    files.set('assets/a.png.reflect.md', 'x'.repeat(MAX_ASSET_TEXT_CHARS))
    files.set('assets/b.png.reflect.md', 'never reached')

    const bodies = await gatherAssetDescriptionBodies(['assets/a.png', 'assets/b.png'])

    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.assetPath).toBe('assets/a.png')
  })
})
