import { describe, expect, it } from 'vitest'
import {
  createTestDatabaseService,
  createTestEmbeddingIndexService,
  createTestEmbeddingRuntimeService,
  createTestIndexLifecycleService,
  createTestLoggerService,
  createTestNoteFileService,
  seedNotes,
  type TestDatabaseService,
} from '../testing/index.ts'

const NOTE_PATH = 'notes/a.md'

async function seedStoredRows(
  database: TestDatabaseService,
  rows: ReadonlyArray<{ content_hash: string; model_id: string }>,
): Promise<void> {
  for (const row of rows) {
    await database.runQuery(
      `INSERT INTO embedding_chunks
         (note_path, heading, pos_from, pos_to, text, content_hash, model_id)
       VALUES (?, NULL, 0, 0, '', ?, ?)`,
      [NOTE_PATH, row.content_hash, row.model_id],
    )
  }
}

/**
 * An embedding index over fakes: a note on "disk" at `path` (default
 * {@link NOTE_PATH}), stored hash+model rows for the diff, and capture of
 * the embedded texts and the chunk writes. `descriptions` are the
 * `<asset>.reflect.md` sidecars; any other sidecar read is a `notFound`.
 */
async function setup(options: {
  content: string
  storedRows: Array<{ content_hash: string; model_id: string }>
  path?: string
  descriptions?: Record<string, string>
  /**
   * Report the note itself as iCloud-evicted (bytes not local).
   */
  evicted?: boolean
  /**
   * Sidecar paths (`<asset>.reflect.md`) to report as iCloud-evicted.
   */
  evictedSidecars?: string[]
}) {
  const path = options.path ?? NOTE_PATH
  const evictedSidecars = options.evictedSidecars ?? []
  const database = createTestDatabaseService()
  await seedStoredRows(database, options.storedRows)
  const runtime = createTestEmbeddingRuntimeService({ vectors: () => [0.5, 0.5] })
  const index = createTestEmbeddingIndexService({
    database,
    embeddingRuntime: runtime,
    noteFile: createTestNoteFileService({
      files: {
        [path]: options.content,
        ...options.descriptions,
        ...Object.fromEntries(evictedSidecars.map((sidecar) => [sidecar, ''])),
      },
      evicted: [...(options.evicted === true ? [path] : []), ...evictedSidecars],
    }),
  })
  return {
    index,
    embedded: () => runtime.embedCalls(),
    applied: () => index.applied(),
    removed: () => index.removed(),
  }
}

const MODEL = 'all-MiniLM-L6-v2'

describe('embedNote', () => {
  it('never embeds a template — boilerplate must not reach retrieval', async () => {
    const { index, embedded, applied, removed } = await setup({
      path: 'templates/journal.md',
      content: '# Journal\n\nMood:\n\nGratitude:\n',
      storedRows: [],
    })
    const count = await index.embedNote({
      path: 'templates/journal.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(0)
    expect(embedded()).toHaveLength(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toHaveLength(0)
  })

  it('skips an iCloud-evicted note without touching its stored vectors', async () => {
    // Reading an evicted note would force a blocking on-demand download —
    // the backfill must skip it, and must not embed_remove: the
    // pre-eviction vectors stay valid until new content materializes.
    const { index, embedded, applied, removed } = await setup({
      content: '# One\n\nAlpha text.\n',
      storedRows: [],
      evicted: true,
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(0)
    expect(embedded()).toHaveLength(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toHaveLength(0)
  })

  it('embeds everything for a brand-new note', async () => {
    const { index, embedded, applied } = await setup({
      content: '# One\n\nAlpha text.\n\n# Two\n\nBeta text.\n',
      storedRows: [],
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(2)
    expect(embedded()).toHaveLength(1) // one batched embed_texts call
    expect(applied()[0]!.chunks.every((chunk) => chunk.vector !== null)).toBe(true)
  })

  it('the hash-skip embeds nothing when stored hashes match', async () => {
    const content = '# One\n\nAlpha text.\n'
    // First pass captures the chunk hash the second pass will find "stored".
    const first = await setup({ content, storedRows: [] })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    const hash = first.applied()[0]!.chunks[0]!.contentHash

    const second = await setup({
      content,
      storedRows: [{ content_hash: hash, model_id: MODEL }],
    })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(0)
    expect(second.embedded()).toHaveLength(0) // nothing re-embedded()
    expect(second.applied()[0]!.chunks[0]!.vector).toBeNull() // metadata-only row
  })

  it('a model change re-embeds chunks whose hashes are unchanged', async () => {
    const content = '# One\n\nAlpha text.\n'
    const first = await setup({ content, storedRows: [] })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    const hash = first.applied()[0]!.chunks[0]!.contentHash

    const second = await setup({
      content,
      storedRows: [{ content_hash: hash, model_id: 'old-model' }],
    })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(1) // same hash, different model → new vector
    expect(second.embedded()).toHaveLength(1)
  })

  it('duplicate-hash chunks only skip as many embeds as rows exist', async () => {
    // Two byte-identical sections (above the runt-merge threshold) produce
    // two chunks with one hash.
    const section = `# A\n\n${'The same sentence again. '.repeat(12)}\n`
    const dup = section + section
    const first = await setup({ content: dup, storedRows: [] })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    const hashes = first.applied()[0]!.chunks.map((chunk) => chunk.contentHash)
    expect(hashes[0]).toBe(hashes[1]) // genuinely duplicated chunks

    // Only ONE stored row for that hash: exactly one chunk may skip; the
    // other must re-embed (vector present), or apply_chunks errors loudly.
    const second = await setup({
      content: dup,
      storedRows: [{ content_hash: hashes[0]!, model_id: MODEL }],
    })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(1)
    const sent = second.applied()[0]!.chunks
    expect(sent.filter((chunk) => chunk.vector === null)).toHaveLength(1)
    expect(sent.filter((chunk) => chunk.vector !== null)).toHaveLength(1)
  })

  it('an emptied note drops its chunks via embed_remove', async () => {
    const { index, applied, removed } = await setup({ content: '\n', storedRows: [] })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toEqual([{ path: 'notes/a.md', generation: 1 }])
  })

  const IMAGE_NOTE = '# Trip\n\nSome notes about the day.\n\n![photo](assets/pic.png)\n'
  const PIC_DESCRIPTION =
    '---\nreflectAsset: true\nsource: assets/pic.png\n---\n\nA red bridge over a misty river at dawn.\n'

  it('embeds asset description chunks after the note’s own chunks', async () => {
    const { index, applied } = await setup({
      content: IMAGE_NOTE,
      storedRows: [],
      descriptions: { 'assets/pic.png.reflect.md': PIC_DESCRIPTION },
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBeGreaterThanOrEqual(2) // note chunk(s) + the asset chunk

    const chunks = applied()[0]!.chunks
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
    // evicted sidecar's body would silently drop its previously embedded()
    // chunks, and sidecars are untracked so nothing would restore them.
    const { index, embedded, applied, removed } = await setup({
      content: IMAGE_NOTE,
      storedRows: [{ content_hash: 'previously-stored', model_id: MODEL }],
      evictedSidecars: ['assets/pic.png.reflect.md'],
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(0)
    expect(embedded()).toHaveLength(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toHaveLength(0)
  })

  it('a note without a description for its asset embeds only its own text', async () => {
    const { index, applied } = await setup({ content: IMAGE_NOTE, storedRows: [] })
    await index.embedNote({ path: 'notes/a.md', generation: 1, fileGeneration: 1, modelId: MODEL })
    expect(applied()[0]!.chunks.every((chunk) => chunk.posFrom < IMAGE_NOTE.length)).toBe(true)
  })

  it('the hash-skip covers unchanged asset description chunks', async () => {
    const descriptions = { 'assets/pic.png.reflect.md': PIC_DESCRIPTION }
    const first = await setup({ content: IMAGE_NOTE, storedRows: [], descriptions })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    const storedRows = first.applied()[0]!.chunks.map((chunk) => ({
      content_hash: chunk.contentHash,
      model_id: MODEL,
    }))

    const second = await setup({ content: IMAGE_NOTE, storedRows, descriptions })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(0)
    expect(second.embedded()).toHaveLength(0)
  })

  it('a rewritten description re-embeds only the asset chunk', async () => {
    const first = await setup({
      content: IMAGE_NOTE,
      storedRows: [],
      descriptions: { 'assets/pic.png.reflect.md': PIC_DESCRIPTION },
    })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    const storedRows = first.applied()[0]!.chunks.map((chunk) => ({
      content_hash: chunk.contentHash,
      model_id: MODEL,
    }))

    const second = await setup({
      content: IMAGE_NOTE,
      storedRows,
      descriptions: {
        'assets/pic.png.reflect.md': '---\nreflectAsset: true\n---\n\nNow a snowy mountain pass.\n',
      },
    })
    const count = await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
      modelId: MODEL,
    })
    expect(count).toBe(1)
    expect(second.embedded()).toEqual([['Now a snowy mountain pass.']])
  })
})

const NOTES = [
  { path: 'notes/a.md', markdown: '# A\n\nAlpha text.\n' },
  { path: 'notes/b.md', markdown: '# B\n\nBeta text.\n' },
  { path: 'templates/journal.md', markdown: '# Journal\n\nMood:\n' },
]

/**
 * An embedding index whose chunk writes land in a database indexed with {@link NOTES}.
 */
function setupGraph(options?: { unreadable?: string[] }) {
  const database = createTestDatabaseService()
  seedNotes(database, NOTES)
  const unreadable = options?.unreadable ?? []
  /**
   * Paths whose chunk writes reject.
   */
  const unwritable = new Set<string>()
  const logger = createTestLoggerService()
  const runtime = createTestEmbeddingRuntimeService({
    vectors: (text) => {
      if (unreadable.some((marker) => text.includes(marker))) {
        throw new Error(`cannot embed ${text.trim()}`)
      }
      return Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))
    },
  })
  const noteFile = createTestNoteFileService({
    files: Object.fromEntries(NOTES.map((note) => [note.path, note.markdown])),
  })
  const indexLifecycle = createTestIndexLifecycleService({ database, noteFile, logger })
  const index = createTestEmbeddingIndexService({
    database,
    noteFile,
    indexLifecycle,
    logger,
    embeddingRuntime: runtime,
    storeChunks: true,
    failApply: (apply) => (unwritable.has(apply.path) ? new Error('disk full') : undefined),
  })
  const storedPaths = async (): Promise<string[]> => {
    const rows = await database.db
      .selectFrom('embeddingChunks')
      .select('notePath')
      .distinct()
      .orderBy('notePath')
      .execute()
    return rows.map((row) => row.notePath)
  }
  return { index, database, noteFile, indexLifecycle, logger, runtime, storedPaths, unwritable }
}

/**
 * Long enough for every queued item of a follow to have run.
 */
async function queueDrained(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('removeNote', () => {
  it('drops the chunks and vectors of a note', async () => {
    const { index, storedPaths } = setupGraph()
    await index.embedNote({ path: 'notes/a.md', generation: 1, fileGeneration: 1, modelId: MODEL })
    await index.embedNote({ path: 'notes/b.md', generation: 1, fileGeneration: 1, modelId: MODEL })

    await index.removeNote('notes/a.md', 1)

    expect(index.removed()).toEqual([{ path: 'notes/a.md', generation: 1 }])
    await expect(storedPaths()).resolves.toEqual(['notes/b.md'])
  })
})

describe('backfill', () => {
  it('embeds every indexed note but the templates, in path order, with progress', async () => {
    const { index, storedPaths } = setupGraph()
    const progress: Array<[number, number]> = []

    const result = await index.backfill({
      generation: 3,
      fileGeneration: 1,
      modelId: MODEL,
      onProgress: (done, total) => {
        progress.push([done, total])
      },
    })

    expect(result).toBe('completed')
    expect(index.applied().map((apply) => [apply.path, apply.generation])).toEqual([
      ['notes/a.md', 3],
      ['notes/b.md', 3],
    ])
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ])
    await expect(storedPaths()).resolves.toEqual(['notes/a.md', 'notes/b.md'])
  })

  it('embeds nothing on a second pass (the hash-skip)', async () => {
    const { index, runtime } = setupGraph()
    await index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL })
    const embedded = runtime.embedCalls().length

    await expect(
      index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL }),
    ).resolves.toBe('completed')

    expect(runtime.embedCalls()).toHaveLength(embedded)
  })

  it('logs one summary line per pass', async () => {
    const { index, logger } = setupGraph()

    await index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL })
    await index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL })

    expect(logger.getInfos()).toEqual([
      {
        message: 'embedding backfill finished',
        cause: {
          outcome: 'completed',
          modelId: MODEL,
          generation: 3,
          notes: 2,
          done: 2,
          notesEmbedded: 2,
          chunksEmbedded: 2,
          failed: 0,
          elapsedMs: 0,
        },
      },
      {
        message: 'embedding backfill finished',
        cause: {
          outcome: 'completed',
          modelId: MODEL,
          generation: 3,
          notes: 2,
          done: 2,
          notesEmbedded: 0,
          chunksEmbedded: 0,
          failed: 0,
          elapsedMs: 0,
        },
      },
    ])
  })

  it('aborts between notes once the signal aborts', async () => {
    const { index, logger } = setupGraph()
    const controller = new AbortController()

    const result = await index.backfill({
      generation: 3,
      fileGeneration: 1,
      modelId: MODEL,
      onProgress: () => {
        controller.abort()
      },
      signal: controller.signal,
    })

    expect(result).toBe('aborted')
    expect(index.applied().map((apply) => apply.path)).toEqual(['notes/a.md'])
    expect(logger.getInfos().map((entry) => entry.cause)).toMatchObject([
      { outcome: 'aborted', notes: 2, done: 1 },
    ])
  })

  it('logs a note that fails and goes on with the next', async () => {
    const { index, logger } = setupGraph({ unreadable: ['Alpha'] })

    await expect(
      index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL }),
    ).resolves.toBe('completed')

    expect(index.applied().map((apply) => apply.path)).toEqual(['notes/b.md'])
    expect(logger.getErrors()).toHaveLength(1)
    expect(logger.getErrors()[0]!.message).toBe('embedding backfill failed for notes/a.md:')
    expect(logger.getInfos().map((entry) => entry.cause)).toMatchObject([
      { outcome: 'completed', done: 2, notesEmbedded: 1, failed: 1 },
    ])
  })

  it('resolves `failed` when the note list cannot be read', async () => {
    const { index, database, logger } = setupGraph()
    database.close()

    await expect(
      index.backfill({ generation: 3, fileGeneration: 1, modelId: MODEL }),
    ).resolves.toBe('failed')
    expect(logger.getInfos().map((entry) => entry.cause)).toMatchObject([
      { outcome: 'failed', notes: 0, done: 0 },
    ])
  })
})

describe('follow', () => {
  it('backfills, then embeds the notes of each applied batch', async () => {
    const { index, indexLifecycle, noteFile } = setupGraph()
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: MODEL })
    await queueDrained()
    expect(index.applied().map((apply) => apply.path)).toEqual(['notes/a.md', 'notes/b.md'])

    noteFile.set('notes/a.md', '# A\n\nRewritten text.\n')
    indexLifecycle.emitApplied([{ kind: 'upsert', path: 'notes/a.md' }], 7)
    await queueDrained()

    const last = index.applied().at(-1)!
    expect([last.path, last.generation]).toEqual(['notes/a.md', 7])
    expect(last.chunks.map((chunk) => chunk.text).join('')).toContain('Rewritten text.')
    stop()
  })

  it('drops the vectors of a removed note', async () => {
    const { index, indexLifecycle, storedPaths } = setupGraph()
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: MODEL })
    await queueDrained()

    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)
    await queueDrained()

    expect(index.removed()).toEqual([{ path: 'notes/a.md', generation: 7 }])
    await expect(storedPaths()).resolves.toEqual(['notes/b.md'])
    stop()
  })

  it('ignores a sync pass', async () => {
    const { index, indexLifecycle } = setupGraph()
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: MODEL })
    await queueDrained()
    const before = index.applied().length

    indexLifecycle.emitApplied(null, 7)
    await queueDrained()

    expect(index.applied()).toHaveLength(before)
    expect(index.removed()).toEqual([])
    stop()
  })

  it('ignores a delayed emit from a superseded index session', async () => {
    const { index, indexLifecycle } = setupGraph()
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: MODEL })
    await queueDrained()
    const applied = index.applied().length

    indexLifecycle.emitApplied([{ kind: 'upsert', path: 'notes/a.md' }], 6)
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/b.md' }], 6)
    await queueDrained()

    expect(index.applied()).toHaveLength(applied)
    expect(index.removed()).toEqual([])
    stop()
  })

  it('never embeds asset-file changes riding the same batches', async () => {
    const { index, indexLifecycle } = setupGraph()
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: MODEL })
    await queueDrained()
    const applied = index.applied().length

    indexLifecycle.emitApplied(
      [
        { kind: 'upsert', path: 'assets/photo.png' },
        { kind: 'remove', path: 'assets/old.pdf' },
      ],
      7,
    )
    await queueDrained()

    expect(index.applied()).toHaveLength(applied)
    expect(index.removed()).toEqual([])
    stop()
  })

  it('skips the work still queued when it stops, and hears no later batch', async () => {
    const { index, indexLifecycle } = setupGraph()
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: MODEL })
    // Queued behind the backfill, which has not started yet.
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)
    stop()
    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/b.md' }], 7)
    await queueDrained()

    expect(index.applied()).toEqual([])
    expect(index.removed()).toEqual([])
  })

  it('logs one failing note and goes on with the queue', async () => {
    const { index, indexLifecycle, logger, noteFile, unwritable } = setupGraph()
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: MODEL })
    await queueDrained()
    const applied = index.applied().length

    noteFile.set('notes/a.md', '# A\n\nGamma text.\n')
    noteFile.set('notes/b.md', '# B\n\nDelta text.\n')
    unwritable.add('notes/a.md')
    indexLifecycle.emitApplied(
      [
        { kind: 'upsert', path: 'notes/a.md' },
        { kind: 'upsert', path: 'notes/b.md' },
      ],
      7,
    )
    await queueDrained()

    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'embedding sync failed for notes/a.md:',
    ])
    expect(
      index
        .applied()
        .slice(applied)
        .map((apply) => apply.path),
    ).toEqual(['notes/b.md'])
    stop()
  })
})
