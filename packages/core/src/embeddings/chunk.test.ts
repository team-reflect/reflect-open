import { describe, expect, it } from 'vitest'
import { chunkNote } from './chunk'

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
