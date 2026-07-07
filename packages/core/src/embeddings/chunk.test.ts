import { describe, expect, it } from 'vitest'
import { MAX_ASSET_TEXT_CHARS } from '../indexing/asset-description-text'
import { chunkAssetDescriptions, chunkNote } from './chunk'

const PATH = 'notes/a.md'

describe('chunkNote', () => {
  it('chunks per heading section with whole-file offsets and stable hashes', async () => {
    const source = '# Alpha\n\nFirst section text.\n\n# Beta\n\nSecond section text.\n'
    const chunks = await chunkNote(PATH, source)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.heading).toBe('Alpha')
    expect(chunks[1]!.heading).toBe('Beta')
    // Offsets slice back to the exact chunk text.
    for (const chunk of chunks) {
      expect(source.slice(chunk.posFrom, chunk.posTo)).toBe(chunk.text)
    }

    const again = await chunkNote(PATH, source)
    expect(again.map((chunk) => chunk.contentHash)).toEqual(
      chunks.map((chunk) => chunk.contentHash),
    )
  })

  it('an unchanged section keeps its hash when another section changes', async () => {
    const before = '# Stable\n\nUnchanged text here.\n\n# Volatile\n\nOld content.\n'
    const after = '# Stable\n\nUnchanged text here.\n\n# Volatile\n\nNew content entirely.\n'
    const a = await chunkNote(PATH, before)
    const b = await chunkNote(PATH, after)
    expect(b[0]!.contentHash).toBe(a[0]!.contentHash) // the hash-skip foundation
    expect(b[1]!.contentHash).not.toBe(a[1]!.contentHash)
  })

  it('splits a long section into sentence-aligned chunks', async () => {
    const sentence = 'This sentence is reasonably long and ends with a period. '
    const source = `# Long\n\n${sentence.repeat(40)}`
    const chunks = await chunkNote(PATH, source)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.heading).toBe('Long')
      expect(source.slice(chunk.posFrom, chunk.posTo)).toBe(chunk.text)
    }
    // Chunks cover the section contiguously, in order.
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.posFrom).toBe(chunks[i - 1]!.posTo)
    }
  })

  it('skips frontmatter and handles heading-less notes', async () => {
    const source = '---\ntitle: Meta\n---\n\nJust a body without headings.\n'
    const chunks = await chunkNote(PATH, source)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.heading).toBeNull()
    expect(chunks[0]!.text).not.toContain('title: Meta')
  })

  it('returns nothing for empty or whitespace-only notes', async () => {
    expect(await chunkNote(PATH, '')).toEqual([])
    expect(await chunkNote(PATH, '\n\n  \n')).toEqual([])
  })

  it('merges a runt tail chunk into its predecessor', async () => {
    const sentence = 'A solid sentence that carries real length for the chunker to count. '
    const source = `# One\n\n${sentence.repeat(16)}Tiny tail.`
    const chunks = await chunkNote(PATH, source)
    const last = chunks[chunks.length - 1]!
    expect(last.text.length).toBeGreaterThanOrEqual(200)
    expect(last.text.endsWith('Tiny tail.')).toBe(true)
  })
})

describe('chunkAssetDescriptions', () => {
  const BASE = 500 // as if the note source were 499 chars long

  it('chunks each body under the asset filename with positions past the note', async () => {
    const chunks = await chunkAssetDescriptions(
      [
        { assetPath: 'assets/graphs/q4.png', body: 'Quarterly revenue bar chart.' },
        { assetPath: 'assets/scan.pdf', body: 'A signed lease agreement.' },
      ],
      BASE,
    )
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.heading).toBe('q4.png')
    expect(chunks[1]!.heading).toBe('scan.pdf')
    expect(chunks[0]!.text).toBe('Quarterly revenue bar chart.')
    expect(chunks[0]!.posFrom).toBe(BASE)
    // The second body starts after the first, so positions stay ordered.
    expect(chunks[1]!.posFrom).toBeGreaterThan(chunks[0]!.posTo)
  })

  it('hashes are stable across runs and change with the body', async () => {
    const bodies = [{ assetPath: 'assets/a.png', body: 'A red bridge at dawn.' }]
    const first = await chunkAssetDescriptions(bodies, BASE)
    const again = await chunkAssetDescriptions(bodies, BASE)
    expect(again[0]!.contentHash).toBe(first[0]!.contentHash)

    const changed = await chunkAssetDescriptions(
      [{ assetPath: 'assets/a.png', body: 'A snowy mountain pass.' }],
      BASE,
    )
    expect(changed[0]!.contentHash).not.toBe(first[0]!.contentHash)
  })

  it('splits a long body into sentence-aligned chunks and merges the runt tail', async () => {
    const sentence = 'The scanned page describes the quarterly figures in detail. '
    const chunks = await chunkAssetDescriptions(
      [{ assetPath: 'assets/report.pdf', body: `${sentence.repeat(40)}End.` }],
      BASE,
    )
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.heading).toBe('report.pdf')
    }
    const last = chunks[chunks.length - 1]!
    expect(last.text.length).toBeGreaterThanOrEqual(200) // runt merged
    expect(last.text.endsWith('End.')).toBe(true)
  })

  it('caps the combined description text, mirroring the FTS fold', async () => {
    const chunks = await chunkAssetDescriptions(
      [
        { assetPath: 'assets/a.png', body: 'x'.repeat(MAX_ASSET_TEXT_CHARS) },
        { assetPath: 'assets/b.png', body: 'never reached' },
      ],
      BASE,
    )
    expect(chunks.every((chunk) => chunk.heading === 'a.png')).toBe(true)
    const total = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
    expect(total).toBe(MAX_ASSET_TEXT_CHARS)
  })

  it('counts the body joiner against the cap, like the FTS join-then-slice', async () => {
    // FTS keeps `first + '\n\n' + second` sliced to the cap, so a later body
    // only gets what the cap leaves after the two joiner chars.
    const chunks = await chunkAssetDescriptions(
      [
        { assetPath: 'assets/a.png', body: 'x'.repeat(MAX_ASSET_TEXT_CHARS - 6) },
        { assetPath: 'assets/b.png', body: 'yyyyyyyy' },
      ],
      BASE,
    )
    const second = chunks.filter((chunk) => chunk.heading === 'b.png')
    expect(second).toHaveLength(1)
    expect(second[0]!.text).toBe('yyyy') // cap − body − joiner = 4 chars left
  })

  it('returns nothing for no bodies', async () => {
    expect(await chunkAssetDescriptions([], BASE)).toEqual([])
  })
})
