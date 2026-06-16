import { afterEach, describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { embedNote } from './pipeline'

afterEach(() => {
  setBridge(null)
})

interface AppliedChunk {
  contentHash: string
  vector: number[] | null
}

/**
 * Bridge fake for the pipeline: a note on "disk", stored hash+model rows for
 * the db_query the diff makes, and capture of embed_texts / embed_apply.
 */
function fakePipelineBridge(options: {
  content: string
  storedRows: Array<{ content_hash: string; model_id: string }>
}) {
  const embedded: string[][] = []
  const applied: { path: string; chunks: AppliedChunk[] }[] = []
  setBridge({
    invoke: async (command, args) => {
      if (command === 'note_read') {
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
})
