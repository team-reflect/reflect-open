import { afterEach, describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { embedNote } from './pipeline'

afterEach(() => {
  setBridge(null)
})

interface AppliedChunk {
  heading: string | null
  posFrom: number
  text: string
  contentHash: string
  vector: number[] | null
}

/**
 * Bridge fake for the pipeline: a note on "disk", stored hash+model rows for
 * the db_query the diff makes, and capture of embed_texts / embed_apply.
 * `descriptions` answers reads of `<asset>.reflect.md` sidecars; any other
 * sidecar read gets the Rust layer's notFound.
 */
function fakePipelineBridge(options: {
  content: string
  storedRows: Array<{ content_hash: string; model_id: string }>
  descriptions?: Record<string, string>
}) {
  const embedded: string[][] = []
  const applied: { path: string; chunks: AppliedChunk[] }[] = []
  setBridge({
    invoke: async (command, args) => {
      if (command === 'note_read') {
        const path = (args as { path: string }).path
        if (path.endsWith('.reflect.md')) {
          const description = options.descriptions?.[path]
          if (description === undefined) {
            throw { kind: 'notFound', message: `no description at ${path}` }
          }
          return description
        }
        return options.content
      }
      if (command === 'db_query') {
        return options.storedRows
      }
      if (command === 'embed_texts') {
        const texts = (args as { texts: string[] }).texts
        embedded.push(texts)
        return texts.map(() => [0.5, 0.5])
      }
      if (command === 'embed_apply') {
        const { path, chunks } = args as { path: string; chunks: AppliedChunk[] }
        applied.push({ path, chunks })
        return null
      }
      if (command === 'embed_remove') {
        applied.push({ path: (args as { path: string }).path, chunks: [] })
        return null
      }
      return null
    },
    listen: async () => () => {},
  })
  return { embedded, applied }
}

const MODEL = 'all-MiniLM-L6-v2'

describe('embedNote', () => {
  it('never embeds a template — boilerplate must not reach retrieval', async () => {
    const { embedded, applied } = fakePipelineBridge({
      content: '# Journal\n\nMood:\n\nGratitude:\n',
      storedRows: [],
    })
    const count = await embedNote({ path: 'templates/journal.md', generation: 1, modelId: MODEL })
    expect(count).toBe(0)
    expect(embedded).toHaveLength(0)
    expect(applied).toHaveLength(0)
  })

  it('embeds everything for a brand-new note', async () => {
    const { embedded, applied } = fakePipelineBridge({
      content: '# One\n\nAlpha text.\n\n# Two\n\nBeta text.\n',
      storedRows: [],
    })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(2)
    expect(embedded).toHaveLength(1) // one batched embed_texts call
    expect(applied[0]!.chunks.every((chunk) => chunk.vector !== null)).toBe(true)
  })

  it('the hash-skip embeds nothing when stored hashes match', async () => {
    const content = '# One\n\nAlpha text.\n'
    // First pass captures the chunk hash the second pass will find "stored".
    const first = fakePipelineBridge({ content, storedRows: [] })
    await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    const hash = first.applied[0]!.chunks[0]!.contentHash

    const second = fakePipelineBridge({
      content,
      storedRows: [{ content_hash: hash, model_id: MODEL }],
    })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(0)
    expect(second.embedded).toHaveLength(0) // nothing re-embedded
    expect(second.applied[0]!.chunks[0]!.vector).toBeNull() // metadata-only row
  })

  it('a model change re-embeds chunks whose hashes are unchanged', async () => {
    const content = '# One\n\nAlpha text.\n'
    const first = fakePipelineBridge({ content, storedRows: [] })
    await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    const hash = first.applied[0]!.chunks[0]!.contentHash

    const second = fakePipelineBridge({
      content,
      storedRows: [{ content_hash: hash, model_id: 'old-model' }],
    })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(1) // same hash, different model → new vector
    expect(second.embedded).toHaveLength(1)
  })

  it('duplicate-hash chunks only skip as many embeds as rows exist', async () => {
    // Two byte-identical sections (above the runt-merge threshold) produce
    // two chunks with one hash.
    const section = `# A\n\n${'The same sentence again. '.repeat(12)}\n`
    const dup = section + section
    const first = fakePipelineBridge({ content: dup, storedRows: [] })
    await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    const hashes = first.applied[0]!.chunks.map((chunk) => chunk.contentHash)
    expect(hashes[0]).toBe(hashes[1]) // genuinely duplicated chunks

    // Only ONE stored row for that hash: exactly one chunk may skip; the
    // other must re-embed (vector present), or apply_chunks errors loudly.
    const second = fakePipelineBridge({
      content: dup,
      storedRows: [{ content_hash: hashes[0]!, model_id: MODEL }],
    })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(1)
    const sent = second.applied[0]!.chunks
    expect(sent.filter((chunk) => chunk.vector === null)).toHaveLength(1)
    expect(sent.filter((chunk) => chunk.vector !== null)).toHaveLength(1)
  })

  it('an emptied note drops its chunks via embed_remove', async () => {
    const { applied } = fakePipelineBridge({ content: '\n', storedRows: [] })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(0)
    expect(applied).toEqual([{ path: 'notes/a.md', chunks: [] }])
  })

  const IMAGE_NOTE = '# Trip\n\nSome notes about the day.\n\n![photo](assets/pic.png)\n'
  const PIC_DESCRIPTION =
    '---\nreflectAsset: true\nsource: assets/pic.png\n---\n\nA red bridge over a misty river at dawn.\n'

  it('embeds asset description chunks after the note’s own chunks', async () => {
    const { applied } = fakePipelineBridge({
      content: IMAGE_NOTE,
      storedRows: [],
      descriptions: { 'assets/pic.png.reflect.md': PIC_DESCRIPTION },
    })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBeGreaterThanOrEqual(2) // note chunk(s) + the asset chunk

    const chunks = applied[0]!.chunks
    const assetChunk = chunks[chunks.length - 1]!
    expect(assetChunk.heading).toBe('pic.png')
    expect(assetChunk.text).toContain('red bridge over a misty river')
    expect(assetChunk.text).not.toContain('reflectAsset') // frontmatter stripped
    // Synthetic positions live past the note source, so asset chunks order last.
    expect(assetChunk.posFrom).toBeGreaterThan(IMAGE_NOTE.length)
    expect(chunks.slice(0, -1).every((chunk) => chunk.posFrom < IMAGE_NOTE.length)).toBe(true)
  })

  it('a note without a description for its asset embeds only its own text', async () => {
    const { applied } = fakePipelineBridge({ content: IMAGE_NOTE, storedRows: [] })
    await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(applied[0]!.chunks.every((chunk) => chunk.posFrom < IMAGE_NOTE.length)).toBe(true)
  })

  it('the hash-skip covers unchanged asset description chunks', async () => {
    const descriptions = { 'assets/pic.png.reflect.md': PIC_DESCRIPTION }
    const first = fakePipelineBridge({ content: IMAGE_NOTE, storedRows: [], descriptions })
    await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    const storedRows = first.applied[0]!.chunks.map((chunk) => ({
      content_hash: chunk.contentHash,
      model_id: MODEL,
    }))

    const second = fakePipelineBridge({ content: IMAGE_NOTE, storedRows, descriptions })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(0)
    expect(second.embedded).toHaveLength(0)
  })

  it('a rewritten description re-embeds only the asset chunk', async () => {
    const first = fakePipelineBridge({
      content: IMAGE_NOTE,
      storedRows: [],
      descriptions: { 'assets/pic.png.reflect.md': PIC_DESCRIPTION },
    })
    await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    const storedRows = first.applied[0]!.chunks.map((chunk) => ({
      content_hash: chunk.contentHash,
      model_id: MODEL,
    }))

    const second = fakePipelineBridge({
      content: IMAGE_NOTE,
      storedRows,
      descriptions: {
        'assets/pic.png.reflect.md': '---\nreflectAsset: true\n---\n\nNow a snowy mountain pass.\n',
      },
    })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(1)
    expect(second.embedded).toEqual([['Now a snowy mountain pass.']])
  })
})
