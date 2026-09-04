import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashContent } from '../indexing/hash'
import { setBridge } from '../ipc/bridge'
import { parseNote } from '../markdown'
import { backfillEmbeddings, EMBEDDING_PROJECTION_VERSION, embedNote } from './pipeline'

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
  /** Report the note itself as iCloud-evicted (bytes not local). */
  evicted?: boolean
  /** Sidecar paths (`<asset>.reflect.md`) to report as iCloud-evicted. */
  evictedSidecars?: string[]
  current?: boolean
  indexedContent?: string
  indexedAssets?: string[]
  pendingPaths?: string[]
  onCommand?: (command: string) => void
  failApplyOnce?: boolean
}) {
  const commands: string[] = []
  const embedded: string[][] = []
  const applied: { path: string; chunks: AppliedChunk[] }[] = []
  let failApply = options.failApplyOnce === true
  setBridge({
    invoke: async (command, args) => {
      commands.push(command)
      options.onCommand?.(command)
      if (command === 'embed_pending') {
        expect(args).toEqual({
          generation: 1,
          modelId: MODEL,
          projectionVersion: EMBEDDING_PROJECTION_VERSION,
        })
        return (options.pendingPaths ?? []).map((path) => ({ path, fingerprint: 'revision' }))
      }
      if (command === 'embed_prepare') {
        if (options.current === true) {
          return null
        }
        return {
          fingerprint: 'revision',
          fileHash: await hashContent(options.indexedContent ?? options.content),
          assetPaths:
            options.indexedAssets ??
            parseNote({ path: 'notes/a.md', source: options.content }).assets.map(
              (asset) => asset.path,
            ),
        }
      }
      if (command === 'embed_read') {
        expect(args).toMatchObject({ generation: 1 })
        const path = (args as { path: string }).path
        if (path.endsWith('.reflect.md')) {
          if (options.evictedSidecars?.includes(path) === true) {
            return { kind: 'evicted' }
          }
          const description = options.descriptions?.[path]
          if (description === undefined) {
            throw { kind: 'notFound', message: `no description at ${path}` }
          }
          return { kind: 'content', content: description }
        }
        if (options.evicted === true) {
          return { kind: 'evicted' }
        }
        return { kind: 'content', content: options.content }
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
        expect(args).toMatchObject({
          generation: 1,
          request: {
            fingerprint: 'revision',
            modelId: MODEL,
            projectionVersion: EMBEDDING_PROJECTION_VERSION,
          },
        })
        if (failApply) {
          failApply = false
          throw { kind: 'io', message: 'temporary write failure' }
        }
        const { path, chunks } = (args as { request: { path: string; chunks: AppliedChunk[] } })
          .request
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
  return { commands, embedded, applied }
}

const MODEL = 'all-MiniLM-L6-v2'

describe('embedNote', () => {
  it('does no note reads, chunk queries, inference, or writes for a current checkpoint', async () => {
    const { commands } = fakePipelineBridge({ content: '# One\n', storedRows: [], current: true })
    expect(await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })).toBe(0)
    expect(commands).toEqual(['embed_prepare'])
  })

  it('waits for the index to catch up if file bytes no longer match its revision', async () => {
    const { commands } = fakePipelineBridge({
      content: '# Newly saved text\n',
      indexedContent: '# Previous text\n',
      storedRows: [],
    })
    await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(commands).toEqual(['embed_prepare', 'embed_read'])
  })

  it('waits for reindexing when a rename changes path-relative asset references', async () => {
    const { commands } = fakePipelineBridge({
      content: '# Note\n\n![Photo](assets/new.png)\n',
      indexedAssets: ['assets/old.png'],
      storedRows: [],
    })
    await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(commands).toEqual(['embed_prepare', 'embed_read'])
  })

  it.each(['embed_read', 'db_query', 'embed_texts'])(
    'abandons stale work after %s without applying or continuing inference',
    async (stopAt) => {
      let stale = false
      const { commands, applied } = fakePipelineBridge({
        content: '# One\n\nAlpha text.\n',
        storedRows: [],
        onCommand: (command) => {
          if (command === stopAt) {
            stale = true
          }
        },
      })
      await embedNote({
        path: 'notes/a.md',
        generation: 1,
        modelId: MODEL,
        isStale: () => stale,
      })
      expect(applied).toEqual([])
      expect(commands.at(-1)).toBe(stopAt)
    },
  )

  it('leaves a failed apply retryable', async () => {
    const { commands, applied } = fakePipelineBridge({
      content: '# One\n\nAlpha text.\n',
      storedRows: [],
      failApplyOnce: true,
    })
    const options = { path: 'notes/a.md', generation: 1, modelId: MODEL }
    await expect(embedNote(options)).rejects.toMatchObject({ kind: 'io' })
    await embedNote(options)
    expect(commands.filter((command) => command === 'embed_prepare')).toHaveLength(2)
    expect(applied).toHaveLength(1)
  })

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

  it('skips an iCloud-evicted note without touching its stored vectors', async () => {
    // Reading an evicted note would force a blocking on-demand download —
    // the backfill must skip it, and must not embed_remove: the
    // pre-eviction vectors stay valid until new content materializes.
    const { embedded, applied } = fakePipelineBridge({
      content: '# One\n\nAlpha text.\n',
      storedRows: [],
      evicted: true,
    })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(0)
    expect(embedded).toHaveLength(0)
    expect(applied).toHaveLength(0) // neither embed_apply nor embed_remove
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

  it('applies moved offsets and removed chunks even when no new vectors are needed', async () => {
    const retained = '# One\n\nAlpha text.\n\n'
    const original = fakePipelineBridge({
      content: `${retained}# Two\n\nBeta text.\n`,
      storedRows: [],
    })
    await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    const oldChunks = original.applied[0]!.chunks
    const frontmatter = '---\ntitle: Changed metadata\n---\n'
    const updated = fakePipelineBridge({
      content: frontmatter + retained,
      storedRows: oldChunks.map((chunk) => ({ content_hash: chunk.contentHash, model_id: MODEL })),
    })
    expect(await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })).toBe(0)
    expect(updated.embedded).toEqual([])
    expect(updated.applied[0]!.chunks).toHaveLength(1)
    expect(updated.applied[0]!.chunks[0]).toMatchObject({
      posFrom: frontmatter.length,
      contentHash: oldChunks[0]!.contentHash,
      vector: null,
    })
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

  it('an emptied note checkpoints its empty chunk set without a chunk query', async () => {
    const { applied, commands } = fakePipelineBridge({ content: '\n', storedRows: [] })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(0)
    expect(applied).toEqual([{ path: 'notes/a.md', chunks: [] }])
    expect(commands).toEqual(['embed_prepare', 'embed_read', 'embed_apply'])
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

  it('skips the whole note while a referenced sidecar is evicted — chunks survive', async () => {
    // embed_apply replaces the note's entire chunk set; applying without the
    // evicted sidecar's body would silently drop its previously embedded
    // chunks, and sidecars are untracked so nothing would restore them.
    const { embedded, applied } = fakePipelineBridge({
      content: IMAGE_NOTE,
      storedRows: [{ content_hash: 'previously-stored', model_id: MODEL }],
      evictedSidecars: ['assets/pic.png.reflect.md'],
    })
    const count = await embedNote({ path: 'notes/a.md', generation: 1, modelId: MODEL })
    expect(count).toBe(0)
    expect(embedded).toHaveLength(0)
    expect(applied).toHaveLength(0) // neither embed_apply nor embed_remove
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

describe('backfillEmbeddings', () => {
  it('makes unchanged backfill a single native candidate query', async () => {
    const { commands } = fakePipelineBridge({ content: '', storedRows: [], pendingPaths: [] })
    expect(await backfillEmbeddings({ generation: 1, modelId: MODEL })).toBe('completed')
    expect(commands).toEqual(['embed_pending'])
  })

  it('lets live work run before each dirty candidate and reports dirty-only progress', async () => {
    const { commands } = fakePipelineBridge({
      content: '# One\n',
      storedRows: [],
      pendingPaths: ['notes/a.md', 'notes/b.md'],
    })
    const scheduleNote = vi.fn(async (work: () => Promise<void>) => {
      commands.push('live-work')
      await work()
    })
    const onProgress = vi.fn()
    await backfillEmbeddings({ generation: 1, modelId: MODEL, scheduleNote, onProgress })
    expect(commands.filter((command) => command === 'embed_read')).toHaveLength(2)
    expect(commands.filter((command) => ['embed_prepare', 'live-work'].includes(command))).toEqual([
      'live-work',
      'embed_prepare',
      'live-work',
      'embed_prepare',
    ])
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it('stops when the session changes while selecting pending work', async () => {
    let stale = false
    const { commands } = fakePipelineBridge({
      content: '',
      storedRows: [],
      pendingPaths: ['notes/a.md'],
      onCommand: (command) => {
        if (command === 'embed_pending') {
          stale = true
        }
      },
    })
    expect(await backfillEmbeddings({ generation: 1, modelId: MODEL, isStale: () => stale })).toBe(
      'aborted',
    )
    expect(commands).toEqual(['embed_pending'])
  })
})
