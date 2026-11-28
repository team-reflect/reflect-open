import { describe, expect, it } from 'vitest'
import {
  TEST_EMBED_MODEL,
  TEST_EMBED_DIMENSIONS,
  createTestDatabaseService,
  createTestEmbeddingIndexService,
  createTestEmbeddingRuntimeService,
  createTestIndexLifecycleService,
  createTestLoggerService,
  createTestNoteFileService,
  seedNotes,
} from '../testing/index.ts'
import { sleep } from '@ocavue/utils'

const NOTE_PATH = 'notes/a.md'

/**
 * An embedding index over fakes: a note on "disk" at `path` (default
 * {@link NOTE_PATH}), and capture of the embedded texts and the chunk
 * writes. `descriptions` are the
 * `<asset>.reflect.md` sidecars; any other sidecar read is a `notFound`.
 */
function setup(options: {
  content: string
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

describe('embedNote', () => {
  it('never embeds a template — boilerplate must not reach retrieval', async () => {
    const { index, embedded, applied, removed } = setup({
      path: 'templates/journal.md',
      content: '# Journal\n\nMood:\n\nGratitude:\n',
    })
    const count = await index.embedNote({
      path: 'templates/journal.md',
      generation: 1,
      fileGeneration: 1,
    })
    expect(count).toBe(0)
    expect(embedded()).toHaveLength(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toHaveLength(0)
  })

  it('skips an iCloud-evicted note without touching its stored vectors', async () => {
    // Reading an evicted note would force a blocking on-demand download —
    // the backfill must skip it, and must not write an empty set: the
    // pre-eviction vectors stay valid until new content materializes.
    const { index, embedded, applied, removed } = setup({
      content: '# One\n\nAlpha text.\n',
      evicted: true,
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
    })
    expect(count).toBe(0)
    expect(embedded()).toHaveLength(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toHaveLength(0)
  })

  it('embeds everything for a brand-new note', async () => {
    const { index, embedded } = setup({
      content: '# One\n\nAlpha text.\n\n# Two\n\nBeta text.\n',
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
    })
    expect(count).toBe(2)
    expect(embedded()).toHaveLength(1) // one batched embed_note_chunks call
  })

  it('an emptied note writes an empty chunk set', async () => {
    const { index, applied, removed } = setup({ content: '\n' })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
    })
    expect(count).toBe(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toEqual([{ path: 'notes/a.md', generation: 1 }])
  })

  const IMAGE_NOTE = '# Trip\n\nSome notes about the day.\n\n![photo](assets/pic.png)\n'
  const PIC_DESCRIPTION =
    '---\nreflectAsset: true\nsource: assets/pic.png\n---\n\nA red bridge over a misty river at dawn.\n'

  it('embeds asset description chunks after the note’s own chunks', async () => {
    const { index, applied } = setup({
      content: IMAGE_NOTE,
      descriptions: { 'assets/pic.png.reflect.md': PIC_DESCRIPTION },
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
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
    // embed_note_chunks replaces the note's entire chunk set; applying without the
    // evicted sidecar's body would silently drop its previously embedded()
    // chunks, and sidecars are untracked so nothing would restore them.
    const { index, embedded, applied, removed } = setup({
      content: IMAGE_NOTE,
      evictedSidecars: ['assets/pic.png.reflect.md'],
    })
    const count = await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
    })
    expect(count).toBe(0)
    expect(embedded()).toHaveLength(0)
    expect(applied()).toHaveLength(0)
    expect(removed()).toHaveLength(0)
  })

  it('a note without a description for its asset embeds only its own text', async () => {
    const { index, applied } = setup({ content: IMAGE_NOTE })
    await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
    })
    expect(applied()[0]!.chunks.every((chunk) => chunk.posFrom < IMAGE_NOTE.length)).toBe(true)
  })

  it('a rewritten description changes only the asset chunk hash', async () => {
    const first = setup({
      content: IMAGE_NOTE,
      descriptions: { 'assets/pic.png.reflect.md': PIC_DESCRIPTION },
    })
    await first.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
    })
    const second = setup({
      content: IMAGE_NOTE,
      descriptions: {
        'assets/pic.png.reflect.md': '---\nreflectAsset: true\n---\n\nNow a snowy mountain pass.\n',
      },
    })
    await second.index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
    })

    const before = first.applied()[0]!.chunks.map((chunk) => chunk.contentHash)
    const after = second.applied()[0]!.chunks.map((chunk) => chunk.contentHash)
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1))
    expect(after.at(-1)).not.toBe(before.at(-1))
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
      return Array.from({ length: TEST_EMBED_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0))
    },
  })
  const noteFile = createTestNoteFileService({
    files: Object.fromEntries(NOTES.map((note) => [note.path, note.markdown])),
  })
  const indexLifecycle = createTestIndexLifecycleService({ database, noteFile, logger })
  const index = createTestEmbeddingIndexService({
    noteFile,
    indexLifecycle,
    logger,
    embeddingRuntime: runtime,
    storeChunksIn: database,
    failApply: (apply) => (unwritable.has(apply.path) ? new Error('disk full') : undefined),
  })
  const storedPaths = (): unknown[] => {
    return database
      .query('SELECT DISTINCT note_path FROM embedding_chunks ORDER BY note_path')
      .map((row) => row['note_path'])
  }
  return { index, database, noteFile, indexLifecycle, logger, runtime, storedPaths, unwritable }
}

/**
 * Long enough for every queued item of a follow to have run.
 */
async function queueDrained(): Promise<void> {
  await sleep(20)
}

describe('removeNote', () => {
  it('drops the chunks and vectors of a note', async () => {
    const { index, storedPaths } = setupGraph()
    await index.embedNote({
      path: 'notes/a.md',
      generation: 1,
      fileGeneration: 1,
    })
    await index.embedNote({
      path: 'notes/b.md',
      generation: 1,
      fileGeneration: 1,
    })

    await index.removeNote('notes/a.md', 1)

    expect(index.removed()).toEqual([{ path: 'notes/a.md', generation: 1 }])
    expect(storedPaths()).toEqual(['notes/b.md'])
  })
})

describe('backfill', () => {
  it('embeds every indexed note but the templates, in path order, with progress', async () => {
    const { index, storedPaths } = setupGraph()
    const progress: Array<[number, number]> = []

    const result = await index.backfill({
      generation: 3,
      fileGeneration: 1,
      modelId: TEST_EMBED_MODEL,
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
    expect(storedPaths()).toEqual(['notes/a.md', 'notes/b.md'])
  })

  it('logs one summary line per pass', async () => {
    const { index, logger } = setupGraph()

    await index.backfill({ generation: 3, fileGeneration: 1, modelId: TEST_EMBED_MODEL })
    await index.backfill({ generation: 3, fileGeneration: 1, modelId: TEST_EMBED_MODEL })

    const summary = {
      message: 'embedding backfill finished',
      cause: {
        outcome: 'completed',
        modelId: TEST_EMBED_MODEL,
        generation: 3,
        notes: 2,
        done: 2,
        notesEmbedded: 2,
        chunksEmbedded: 2,
        failed: 0,
        elapsedMs: 0,
      },
    }
    expect(logger.getInfos()).toEqual([summary, summary])
  })

  it('aborts between notes once the signal aborts', async () => {
    const { index, logger } = setupGraph()
    const controller = new AbortController()

    const result = await index.backfill({
      generation: 3,
      fileGeneration: 1,
      modelId: TEST_EMBED_MODEL,
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
      index.backfill({ generation: 3, fileGeneration: 1, modelId: TEST_EMBED_MODEL }),
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
      index.backfill({ generation: 3, fileGeneration: 1, modelId: TEST_EMBED_MODEL }),
    ).resolves.toBe('failed')
    expect(logger.getInfos().map((entry) => entry.cause)).toMatchObject([
      { outcome: 'failed', notes: 0, done: 0 },
    ])
  })
})

describe('follow', () => {
  it('backfills, then embeds the notes of each applied batch', async () => {
    const { index, indexLifecycle, noteFile } = setupGraph()
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: TEST_EMBED_MODEL })
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
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: TEST_EMBED_MODEL })
    await queueDrained()

    indexLifecycle.emitApplied([{ kind: 'remove', path: 'notes/a.md' }], 7)
    await queueDrained()

    expect(index.removed()).toEqual([{ path: 'notes/a.md', generation: 7 }])
    expect(storedPaths()).toEqual(['notes/b.md'])
    stop()
  })

  it('ignores a sync pass', async () => {
    const { index, indexLifecycle } = setupGraph()
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: TEST_EMBED_MODEL })
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
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: TEST_EMBED_MODEL })
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
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: TEST_EMBED_MODEL })
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
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: TEST_EMBED_MODEL })
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
    const stop = index.follow({ generation: 7, fileGeneration: 1, modelId: TEST_EMBED_MODEL })
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
