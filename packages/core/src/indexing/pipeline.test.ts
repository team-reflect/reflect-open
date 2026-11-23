import { returnTrue } from '@ocavue/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '@reflect/utils'
import { AppError } from '../errors.ts'
import { parseNote } from '../markdown/index.ts'
import { createTestXArchiveService } from '../testing/capture.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import {
  createTestIndexStoreService,
  type IndexStoreCall,
  type TestIndexStoreServiceOptions,
} from '../testing/index-store.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import type { FileChange } from './file-change-service.ts'
import { createIndexQueryService } from './index-query-service.ts'
import { buildIndexedNote, PROJECTION_VERSION } from './indexed-note.ts'
import { createDirtySet } from './dirty-set.ts'
import { createIndexWriter, type ChangesAppliedEmitter, type IndexWriter } from './index-writer.ts'
import { createNoteIndexer, PROJECTION_VERSION_KEY } from './indexer.ts'

const NOW = 1_750_000_000_000

/**
 * Mirrors the default file listing: one arrival needing a read.
 */
const DEFAULT_SCAN = {
  total: 1,
  candidates: [{ path: 'notes/a.md', modifiedMs: 5, storedMtime: null, storedHash: null }],
  orphans: [],
  stalePlaceholders: [],
}

/**
 * The file generation of the test graph; the note file double rejects reads at any other.
 */
const FILE_GENERATION = 9
const databases: { close(): void }[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

/**
 * A row as an earlier pass stored it, with the facts the next pass compares.
 */
interface StoredNote {
  path: string
  markdown: string
  fileHash: string
  mtime: number
}

/**
 * The indexer over test doubles. `files` defaults to one
 * note (`notes/a.md`, modified at 5); `read` runs before each note read and
 * may reject it.
 */
function setup(options?: {
  files?: Readonly<Record<string, { contents: string; modifiedMs: number }>>
  evicted?: readonly string[]
  store?: TestIndexStoreServiceOptions
  indexed?: readonly TestNote[]
  stored?: readonly StoredNote[]
  read?: (path: string) => void
}) {
  const database = createTestDatabaseService()
  databases.push(database)
  seedNotes(database, options?.indexed ?? [])
  for (const { path, markdown, fileHash, mtime } of options?.stored ?? []) {
    database.applyProjection(
      buildIndexedNote(parseNote({ path, source: markdown }), {
        fileHash,
        mtime,
        source: markdown,
      }),
    )
  }
  const store = createTestIndexStoreService({ scan: DEFAULT_SCAN, ...options?.store })
  const files = createTestNoteFileService({ generation: FILE_GENERATION })
  const listing = options?.files ?? {
    'notes/a.md': { contents: '# Hello\n\n[[World]]', modifiedMs: 5 },
  }
  for (const [path, file] of Object.entries(listing)) {
    files.set(path, file.contents, { modifiedMs: file.modifiedMs })
  }
  for (const path of options?.evicted ?? []) {
    files.evict(path)
  }
  const clock = createTestClockService({ now: NOW })
  const logger = createTestLoggerService()
  const reads: string[] = []
  const readFile = files.read.bind(files)
  vi.spyOn(files, 'read').mockImplementation(async (path, generation) => {
    reads.push(path)
    options?.read?.(path)
    return await readFile(path, generation)
  })
  const appliedListeners = new Set<ChangesAppliedEmitter>()
  /**
   * Listen for the changes the index writers report as applied.
   */
  function subscribeIndexApplied(listener: ChangesAppliedEmitter): () => void {
    appliedListeners.add(listener)
    return () => {
      appliedListeners.delete(listener)
    }
  }
  const deps = {
    indexStore: store,
    noteFile: files,
    indexQuery: createIndexQueryService({ database }),
    database,
    xArchive: createTestXArchiveService(),
    clock,
    logger,
  }
  function methods(): IndexStoreCall['method'][] {
    return store.calls().map((call) => call.method)
  }
  function findCall<Method extends IndexStoreCall['method']>(
    method: Method,
  ): Extract<IndexStoreCall, { method: Method }> | undefined {
    return store
      .calls()
      .find((call): call is Extract<IndexStoreCall, { method: Method }> => call.method === method)
  }
  const moves: Array<[string, string]> = []
  const writers = new Map<number, IndexWriter>()
  /**
   * The index writer at index generation `generation`.
   */
  function writerAt(generation: number): IndexWriter {
    let writer = writers.get(generation)
    if (writer === undefined) {
      writer = createIndexWriter(
        {
          ...deps,
          emitChangesApplied: (changes: readonly FileChange[], appliedGeneration: number) => {
            for (const listener of appliedListeners) {
              listener(changes, appliedGeneration)
            }
          },
          emitMoved: (from: string, to: string) => {
            moves.push([from, to])
          },
          canWrite: returnTrue,
        },
        { dirty: createDirtySet(), generation, fileGeneration: FILE_GENERATION },
      )
      writers.set(generation, writer)
    }
    return writer
  }
  return {
    indexer: createNoteIndexer(deps),
    writerAt,
    subscribeIndexApplied,
    moves,
    store,
    clock,
    logger,
    reads,
    methods,
    findCall,
  }
}

/**
 * A listing of `paths`, each holding a heading of its own path.
 */
function notes(...paths: string[]): Record<string, { contents: string; modifiedMs: number }> {
  return Object.fromEntries(
    paths.map((path, index) => [path, { contents: `# ${path}\n`, modifiedMs: index + 1 }]),
  )
}

describe('reindexNotesReferencing', () => {
  const REFERENCING = '# Hello\n\n![pic](assets/pic.png)\n'

  it('re-applies referencing notes, and the writer reports them', async () => {
    const { indexer, writerAt, findCall, subscribeIndexApplied } = setup({
      files: { 'notes/a.md': { contents: REFERENCING, modifiedMs: 5 } },
      indexed: [{ path: 'notes/a.md', markdown: REFERENCING }],
    })
    const emitted: Array<[readonly { path: string; kind: string }[], number]> = []
    const unsubscribe = subscribeIndexApplied((changes, generation) => {
      emitted.push([changes, generation])
    })
    try {
      await indexer.reindexNotesReferencing(['assets/pic.png'], writerAt(7))
      await writerAt(7).drained()
    } finally {
      unsubscribe()
    }

    const apply = findCall('applyBatch')
    expect(apply).toBeDefined()
    expect(apply!.generation).toBe(7)

    // The note file did not change, so the report is the only way followers
    // (the embedding sync) hear about the refreshed notes.
    expect(emitted).toEqual([[[{ path: 'notes/a.md', kind: 'upsert' }], 7]])
  })

  it('throws a failed re-index after the other notes are written and reported', async () => {
    const { indexer, writerAt, subscribeIndexApplied } = setup({
      files: {
        'notes/a.md': { contents: REFERENCING, modifiedMs: 5 },
        'notes/b.md': { contents: REFERENCING, modifiedMs: 5 },
      },
      indexed: [
        { path: 'notes/a.md', markdown: REFERENCING },
        { path: 'notes/b.md', markdown: REFERENCING },
      ],
      read: (path) => {
        if (path === 'notes/b.md') {
          throw new AppError('io', 'disk error')
        }
      },
    })
    const emitted: Array<readonly { path: string }[]> = []
    const unsubscribe = subscribeIndexApplied((changes) => {
      emitted.push(changes)
    })
    try {
      await expect(
        indexer.reindexNotesReferencing(['assets/pic.png'], writerAt(7)),
      ).rejects.toMatchObject({
        kind: 'io',
      })
      await writerAt(7).drained()
    } finally {
      unsubscribe()
    }
    // notes/a.md was applied although notes/b.md failed: followers must hear it.
    expect(emitted).toEqual([[{ path: 'notes/a.md', kind: 'upsert' }]])
  })

  it('emits nothing when no note references the assets', async () => {
    const { indexer, writerAt, subscribeIndexApplied } = setup()
    const emitted: unknown[] = []
    const unsubscribe = subscribeIndexApplied((changes) => {
      emitted.push(changes)
    })
    try {
      await indexer.reindexNotesReferencing(['assets/pic.png'], writerAt(7))
      await writerAt(7).drained()
    } finally {
      unsubscribe()
    }
    expect(emitted).toEqual([])
  })
})

describe('rebuild', () => {
  it('clears, lists, applies every file in one batch, then stamps the projection version', async () => {
    const { indexer, writerAt, reads, methods, findCall } = setup()
    const progress: Array<[number, number, number]> = []
    await indexer.rebuild({
      writer: writerAt(1),
      onFileProgress: (done, total, worked) => {
        progress.push([done, total, worked])
      },
    })
    // A rebuild reads everything: worked tracks done, so the pill surfaces.
    expect(progress.at(-1)).toEqual([1, 1, 1])
    expect(methods()[0]).toBe('clear')
    expect(reads).toEqual(['notes/a.md'])
    const batch = findCall('applyBatch')
    expect(batch).toBeDefined()
    expect(batch!.notes.map((note) => note.path)).toEqual(['notes/a.md'])
    expect(methods()).not.toContain('apply') // batched, not one-by-one
    // The stamp lets the next open reconcile instead of rebuilding again.
    expect(findCall('setMeta')).toMatchObject({
      key: PROJECTION_VERSION_KEY,
      value: String(PROJECTION_VERSION),
      generation: 1,
    })
  })

  it('splits a failed rebuild batch and still applies the notes individually', async () => {
    const { indexer, writerAt, store, methods } = setup({
      files: notes('notes/a.md', 'notes/b.md', 'notes/c.md'),
      store: {
        fail: (call) => {
          return call.method === 'applyBatch' && call.notes.length > 1
            ? new Error('batch payload refused')
            : undefined
        },
      },
    })

    await indexer.rebuild({ writer: writerAt(1) })

    const attempted = store.calls().flatMap((call) => {
      return call.method === 'applyBatch' ? [call.notes.map((note) => note.path)] : []
    })
    expect(attempted).toEqual([
      ['notes/a.md', 'notes/b.md', 'notes/c.md'],
      ['notes/a.md', 'notes/b.md'],
      ['notes/a.md'],
      ['notes/b.md'],
      ['notes/c.md'],
    ])
    expect(store.applied().map((note) => note.path)).toEqual([
      'notes/a.md',
      'notes/b.md',
      'notes/c.md',
    ])
    expect(methods()).toContain('setMeta')
  })

  it('reports and skips a note whose projection cannot be written alone', async () => {
    const { indexer, writerAt, methods } = setup({
      files: notes('notes/bad.md'),
      store: {
        fail: (call) => {
          return call.method === 'applyBatch'
            ? new AppError('parse', 'unexpected end of hex escape')
            : undefined
        },
      },
    })
    const skipped: Array<{ path: string; message: string }> = []

    await indexer.rebuild({
      writer: writerAt(1),
      onSkippedNote: (note) => {
        skipped.push(note)
      },
    })

    expect(skipped).toEqual([{ path: 'notes/bad.md', message: 'unexpected end of hex escape' }])
    expect(methods()).toContain('setMeta')
  })

  it('throws a single-note write failure when no skip callback is registered', async () => {
    const { indexer, writerAt, methods } = setup({
      files: notes('notes/bad.md'),
      store: {
        fail: (call) => {
          return call.method === 'applyBatch' ? new Error('single note refused') : undefined
        },
      },
    })

    await expect(indexer.rebuild({ writer: writerAt(1) })).rejects.toThrow('single note refused')
    expect(methods()).not.toContain('setMeta')
  })

  it('throws a read failure once the other files are written, without a stamp', async () => {
    const { indexer, writerAt, store, methods } = setup({
      files: notes('notes/a.md', 'notes/bad.md'),
      read: (path) => {
        if (path === 'notes/bad.md') {
          throw new AppError('io', 'disk error')
        }
      },
    })

    await expect(indexer.rebuild({ writer: writerAt(1) })).rejects.toMatchObject({ kind: 'io' })

    expect(store.applied().map((note) => note.path)).toEqual(['notes/a.md'])
    expect(methods()).not.toContain('setMeta')
  })

  it('stops before the next SQLite write when suspended after the rebuild wipe', async () => {
    const controller = new AbortController()
    const { indexer, writerAt, methods } = setup({
      // Models iOS becoming hidden while filesystem work is in flight.
      read: () => {
        controller.abort()
        writerAt(1).pause()
      },
    })

    await indexer.rebuild({
      writer: writerAt(1),
      signal: controller.signal,
    })

    expect(methods()).toContain('clear') // began while foregrounded
    expect(methods()).not.toContain('applyBatch')
    // No new projection stamp is written; foreground sync converges either by
    // rebuilding an old projection or reconciling missing rows for a current one.
    expect(methods()).not.toContain('setMeta')
  })
})

describe('sync', () => {
  it('reconciles (no wipe) when the stored projection version is current', async () => {
    const { indexer, writerAt, logger, methods } = setup({
      store: { meta: { [PROJECTION_VERSION_KEY]: String(PROJECTION_VERSION) } },
    })
    await indexer.sync({ writer: writerAt(2) })
    expect(methods()).toContain('reconcileScan')
    expect(methods()).not.toContain('clear')
    expect(methods()).not.toContain('setMeta')
    expect(logger.getWarnings()).toEqual([])
  })

  it('rebuilds and stamps when the index predates the current projection', async () => {
    // never stamped (or written by an older app)
    const { indexer, writerAt, logger, methods, findCall } = setup()
    await indexer.sync({ writer: writerAt(3) })
    expect(methods()).toContain('clear')
    expect(findCall('setMeta')).toMatchObject({
      key: PROJECTION_VERSION_KEY,
      value: String(PROJECTION_VERSION),
      generation: 3,
    })
    expect(logger.getWarnings().map((entry) => entry.message)).toEqual([
      `index: stored projection version none ≠ ${PROJECTION_VERSION} — full rebuild`,
    ])
  })
})

describe('reconcile move healing (Plan 17)', () => {
  const OLD = 'notes/01arz3ndektsv4rrffq69g5fav.md'
  const NEW = 'notes/meeting-notes.md'
  const CONTENT = '---\nid: 01abcdefghjkmnpqrstvwxyz00\n---\n# Meeting Notes\n'

  /** A graph where OLD's row remains but the file now lives at NEW. */
  function setupRename(options: { storedHash: string; content?: string }) {
    return setup({
      files: { [NEW]: { contents: options.content ?? CONTENT, modifiedMs: 9 } },
      indexed: [{ path: OLD, markdown: CONTENT }],
      store: {
        scan: {
          total: 1,
          candidates: [{ path: NEW, modifiedMs: 9, storedMtime: null, storedHash: null }],
          orphans: [{ path: OLD, storedMtime: 1, storedHash: options.storedHash }],
          stalePlaceholders: [],
        },
      },
    })
  }

  it('moves the rows, then writes the new path, and removes nothing', async () => {
    const { indexer, writerAt, store, findCall, moves } = setupRename({
      storedHash: await sha256Hex(CONTENT),
    })

    await indexer.reconcile({ writer: writerAt(4) })

    expect(findCall('move')).toEqual({ method: 'move', from: OLD, to: NEW, generation: 4 })
    // The rows moved, so embeddings survived. The projection also depends on
    // the path, so the new path is written even though the content is the same.
    expect(store.applied().map((note) => note.path)).toEqual([NEW])
    expect(store.removed()).toEqual([])
    expect(moves).toEqual([[OLD, NEW]])
  })

  it('re-indexes at the new path when content changed in transit', async () => {
    const { indexer, writerAt, store, findCall } = setupRename({
      storedHash: 'stale-hash-from-before-the-edit',
    })

    await indexer.reconcile({ writer: writerAt(4) })

    expect(store.moved()).toEqual([{ from: OLD, to: NEW }])
    expect(store.removed()).toEqual([])
    expect(findCall('applyBatch')?.notes.map((note) => note.path)).toEqual([NEW])
  })

  it('a legacy file without an id still reconciles as delete+create', async () => {
    const { indexer, writerAt, store } = setupRename({
      storedHash: 'whatever',
      content: '# Meeting Notes\n',
    })

    await indexer.reconcile({ writer: writerAt(4) })

    expect(store.moved()).toEqual([])
    expect(store.applied().map((note) => note.path)).toEqual([NEW])
    expect(store.removed()).toEqual([OLD])
  })

  it('logs a refused move and degrades to delete+create', async () => {
    const { indexer, writerAt, store, logger } = setup({
      files: { [NEW]: { contents: CONTENT, modifiedMs: 9 } },
      indexed: [{ path: OLD, markdown: CONTENT }],
      store: {
        scan: {
          total: 1,
          candidates: [{ path: NEW, modifiedMs: 9, storedMtime: null, storedHash: null }],
          orphans: [{ path: OLD, storedMtime: 1, storedHash: 'whatever' }],
          stalePlaceholders: [],
        },
        fail: (call) => (call.method === 'move' ? new Error('destination taken') : undefined),
      },
    })

    await indexer.reconcile({ writer: writerAt(4) })

    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      `id-based move failed (${OLD} → ${NEW}):`,
    ])
    expect(store.applied().map((note) => note.path)).toEqual([NEW])
    expect(store.removed()).toEqual([OLD])
  })
})

describe('reconcile over the native scan delta', () => {
  it('does nothing when the scan reports no delta — the healthy-open path', async () => {
    // Mtime-matched files never leave Rust (the scan's own tests cover the
    // classification); an empty delta must cost no reads, no writes, and no
    // visible progress.
    const { indexer, writerAt, reads, methods } = setup({
      store: { scan: { total: 7_000, candidates: [], orphans: [], stalePlaceholders: [] } },
    })
    const progress: Array<[number, number, number]> = []

    await indexer.reconcile({
      writer: writerAt(4),
      onFileProgress: (done, total, worked) => {
        progress.push([done, total, worked])
      },
    })

    expect(methods()).toEqual(['reconcileScan'])
    expect(reads).toEqual([])
    // Zero worked files, and the total is the delta (0), not the graph size —
    // the pill stays hidden on every routine open.
    expect(progress).toEqual([[0, 0, 0]])
  })

  it('reads (and hash-skips) a candidate whose stored mtime differs — providers rewrite mtimes', async () => {
    const content = '# Hello\n'
    const storedHash = await sha256Hex(content)
    const { indexer, writerAt, reads, methods, findCall } = setup({
      files: { 'notes/a.md': { contents: content, modifiedMs: 2_000 } },
      stored: [{ path: 'notes/a.md', markdown: content, fileHash: storedHash, mtime: 1_000 }],
      store: {
        scan: {
          total: 1,
          candidates: [{ path: 'notes/a.md', modifiedMs: 2_000, storedMtime: 1_000, storedHash }],
          orphans: [],
          stalePlaceholders: [],
        },
      },
    })

    const progress: Array<[number, number, number]> = []

    await indexer.reconcile({
      writer: writerAt(4),
      onFileProgress: (done, total, worked) => {
        progress.push([done, total, worked])
      },
    })

    expect(reads).toEqual(['notes/a.md'])
    // Identical content under a rewritten mtime: the hash still gates the write.
    expect(methods()).not.toContain('applyBatch')
    // The self-heal: the row is re-stamped with the listed mtime, so the next
    // scan skips it entirely instead of re-reading forever.
    expect(findCall('touch')).toEqual({
      method: 'touch',
      entries: [{ path: 'notes/a.md', mtime: 2_000 }],
      generation: 4,
    })
    // The read counts as worked even though nothing was re-applied.
    expect(progress.at(-1)).toEqual([1, 1, 1])
  })

  it('re-indexes changed candidates and drops orphans', async () => {
    const { indexer, writerAt, store, findCall } = setup({
      files: notes('notes/changed.md'),
      store: {
        scan: {
          total: 2,
          candidates: [
            { path: 'notes/changed.md', modifiedMs: 2_000, storedMtime: 1_000, storedHash: 'old' },
          ],
          orphans: [{ path: 'notes/gone.md', storedMtime: 1_000, storedHash: 'gone' }],
          stalePlaceholders: [],
        },
      },
    })

    await indexer.reconcile({ writer: writerAt(4) })

    const applied = store.applied()
    expect(applied.map((note) => note.path)).toEqual(['notes/changed.md'])
    expect(applied[0]!.mtime).toBe(2_000)
    expect(findCall('remove')).toMatchObject({ path: 'notes/gone.md', generation: 4 })
  })

  it('returns early once aborted, and the writer still writes the marked files', async () => {
    const controller = new AbortController()
    const { indexer, writerAt, store } = setup({
      files: notes('notes/changed.md'),
      store: {
        scan: {
          total: 1,
          candidates: [
            { path: 'notes/changed.md', modifiedMs: 2_000, storedMtime: 1_000, storedHash: 'old' },
          ],
          orphans: [],
          stalePlaceholders: [],
        },
      },
      read: () => controller.abort(),
    })
    const progress: Array<[number, number, number]> = []

    await indexer.reconcile({
      writer: writerAt(4),
      signal: controller.signal,
      onFileProgress: (done, total, worked) => {
        progress.push([done, total, worked])
      },
    })
    expect(progress).toEqual([])
    expect(store.applied()).toEqual([])

    await writerAt(4).drained()
    expect(store.applied().map((note) => note.path)).toEqual(['notes/changed.md'])
  })

  it('removes the row for a candidate that vanished between the scan and the read', async () => {
    const { indexer, writerAt, findCall } = setup({
      files: {},
      store: {
        scan: {
          total: 1,
          candidates: [
            { path: 'notes/ghost.md', modifiedMs: 2_000, storedMtime: 1_000, storedHash: 'h' },
          ],
          orphans: [],
          stalePlaceholders: [],
        },
      },
    })

    await indexer.reconcile({ writer: writerAt(4) })

    expect(findCall('remove')).toMatchObject({ path: 'notes/ghost.md', generation: 4 })
  })
})

describe('iCloud eviction placeholders (Plan 21)', () => {
  // Reconcile-side placeholder rules (never a candidate, never an orphan)
  // now live in the Rust scan — `reconcile_scan_classifies_candidates_orphans_and_skips`
  // in crates/index/src/tests.rs covers them. Only the rebuild path still walks the listing here.
  it('rebuild indexes readable files and skips evicted ones', async () => {
    const { indexer, writerAt, store, reads } = setup({
      files: {
        'notes/real.md': { contents: '# Real\n', modifiedMs: 5 },
        'notes/evicted.md': { contents: '# Evicted\n', modifiedMs: 5 },
      },
      evicted: ['notes/evicted.md'],
    })

    const stale: string[][] = []
    await indexer.rebuild({
      writer: writerAt(6),
      onStalePlaceholders: (paths) => {
        stale.push([...paths])
      },
    })

    expect(store.applied().map((note) => note.path)).toEqual(['notes/real.md'])
    expect(reads).toEqual(['notes/real.md'])
    // The wipe dropped the evicted note's row and the rebuild couldn't read
    // it — it must be surfaced for a targeted download, or it silently
    // disappears from search until something else materializes it.
    expect(stale).toEqual([['notes/evicted.md']])
  })

  it('reconcile surfaces stale placeholders for targeted downloads', async () => {
    const { indexer, writerAt, reads } = setup({
      store: {
        scan: {
          total: 3,
          candidates: [],
          orphans: [],
          stalePlaceholders: ['notes/remote-edit.md', 'notes/never-local.md'],
        },
      },
    })

    const stale: string[][] = []
    await indexer.reconcile({
      writer: writerAt(4),
      onStalePlaceholders: (paths) => {
        stale.push([...paths])
      },
    })

    expect(stale).toEqual([['notes/remote-edit.md', 'notes/never-local.md']])
    // Placeholders are never read — that would force the very downloads the
    // callback exists to make targeted and non-blocking.
    expect(reads).toEqual([])
  })
})
