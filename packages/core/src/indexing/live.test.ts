import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestXArchiveService } from '../testing/capture.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createNodeTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createTestIndexStoreService } from '../testing/index-store.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import type { FileChange } from './file-change-service.ts'
import { createIndexQueryService } from './index-query-service.ts'
import type { ChangesAppliedEmitter } from './indexer.ts'
import { createLiveIndex } from './live.ts'

const databases: { close(): void }[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

/**
 * The file generation of the test graph; the note file double rejects reads at any other.
 */
const FILE_GENERATION = 5

/**
 * A live index over test doubles. `read` stands in front of the note files:
 * it runs before each read and may delay or reject it.
 */
function setup(options?: {
  files?: Readonly<Record<string, string>>
  indexed?: readonly TestNote[]
  read?: (path: string) => Promise<void>
}) {
  const database = createNodeTestDatabaseService()
  databases.push(database)
  seedNotes(database, options?.indexed ?? [])
  const store = createTestIndexStoreService()
  const files = createTestNoteFileService({
    files: options?.files ?? {},
    generation: FILE_GENERATION,
  })
  const fileChanges = createTestFileChangeService()
  const logger = createTestLoggerService()
  const reads: string[] = []
  const readFile = files.read.bind(files)
  vi.spyOn(files, 'read').mockImplementation(async (path, generation) => {
    reads.push(path)
    await options?.read?.(path)
    return await readFile(path, generation)
  })
  const appliedListeners = new Set<ChangesAppliedEmitter>()
  /**
   * Listen for the batches the live index reports as applied.
   */
  function subscribeIndexApplied(listener: ChangesAppliedEmitter): () => void {
    appliedListeners.add(listener)
    return () => {
      appliedListeners.delete(listener)
    }
  }
  const liveIndex = createLiveIndex({
    emitChangesApplied: (changes, generation) => {
      for (const listener of appliedListeners) {
        listener(changes, generation)
      }
    },
    indexStore: store,
    noteFile: files,
    fileChanges,
    indexQuery: createIndexQueryService({ database }),
    database,
    xArchive: createTestXArchiveService(),
    clock: createTestClockService({ now: 1_750_000_000_000 }),
    logger,
  })
  /**
   * The index writes so far, as `apply:<path>` / `remove:<path>` in call order.
   */
  function writes(): string[] {
    const log: string[] = []
    for (const call of store.calls()) {
      if (call.method === 'applyBatch') {
        log.push(...call.notes.map((note) => `apply:${note.path}`))
      } else if (call.method === 'remove') {
        log.push(`remove:${call.path}`)
      }
    }
    return log
  }
  function emit(changes: FileChange[]): void {
    fileChanges.emit({ changes, source: 'external' })
  }
  return { liveIndex, store, files, logger, reads, writes, emit, subscribeIndexApplied }
}

describe('LiveIndex.apply', () => {
  it('reports a failing change and continues with the rest of the batch', async () => {
    const { liveIndex, writes } = setup({
      files: { 'notes/bad.md': '# bad', 'notes/good.md': '# ok' },
      read: (path) => {
        if (path === 'notes/bad.md') {
          return Promise.reject(new AppError('io', 'unreadable'))
        }
        return Promise.resolve()
      },
    })

    const failures: Array<{ change: FileChange }> = []
    await liveIndex.apply(
      [
        { path: 'notes/bad.md', kind: 'upsert' },
        { path: 'notes/good.md', kind: 'upsert' },
      ],
      3,
      FILE_GENERATION,
      (_error, change) => {
        failures.push({ change })
      },
    )

    expect(writes()).toEqual(['apply:notes/good.md'])
    expect(failures.map((failure) => failure.change.path)).toEqual(['notes/bad.md'])
  })

  it('logs a failing change when no error handler is given', async () => {
    const { liveIndex, logger } = setup()

    await liveIndex.apply([{ path: 'notes/missing.md', kind: 'upsert' }], 3, FILE_GENERATION)

    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'failed to index change for notes/missing.md:',
    ])
  })

  it('routes removes to the index store at the given generation', async () => {
    const { liveIndex, store } = setup()

    await liveIndex.apply([{ path: 'notes/gone.md', kind: 'remove' }], 9, FILE_GENERATION)

    expect(store.calls()).toEqual([{ method: 'remove', path: 'notes/gone.md', generation: 9 }])
  })

  it('applies an upsert(x) … remove(x) sequence in order — the remove wins', async () => {
    const { liveIndex, writes } = setup({ files: { 'notes/x.md': '# recreated then deleted' } })

    await liveIndex.apply(
      [
        { path: 'notes/x.md', kind: 'upsert', modifiedMs: 42 },
        { path: 'notes/x.md', kind: 'remove' },
      ],
      9,
      FILE_GENERATION,
    )

    // The batched upsert must flush before the remove — a remove overtaken by
    // its own earlier upsert would resurrect a deleted note as a ghost row.
    expect(writes()).toEqual(['apply:notes/x.md', 'remove:notes/x.md'])
  })

  it('skips non-note paths — the watcher also reports audio-memo recordings', async () => {
    const { liveIndex, store, reads } = setup()

    await liveIndex.apply(
      [
        { path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a', kind: 'upsert' },
        { path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a', kind: 'remove' },
      ],
      3,
      FILE_GENERATION,
    )

    expect(store.calls()).toEqual([])
    expect(reads).toEqual([])
  })
})

describe('LiveIndex.subscribe', () => {
  it('serializes overlapping batches so later events cannot overtake earlier ones', async () => {
    const pendingFirstRead = Promise.withResolvers<void>()
    const { liveIndex, reads, writes, emit } = setup({
      files: { 'notes/slow.md': '# content', 'notes/fast.md': '# content' },
      read: async (path) => {
        if (path === 'notes/slow.md') {
          await pendingFirstRead.promise
        }
      },
    })

    liveIndex.subscribe(1, FILE_GENERATION)
    emit([{ path: 'notes/slow.md', kind: 'upsert' }])
    emit([{ path: 'notes/fast.md', kind: 'upsert' }])
    await vi.waitFor(() => {
      expect(reads).toContain('notes/slow.md')
    })
    // The second batch must not start while the first is still applying.
    expect(reads).not.toContain('notes/fast.md')

    pendingFirstRead.resolve()
    await vi.waitFor(() => {
      expect(writes()).toContain('apply:notes/fast.md')
    })
    expect(reads).toEqual(['notes/slow.md', 'notes/fast.md'])
    expect(writes()).toEqual(['apply:notes/slow.md', 'apply:notes/fast.md'])
  })

  it('drops queued live writes when the lifecycle suspends and leaves replay to reconcile', async () => {
    let canApply = true
    const pendingRead = Promise.withResolvers<void>()
    const finished: string[] = []
    const { liveIndex, reads, writes, emit } = setup({
      files: { 'notes/started-visible.md': '# content', 'notes/queued.md': '# content' },
      read: async (path) => {
        await pendingRead.promise
        finished.push(path)
      },
    })

    liveIndex.subscribe(1, FILE_GENERATION, undefined, () => canApply)
    emit([{ path: 'notes/started-visible.md', kind: 'upsert' }])
    emit([{ path: 'notes/queued.md', kind: 'upsert' }])
    await vi.waitFor(() => expect(reads).toContain('notes/started-visible.md'))

    canApply = false
    pendingRead.resolve()
    await vi.waitFor(() => expect(finished).toContain('notes/started-visible.md'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The first batch had begun reading while visible, but did not start its
    // SQLite write after suspension. The second never began at all; the
    // foreground full reconcile is the durable replay path for both.
    expect(writes()).toEqual([])
    expect(reads).not.toContain('notes/queued.md')
  })

  it('emits index-applied to subscribers after the batch is written — notes settle first', async () => {
    const order: string[] = []
    const { liveIndex, writes, emit, subscribeIndexApplied } = setup({
      files: { 'notes/a.md': '# content' },
    })
    const unsubscribe = subscribeIndexApplied((changes) => {
      order.push(
        `applied:${changes.map((change) => change.path).join(',')} after ${writes().join(',')}`,
      )
    })

    liveIndex.subscribe(1, FILE_GENERATION)
    // A note batch, then an asset-only batch: the asset emit must follow the
    // note's apply, so a gate reading the index off the asset emit sees the note.
    emit([{ path: 'notes/a.md', kind: 'upsert' }])
    emit([{ path: 'assets/x.png', kind: 'upsert' }])
    await vi.waitFor(() => {
      expect(order).toHaveLength(2)
    })

    expect(order).toEqual([
      'applied:notes/a.md after apply:notes/a.md',
      'applied:assets/x.png after apply:notes/a.md',
    ])
    unsubscribe()
  })

  it('does not emit index-applied for a recordings-only batch', async () => {
    const seen: string[] = []
    const { liveIndex, emit, subscribeIndexApplied } = setup()
    const unsubscribe = subscribeIndexApplied((changes) => {
      seen.push(changes.map((change) => change.path).join(','))
    })

    liveIndex.subscribe(1, FILE_GENERATION)
    emit([{ path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a', kind: 'upsert' }])
    emit([{ path: 'assets/y.png', kind: 'upsert' }]) // something to wait on
    await vi.waitFor(() => {
      expect(seen).toContain('assets/y.png')
    })

    expect(seen).toEqual(['assets/y.png']) // the recordings batch emitted nothing
    unsubscribe()
  })

  it('stamps the indexed row with the modifiedMs carried by the event', async () => {
    const { liveIndex, store, emit } = setup({ files: { 'notes/a.md': '# content' } })

    liveIndex.subscribe(1, FILE_GENERATION)
    emit([{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1234 }])
    await vi.waitFor(() => {
      expect(store.applied().map((note) => note.mtime)).toEqual([1234])
    })
  })

  it('stops applying once unsubscribed', async () => {
    const { liveIndex, store, reads, emit } = setup({ files: { 'notes/a.md': '# content' } })

    liveIndex.subscribe(1, FILE_GENERATION)()
    emit([{ path: 'notes/a.md', kind: 'upsert' }])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reads).toEqual([])
    expect(store.calls()).toEqual([])
  })
})

describe('LiveIndex.apply move healing (Plan 17)', () => {
  const OLD = 'notes/01arz3ndektsv4rrffq69g5fav.md'
  const NEW = 'notes/meeting-notes.md'
  const CONTENT = '---\nid: 01abcdefghjkmnpqrstvwxyz00\n---\n# Meeting Notes\n'

  /**
   * OLD is indexed (with the id, unless `rowContent` says otherwise) and NEW exists on disk.
   */
  function setupRename(options?: { rowContent?: string }) {
    return setup({
      files: { [NEW]: CONTENT },
      indexed: [{ path: OLD, markdown: options?.rowContent ?? CONTENT }],
    })
  }

  it('heals a same-batch external rename: rows move, nothing is removed', async () => {
    const { liveIndex, store } = setupRename()

    await liveIndex.apply(
      [
        { path: OLD, kind: 'remove' },
        { path: NEW, kind: 'upsert', modifiedMs: 42 },
      ],
      7,
      FILE_GENERATION,
    )

    expect(store.calls().filter((call) => call.method === 'move')).toEqual([
      { method: 'move', from: OLD, to: NEW, generation: 7 },
    ])
    expect(store.removed()).toEqual([])
    const apply = store.calls().find((call) => call.method === 'apply')
    expect(apply).toBeDefined()
    if (apply?.method !== 'apply') {
      throw new Error('Expected rename heal to apply the renamed note')
    }
    expect(apply.note.path).toBe(NEW)
    expect(apply.note.mtime).toBe(42)
  })

  it('announces the heal via onMoved so the app can follow', async () => {
    const { liveIndex } = setupRename()
    const moves: Array<[string, string]> = []

    await liveIndex.apply(
      [
        { path: OLD, kind: 'remove' },
        { path: NEW, kind: 'upsert' },
      ],
      7,
      FILE_GENERATION,
      undefined,
      (from, to) => {
        moves.push([from, to])
      },
    )

    expect(moves).toEqual([[OLD, NEW]])
  })

  it('falls back to delete+create when the ids do not match', async () => {
    const { liveIndex, store, writes } = setupRename({
      rowContent: '---\nid: 01zzzzzzzzzzzzzzzzzzzzzzzz\n---\n# Meeting Notes\n',
    })

    await liveIndex.apply(
      [
        { path: OLD, kind: 'remove' },
        { path: NEW, kind: 'upsert' },
      ],
      7,
      FILE_GENERATION,
    )

    expect(store.moved()).toEqual([])
    expect(writes()).toEqual([`remove:${OLD}`, `apply:${NEW}`])
  })

  it("Reflect's own move echo never pairs: the removed side has no row left", async () => {
    // Neither path has a row under the old key (already moved).
    const { liveIndex, store, writes } = setup({ files: { [NEW]: CONTENT } })

    await liveIndex.apply(
      [
        { path: OLD, kind: 'remove' },
        { path: NEW, kind: 'upsert' },
      ],
      7,
      FILE_GENERATION,
    )

    expect(store.moved()).toEqual([])
    // The remove no-ops against a moved row; the re-apply is idempotent.
    expect(writes()).toEqual([`remove:${OLD}`, `apply:${NEW}`])
  })
})
