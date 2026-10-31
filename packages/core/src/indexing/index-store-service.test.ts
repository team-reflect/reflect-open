import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import { parseNote } from '../markdown/index.ts'
import { createNodeTestDatabaseService } from '../testing/database.ts'
import { createTestIndexStoreService } from '../testing/index-store.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { buildIndexedNote, type IndexedNote } from './indexed-note.ts'
import { createIndexStoreService, INDEX_APPLY_BATCH_SIZE } from './index-store-service.ts'

function note(path: string): IndexedNote {
  const source = `# ${path}\n`
  return buildIndexedNote(parseNote({ path, source }), { fileHash: 'hash', mtime: 1, source })
}

function writeCommands(): Record<string, () => null> {
  return Object.fromEntries(
    [
      'index_apply',
      'index_apply_batch',
      'index_remove',
      'index_move',
      'note_move_indexed',
      'index_touch',
      'index_clear',
      'index_meta_set',
    ].map((command) => [command, () => null]),
  )
}

describe('createIndexStoreService', () => {
  it('sends each write to its command with the generation', async () => {
    const ipc = createTestIpcBridgeService({ commands: writeCommands() })
    const store = createIndexStoreService({ ipc, database: createNodeTestDatabaseService() })
    const a = note('notes/a.md')

    await store.apply(a, 3)
    await store.applyBatch([a], 3)
    await store.remove('notes/a.md', 3)
    await store.touch([{ path: 'notes/a.md', mtime: 9 }], 3)
    await store.clear(3)
    await store.setMeta('k', 'v', 3)

    expect(ipc.calls()).toEqual([
      { command: 'index_apply', args: { note: a, generation: 3 } },
      { command: 'index_apply_batch', args: { notes: [a], generation: 3 } },
      { command: 'index_remove', args: { path: 'notes/a.md', generation: 3 } },
      {
        command: 'index_touch',
        args: { entries: [{ path: 'notes/a.md', mtime: 9 }], generation: 3 },
      },
      { command: 'index_clear', args: { generation: 3 } },
      { command: 'index_meta_set', args: { key: 'k', value: 'v', generation: 3 } },
    ])
  })

  it('skips the backend for an empty batch or touch', async () => {
    const ipc = createTestIpcBridgeService()
    const store = createIndexStoreService({ ipc, database: createNodeTestDatabaseService() })

    await store.applyBatch([], 1)
    await store.touch([], 1)

    expect(ipc.calls()).toEqual([])
  })

  it('opens the index and resolves with its generation', async () => {
    const ipc = createTestIpcBridgeService({ commands: { index_open: () => 12 } })
    const store = createIndexStoreService({ ipc, database: createNodeTestDatabaseService() })

    await expect(store.open()).resolves.toBe(12)
  })

  it('re-states the path-derived addresses of a move', async () => {
    const ipc = createTestIpcBridgeService({ commands: writeCommands() })
    const store = createIndexStoreService({ ipc, database: createNodeTestDatabaseService() })

    await store.move('notes/Old.md', 'daily/2026-01-02.md', 4)
    await store.moveIndexed('notes/Old.md', 'notes/New Name.md', 8)

    expect(ipc.calls()).toEqual([
      {
        command: 'index_move',
        args: {
          from: 'notes/Old.md',
          to: 'daily/2026-01-02.md',
          generation: 4,
          toAddress: {
            pathKey: 'daily/2026-01-02.md',
            basenameKey: '2026-01-02',
            dailyDate: '2026-01-02',
          },
        },
      },
      {
        command: 'note_move_indexed',
        args: {
          request: {
            from: 'notes/Old.md',
            to: 'notes/New Name.md',
            toAddress: { pathKey: 'notes/new name.md', basenameKey: 'new name', dailyDate: null },
            fromAddress: { pathKey: 'notes/old.md', basenameKey: 'old', dailyDate: null },
          },
          generation: 8,
        },
      },
    ])
  })

  it('validates the reconcile scan', async () => {
    const scan = {
      total: 2,
      candidates: [{ path: 'notes/a.md', modifiedMs: 5, storedMtime: null, storedHash: null }],
      orphans: [{ path: 'notes/b.md', storedMtime: 1, storedHash: 'h' }],
      stalePlaceholders: ['notes/c.md'],
    }
    const ipc = createTestIpcBridgeService({ commands: { index_reconcile_scan: () => scan } })
    const store = createIndexStoreService({ ipc, database: createNodeTestDatabaseService() })

    await expect(store.reconcileScan(5)).resolves.toEqual(scan)
    expect(ipc.calls()).toEqual([{ command: 'index_reconcile_scan', args: { generation: 5 } }])
  })

  it('reads `index_meta` through the database', async () => {
    const database = createNodeTestDatabaseService()
    await database.runQuery('INSERT INTO index_meta(key, value) VALUES (?, ?)', ['k', 'v'])
    const store = createIndexStoreService({ ipc: createTestIpcBridgeService(), database })
    try {
      await expect(store.getMeta('k')).resolves.toBe('v')
      await expect(store.getMeta('missing')).resolves.toBeNull()
    } finally {
      database.close()
    }
  })
})

describe('createApplyBatch', () => {
  it('splits a refused batch until the failing note stands alone', async () => {
    const batches: string[][] = []
    const ipc = createTestIpcBridgeService({
      commands: {
        index_apply_batch: (args) => {
          const paths = (args['notes'] as IndexedNote[]).map((indexed) => indexed.path)
          batches.push(paths)
          if (paths.includes('notes/bad.md')) {
            throw new AppError('parse', 'bad projection')
          }
          return null
        },
      },
    })
    const store = createIndexStoreService({ ipc, database: createNodeTestDatabaseService() })
    const skipped: { path: string; message: string }[] = []
    const batch = store.createApplyBatch(2, (skip) => {
      skipped.push(skip)
    })

    for (const path of ['notes/a.md', 'notes/bad.md', 'notes/c.md']) {
      await batch.add(note(path))
    }
    await batch.flush()

    expect(batches).toEqual([
      ['notes/a.md', 'notes/bad.md', 'notes/c.md'],
      ['notes/a.md', 'notes/bad.md'],
      ['notes/a.md'],
      ['notes/bad.md'],
      ['notes/c.md'],
    ])
    expect(skipped).toEqual([{ path: 'notes/bad.md', message: 'bad projection' }])
    expect(batch.applied()).toBe(2)
  })

  it('throws a lone failure without a skip callback', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        index_apply_batch: () => {
          throw new AppError('parse', 'refused')
        },
      },
    })
    const store = createIndexStoreService({ ipc, database: createNodeTestDatabaseService() })
    const batch = store.createApplyBatch(1)

    await batch.add(note('notes/a.md'))

    await expect(batch.flush()).rejects.toMatchObject({ message: 'refused' })
  })

  it('flushes on its own at the transaction cap', async () => {
    const ipc = createTestIpcBridgeService({ commands: writeCommands() })
    const store = createIndexStoreService({ ipc, database: createNodeTestDatabaseService() })
    const batch = store.createApplyBatch(1)
    const projection = note('notes/a.md')

    for (let i = 0; i < INDEX_APPLY_BATCH_SIZE; i++) {
      await batch.add(projection)
    }

    expect(ipc.calls()).toHaveLength(1)
    expect(batch.applied()).toBe(INDEX_APPLY_BATCH_SIZE)
  })
})

describe('createTouchBatch', () => {
  it('applies queued re-stamps in one `index_touch`', async () => {
    const ipc = createTestIpcBridgeService({ commands: writeCommands() })
    const store = createIndexStoreService({ ipc, database: createNodeTestDatabaseService() })
    const touches = store.createTouchBatch(6)

    await touches.add({ path: 'notes/a.md', mtime: 1 })
    await touches.add({ path: 'notes/b.md', mtime: 2 })
    await touches.flush()
    await touches.flush()

    expect(ipc.calls()).toEqual([
      {
        command: 'index_touch',
        args: {
          entries: [
            { path: 'notes/a.md', mtime: 1 },
            { path: 'notes/b.md', mtime: 2 },
          ],
          generation: 6,
        },
      },
    ])
    expect(touches.applied()).toBe(2)
  })
})
describe('createTestIndexStoreService', () => {
  it('records calls and mirrors applies into its database', async () => {
    const database = createNodeTestDatabaseService()
    const store = createTestIndexStoreService({ database, meta: { seeded: 'yes' } })
    try {
      await store.applyBatch([note('notes/a.md'), note('notes/b.md')], 1)
      await store.apply(note('notes/a.md'), 1)
      await store.remove('notes/b.md', 1)
      await store.move('notes/x.md', 'notes/y.md', 1)
      await store.setMeta('k', 'v', 1)

      expect(store.applied().map((indexed) => indexed.path)).toEqual([
        'notes/a.md',
        'notes/b.md',
        'notes/a.md',
      ])
      expect(store.removed()).toEqual(['notes/b.md'])
      expect(store.moved()).toEqual([{ from: 'notes/x.md', to: 'notes/y.md' }])
      await expect(database.db.selectFrom('notes').select('path').execute()).resolves.toEqual([
        { path: 'notes/a.md' },
      ])
      await expect(store.getMeta('k')).resolves.toBe('v')
      await expect(store.getMeta('seeded')).resolves.toBe('yes')
    } finally {
      database.close()
    }
  })

  it('mirrors a move into its database, re-stating the path-derived claims', async () => {
    const database = createNodeTestDatabaseService()
    const store = createTestIndexStoreService({ database })
    try {
      const source = '# Title\n\n[[Other]] #tag\n'
      await store.apply(
        buildIndexedNote(parseNote({ path: 'notes/old.md', source }), {
          fileHash: 'hash',
          mtime: 1,
          source,
        }),
        1,
      )
      await store.apply(note('notes/taken.md'), 1)
      await store.moveIndexed('notes/old.md', 'notes/New Name.md', 1)

      await expect(
        database.db.selectFrom('notes').select(['path', 'pathKey']).orderBy('path').execute(),
      ).resolves.toEqual([
        { path: 'notes/New Name.md', pathKey: 'notes/new name.md' },
        { path: 'notes/taken.md', pathKey: 'notes/taken.md' },
      ])
      await expect(
        database.runQuery('SELECT key, tier FROM note_claims WHERE note_path = ? ORDER BY tier', [
          'notes/New Name.md',
        ]),
      ).resolves.toEqual([
        { key: 'title', tier: 2 },
        { key: 'new name', tier: 4 },
      ])
      await expect(
        database.runQuery('SELECT source_path FROM links UNION SELECT note_path FROM tags', []),
      ).resolves.toEqual([{ source_path: 'notes/New Name.md' }])
      await expect(
        database.runQuery('SELECT path FROM search_fts ORDER BY path', []),
      ).resolves.toEqual([{ path: 'notes/New Name.md' }, { path: 'notes/taken.md' }])

      await expect(store.move('notes/New Name.md', 'notes/taken.md', 1)).rejects.toMatchObject({
        kind: 'io',
        message: 'cannot move note: notes/taken.md is already indexed',
      })
    } finally {
      database.close()
    }
  })

  it('rejects a call that `fail` answers, after recording it', async () => {
    const store = createTestIndexStoreService({
      fail: (call) => (call.method === 'clear' ? new Error('refused') : undefined),
    })

    await expect(store.clear(1)).rejects.toThrow('refused')
    expect(store.calls()).toEqual([{ method: 'clear', generation: 1 }])
  })
})
