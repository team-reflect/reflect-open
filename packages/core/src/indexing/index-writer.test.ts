import type { NoteRead } from '@reflect/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex, sha256HexSync, type MaybePromise } from '@reflect/utils'
import { AppError } from '../errors.ts'
import { parseNote } from '../markdown/index.ts'
import { createTestXArchiveService } from '../testing/capture.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createTestIndexStoreService, type IndexStoreCall } from '../testing/index-store.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createDirtySet } from './dirty-set.ts'
import type { FileChange } from './file-change-service.ts'
import { createIndexQueryService } from './index-query-service.ts'
import { INDEX_APPLY_BATCH_SIZE } from './index-store-service.ts'
import { createIndexWriter, INDEX_RETRY_MIN_MS } from './index-writer.ts'
import { buildIndexedNote } from './indexed-note.ts'

const NOW = 1_750_000_000_000

/**
 * The file generation of the test graph; the note file double rejects reads at any other.
 */
const FILE_GENERATION = 5
const INDEX_GENERATION = 9
const databases: { close(): void }[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

/**
 * A row as an earlier write stored it, with the facts the writer compares.
 */
interface StoredNote {
  path: string
  markdown: string
  fileHash: string
  mtime: number
}

/**
 * A writer over test doubles. `read` runs before each note read and may delay
 * or reject it. `indexed` and `stored` are the rows the writer reads facts
 * and ids from.
 */
function noteOf(content: string): NoteRead {
  return { content, hash: sha256HexSync(content) }
}

function setup(options?: {
  files?: Readonly<Record<string, string>>
  indexed?: readonly TestNote[]
  stored?: readonly StoredNote[]
  read?: (path: string) => MaybePromise<void>
  failStore?: (call: IndexStoreCall) => Error | undefined
  report?: () => void
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
  const store = createTestIndexStoreService(
    options?.failStore === undefined ? {} : { fail: options.failStore },
  )
  const files = createTestNoteFileService({
    files: options?.files ?? {},
    generation: FILE_GENERATION,
  })
  const logger = createTestLoggerService()
  const reads: string[] = []
  const readFile = files.read.bind(files)
  vi.spyOn(files, 'read').mockImplementation(async (path, generation) => {
    reads.push(path)
    await options?.read?.(path)
    return await readFile(path, generation)
  })
  const gate = { canWrite: true }
  const reports: FileChange[][] = []
  /**
   * The index writes at the time of each report.
   */
  const writesAtReport: string[][] = []
  const moves: Array<[string, string]> = []
  /**
   * The index writes so far, as `apply:<path>` / `remove:<path>` / `touch:<path>` / `move:<from>><to>` / `clear`.
   */
  function writes(): string[] {
    return store.calls().flatMap((call) => {
      switch (call.method) {
        case 'applyBatch':
          return call.notes.map((note) => `apply:${note.path}`)
        case 'remove':
          return `remove:${call.path}`
        case 'touch':
          return call.entries.map((entry) => `touch:${entry.path}`)
        case 'move':
          return `move:${call.from}>${call.to}`
        case 'clear':
          return 'clear'
        default:
          return []
      }
    })
  }
  const dirty = createDirtySet()
  const clock = createTestClockService({ now: NOW })
  const writer = createIndexWriter(
    {
      indexStore: store,
      noteFile: files,
      indexQuery: createIndexQueryService({ database }),
      database,
      xArchive: createTestXArchiveService(),
      clock,
      logger,
      emitChangesApplied: (changes) => {
        reports.push([...changes])
        writesAtReport.push(writes())
        options?.report?.()
      },
      emitMoved: (from, to) => {
        moves.push([from, to])
      },
      canWrite: () => gate.canWrite,
    },
    { dirty, generation: INDEX_GENERATION, fileGeneration: FILE_GENERATION },
  )
  return {
    writer,
    dirty,
    store,
    files,
    clock,
    logger,
    reads,
    writes,
    gate,
    reports,
    writesAtReport,
    moves,
  }
}

describe('createIndexWriter', () => {
  it('writes upserts in one batch and removes at its generation, and reports each commit seq', async () => {
    const { writer, dirty, store } = setup({ files: { 'notes/a.md': '# a', 'notes/b.md': '# b' } })

    dirty.add('notes/a.md', { modifiedMs: 4242 })
    dirty.add('notes/b.md')
    dirty.add('notes/gone.md', { kind: 'remove' })
    const outcomes = await Promise.all(
      ['notes/a.md', 'notes/b.md', 'notes/gone.md'].map((path) => writer.settled(path)),
    )

    expect(store.calls()).toMatchObject([
      { method: 'applyBatch', generation: INDEX_GENERATION },
      { method: 'remove', path: 'notes/gone.md', generation: INDEX_GENERATION },
    ])
    expect(store.applied().map((note) => [note.path, note.mtime])).toEqual([
      ['notes/a.md', 4242],
      ['notes/b.md', NOW],
    ])
    expect(outcomes).toEqual([
      { status: 'applied', seq: 1 },
      { status: 'applied', seq: 1 },
      { status: 'applied', seq: 2 },
    ])
  })

  it('reads the file when the run starts, not when the path was added', async () => {
    const { writer, dirty, files, store } = setup({ files: { 'notes/a.md': '# first' } })

    dirty.add('notes/a.md')
    files.set('notes/a.md', '# second')
    await writer.drained()

    expect(store.applied().map((note) => note.title)).toEqual(['second'])
  })

  it('writes hinted content without a read', async () => {
    const { writer, dirty, store, reads } = setup({ files: { 'notes/a.md': '# on disk' } })

    dirty.add('notes/a.md', { note: noteOf('# hinted'), modifiedMs: 7 })
    await writer.drained()

    expect(reads).toEqual([])
    expect(store.applied().map((note) => [note.title, note.mtime])).toEqual([['hinted', 7]])
  })

  it('reads the file when a later add without content replaced a content hint', async () => {
    const { writer, dirty, store, reads } = setup({ files: { 'notes/a.md': '# on disk' } })

    dirty.add('notes/a.md', { note: noteOf('# hinted') })
    dirty.add('notes/a.md')
    await writer.drained()

    expect(reads).toEqual(['notes/a.md'])
    expect(store.applied().map((note) => note.title)).toEqual(['on disk'])
  })

  it('writes a path again when it turns dirty during its run', async () => {
    const firstRead = Promise.withResolvers<void>()
    const { writer, dirty, store, reads } = setup({
      files: { 'notes/a.md': '# on disk' },
      read: () => firstRead.promise,
    })

    dirty.add('notes/a.md')
    await vi.waitFor(() => expect(reads).toEqual(['notes/a.md']))
    dirty.add('notes/a.md', { note: noteOf('# newer') })
    const newer = writer.settled('notes/a.md')
    firstRead.resolve()

    await expect(newer).resolves.toEqual({ status: 'applied', seq: 2 })
    expect(store.applied().map((note) => note.title)).toEqual(['on disk', 'newer'])
  })

  it('runs one at a time: a path added during a run waits for the next run', async () => {
    const slowRead = Promise.withResolvers<void>()
    const { writer, dirty, reads, writes } = setup({
      files: { 'notes/slow.md': '# slow', 'notes/fast.md': '# fast' },
      read: async (path) => {
        if (path === 'notes/slow.md') {
          await slowRead.promise
        }
      },
    })

    dirty.add('notes/slow.md')
    await vi.waitFor(() => expect(reads).toEqual(['notes/slow.md']))
    dirty.add('notes/fast.md')
    await Promise.resolve()
    expect(reads).toEqual(['notes/slow.md'])

    slowRead.resolve()
    await writer.drained()
    expect(writes()).toEqual(['apply:notes/slow.md', 'apply:notes/fast.md'])
  })

  it('writes and reports a `settledFirst` path ahead of the rest of the run in flight', async () => {
    const gates: Record<string, PromiseWithResolvers<void>> = {
      'notes/a.md': Promise.withResolvers(),
      'notes/c.md': Promise.withResolvers(),
    }
    const { writer, dirty, reads, writes, reports } = setup({
      files: { 'notes/a.md': '# a', 'notes/b.md': '# b', 'notes/c.md': '# c' },
      read: (path) => gates[path]?.promise,
    })
    for (const path of ['notes/a.md', 'notes/b.md', 'notes/c.md']) {
      dirty.add(path, { bulk: true })
    }
    await vi.waitFor(() => expect(reads).toEqual(['notes/a.md']))

    dirty.add('notes/now.md', { note: noteOf('# now') })
    const first = writer.settledFirst('notes/now.md')
    gates['notes/a.md']!.resolve()

    expect(await first).toEqual({ status: 'applied', seq: 2 })
    expect(writes()).toEqual(['apply:notes/a.md', 'apply:notes/now.md'])
    expect(reports).toEqual([[{ path: 'notes/now.md', kind: 'upsert' }]])

    gates['notes/c.md']!.resolve()
    await writer.drained()
    expect(writes()).toEqual([
      'apply:notes/a.md',
      'apply:notes/now.md',
      'apply:notes/b.md',
      'apply:notes/c.md',
    ])
  })

  it('writes a `settledFirst` path once, with its newer hint, when the run already took it', async () => {
    const gate = Promise.withResolvers<void>()
    const { writer, dirty, reads, writes } = setup({
      files: { 'notes/a.md': '# a', 'notes/p.md': '# old' },
      read: (path) => (path === 'notes/a.md' ? gate.promise : undefined),
    })
    dirty.add('notes/a.md', { bulk: true })
    dirty.add('notes/p.md', { bulk: true })
    const taken = writer.settled('notes/p.md')
    await vi.waitFor(() => expect(reads).toEqual(['notes/a.md']))

    dirty.add('notes/p.md', { note: noteOf('# new') })
    const first = writer.settledFirst('notes/p.md')
    gate.resolve()

    expect(await Promise.all([taken, first])).toEqual([
      { status: 'applied', seq: 2 },
      { status: 'applied', seq: 2 },
    ])
    await writer.drained()
    expect(writes()).toEqual(['apply:notes/a.md', 'apply:notes/p.md'])
    expect(reads).toEqual(['notes/a.md'])
  })

  it('gives a failed read to the waiter and writes the rest of the run', async () => {
    const { writer, dirty, writes, logger } = setup({
      files: { 'notes/bad.md': '# bad', 'notes/good.md': '# ok' },
      read: (path) => {
        if (path === 'notes/bad.md') {
          throw new AppError('io', 'unreadable')
        }
      },
    })

    dirty.add('notes/bad.md')
    dirty.add('notes/good.md')
    const outcome = await writer.settled('notes/bad.md')
    await writer.drained()

    expect(outcome).toMatchObject({ status: 'failed', stage: 'read' })
    expect(writes()).toEqual(['apply:notes/good.md'])
    expect(logger.getErrors()).toEqual([])
  })

  it('logs a failure nobody waits for', async () => {
    const { writer, dirty, logger } = setup({
      files: { 'notes/bad.md': '# bad' },
      read: () => {
        throw new AppError('io', 'unreadable')
      },
    })

    dirty.add('notes/bad.md')
    await writer.drained()

    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'failed to index change for notes/bad.md:',
    ])
  })

  it('splits a refused batch until the failing note stands alone', async () => {
    const { writer, dirty, store } = setup({
      files: { 'notes/a.md': '# a', 'notes/bad.md': '# bad', 'notes/c.md': '# c' },
      failStore: (call) => {
        return call.method === 'applyBatch' &&
          call.notes.some((note) => note.path === 'notes/bad.md')
          ? new AppError('io', 'refused')
          : undefined
      },
    })

    dirty.add('notes/a.md')
    dirty.add('notes/bad.md')
    dirty.add('notes/c.md')
    const outcomes = await Promise.all(
      ['notes/a.md', 'notes/bad.md', 'notes/c.md'].map((path) => writer.settled(path)),
    )

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'failed', 'applied'])
    expect(outcomes[1]).toMatchObject({ stage: 'write' })
    expect(store.applied().map((note) => note.path)).toEqual(['notes/a.md', 'notes/c.md'])
  })

  it('writes a note again after its write failed, with a wait that doubles', async () => {
    let failures = 2
    const { writer, dirty, clock, store, reports } = setup({
      files: { 'notes/a.md': '# a' },
      failStore: (call) => {
        if (call.method !== 'applyBatch' || failures === 0) {
          return undefined
        }
        failures -= 1
        return new AppError('io', 'busy')
      },
    })

    dirty.add('notes/a.md', { bulk: true })
    expect(await writer.settled('notes/a.md')).toMatchObject({ status: 'failed', stage: 'write' })
    expect(dirty.has('notes/a.md')).toBe(false)

    await clock.advance(INDEX_RETRY_MIN_MS)
    await writer.drained()
    expect(store.applied()).toEqual([])

    await clock.advance(INDEX_RETRY_MIN_MS)
    await writer.drained()
    expect(store.applied()).toEqual([])

    await clock.advance(INDEX_RETRY_MIN_MS)
    await writer.drained()
    expect(store.applied().map((note) => note.path)).toEqual(['notes/a.md'])
    expect(reports).toEqual([[{ path: 'notes/a.md', kind: 'upsert' }]])
    expect(clock.pendingTimers()).toBe(0)
  })

  it('writes at most `INDEX_APPLY_BATCH_SIZE` notes in one transaction', async () => {
    const paths = Array.from(
      { length: INDEX_APPLY_BATCH_SIZE + 1 },
      (_, position) => `notes/n${position}.md`,
    )
    const { writer, dirty, store } = setup({
      files: Object.fromEntries(paths.map((path) => [path, `# ${path}`])),
    })

    for (const path of paths) {
      dirty.add(path)
    }
    await writer.drained()

    expect(
      store.calls().map((call) => (call.method === 'applyBatch' ? call.notes.length : call.method)),
    ).toEqual([INDEX_APPLY_BATCH_SIZE, 1])
  })

  it('lets the last kind of a path win: an upsert then a remove only removes', async () => {
    const { writer, dirty, writes } = setup()

    dirty.add('notes/x.md', { modifiedMs: 42 })
    dirty.add('notes/x.md', { kind: 'remove' })
    await writer.drained()

    expect(writes()).toEqual(['remove:notes/x.md'])
  })

  it('writes a note reported as removed when its file exists', async () => {
    const { writer, dirty, writes, reports } = setup({ files: { 'notes/x.md': '# recreated' } })

    dirty.add('notes/x.md', { kind: 'remove' })
    await writer.drained()

    expect(writes()).toEqual(['apply:notes/x.md'])
    expect(reports).toEqual([[{ path: 'notes/x.md', kind: 'upsert' }]])
  })

  it('removes the rows of an upsert whose file is gone', async () => {
    const { writer, dirty, writes, reports } = setup()

    dirty.add('notes/gone.md', { kind: 'remove' })
    dirty.add('notes/gone.md')
    const outcome = await writer.settled('notes/gone.md')

    expect(outcome.status).toBe('applied')
    expect(writes()).toEqual(['remove:notes/gone.md'])
    expect(reports).toEqual([[{ path: 'notes/gone.md', kind: 'upsert' }]])
  })

  it('writes a queued upsert before a later remove of the same run', async () => {
    const { writer, dirty, writes } = setup({ files: { 'notes/a.md': '# a' } })

    dirty.add('notes/a.md')
    dirty.add('notes/gone.md', { kind: 'remove' })
    await writer.drained()

    expect(writes()).toEqual(['apply:notes/a.md', 'remove:notes/gone.md'])
  })

  it('reports the settled paths of a run after its writes and before their waiters resume', async () => {
    const { writer, dirty, reports, writesAtReport, reads } = setup({
      files: { 'notes/a.md': '# a' },
    })

    dirty.add('assets/x.png', { modifiedMs: 3 })
    dirty.add('notes/a.md')
    dirty.add('notes/gone.md', { kind: 'remove' })
    await writer.settled('notes/a.md')

    expect(reports).toEqual([
      [
        { path: 'notes/a.md', kind: 'upsert' },
        { path: 'notes/gone.md', kind: 'remove' },
        { path: 'assets/x.png', kind: 'upsert', modifiedMs: 3 },
      ],
    ])
    expect(writesAtReport).toEqual([['apply:notes/a.md', 'remove:notes/gone.md']])
    expect(reads).toEqual(['notes/a.md'])
  })

  it('keeps writing after a report threw', async () => {
    const { writer, dirty, writes, logger } = setup({
      files: { 'notes/a.md': '# a', 'notes/b.md': '# b' },
      report: () => {
        throw new Error('listener failed')
      },
    })

    dirty.add('notes/a.md')
    const first = await writer.settled('notes/a.md')
    dirty.add('notes/b.md')
    const second = await writer.settled('notes/b.md')

    expect([first.status, second.status]).toEqual(['applied', 'applied'])
    expect(writes()).toEqual(['apply:notes/a.md', 'apply:notes/b.md'])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'index change report failed:',
      'index change report failed:',
    ])
  })

  it('reports neither a `bulk` path nor a failed one', async () => {
    const { writer, dirty, reports, writes } = setup({
      files: { 'notes/pass.md': '# pass', 'notes/bad.md': '# bad' },
      read: (path) => {
        if (path === 'notes/bad.md') {
          throw new AppError('io', 'unreadable')
        }
      },
    })

    dirty.add('notes/pass.md', { bulk: true })
    dirty.add('notes/bad.md')
    await writer.settled('notes/bad.md')
    await writer.drained()

    expect(writes()).toEqual(['apply:notes/pass.md'])
    expect(reports).toEqual([])
  })

  it('skips an upsert whose row already has the same old mtime, without a read', async () => {
    const { writer, dirty, reads, store } = setup({
      stored: [{ path: 'notes/a.md', markdown: '# Hello', fileHash: 'stored', mtime: 1_000 }],
    })

    dirty.add('notes/a.md', { modifiedMs: 1_000 })

    await expect(writer.settled('notes/a.md')).resolves.toEqual({ status: 'unchanged' })
    expect(reads).toEqual([])
    expect(store.calls()).toEqual([])
  })

  it('re-stamps the stored mtime when the content is unchanged but the mtime moved', async () => {
    const content = '# same content\n'
    const { writer, dirty, store } = setup({
      files: { 'notes/a.md': content },
      stored: [
        { path: 'notes/a.md', markdown: content, fileHash: await sha256Hex(content), mtime: 1_000 },
      ],
    })

    dirty.add('notes/a.md', { modifiedMs: 2_000 })

    await expect(writer.settled('notes/a.md')).resolves.toEqual({ status: 'applied', seq: 1 })
    expect(store.calls()).toEqual([
      {
        method: 'touch',
        entries: [{ path: 'notes/a.md', mtime: 2_000 }],
        generation: INDEX_GENERATION,
      },
    ])
  })

  it('still reads when the reported mtime is too fresh to trust', async () => {
    const { writer, dirty, reads, writes } = setup({
      files: { 'notes/a.md': '# fresh content' },
      stored: [{ path: 'notes/a.md', markdown: '# Hello', fileHash: 'stale', mtime: NOW - 10 }],
    })

    dirty.add('notes/a.md', { modifiedMs: NOW - 10 })
    await writer.drained()

    expect(reads).toEqual(['notes/a.md'])
    expect(writes()).toEqual(['apply:notes/a.md'])
  })

  it('writes a `force` path although its hash matches the row', async () => {
    const content = '# same content\n'
    const { writer, dirty, writes } = setup({
      files: { 'notes/a.md': content },
      stored: [
        { path: 'notes/a.md', markdown: content, fileHash: await sha256Hex(content), mtime: 1_000 },
      ],
    })

    dirty.add('notes/a.md', { modifiedMs: 1_000, force: true })
    await writer.drained()

    expect(writes()).toEqual(['apply:notes/a.md'])
  })

  it('stops a run before its write once paused, and writes the path after resume', async () => {
    const pendingRead = Promise.withResolvers<void>()
    const { writer, dirty, reads, writes } = setup({
      files: { 'notes/a.md': '# a' },
      read: () => pendingRead.promise,
    })

    dirty.add('notes/a.md')
    const outcome = writer.settled('notes/a.md')
    await vi.waitFor(() => expect(reads).toEqual(['notes/a.md']))
    writer.pause()
    pendingRead.resolve()

    await expect(outcome).resolves.toEqual({ status: 'deferred' })
    await writer.drained()
    expect(writes()).toEqual([])
    expect(dirty.has('notes/a.md')).toBe(true)

    writer.resume()
    await writer.drained()
    expect(writes()).toEqual(['apply:notes/a.md'])
  })

  it('keeps collecting paths while paused, and defers their waiters', async () => {
    const { writer, dirty, writes } = setup({ files: { 'notes/a.md': '# a', 'notes/b.md': '# b' } })

    writer.pause()
    dirty.add('notes/a.md')
    dirty.add('notes/b.md')

    await expect(writer.settled('notes/a.md')).resolves.toEqual({ status: 'deferred' })
    await writer.drained()
    expect(writes()).toEqual([])

    writer.resume()
    await writer.drained()
    expect(writes()).toEqual(['apply:notes/a.md', 'apply:notes/b.md'])
  })

  it('writes nothing while `canWrite` says no, until resumed', async () => {
    const { writer, dirty, gate, reads, writes } = setup({ files: { 'notes/a.md': '# a' } })

    gate.canWrite = false
    dirty.add('notes/a.md')
    await writer.drained()
    expect(reads).toEqual([])
    expect(writes()).toEqual([])

    gate.canWrite = true
    writer.resume()
    await writer.drained()
    expect(writes()).toEqual(['apply:notes/a.md'])
  })

  it('wipes the tables in order with its runs', async () => {
    const { writer, dirty, writes } = setup({ files: { 'notes/a.md': '# a', 'notes/b.md': '# b' } })

    dirty.add('notes/a.md')
    await writer.drained()
    const commit = writer.clear()
    dirty.add('notes/b.md')

    await expect(commit).resolves.toEqual({ seq: 2 })
    await writer.drained()
    expect(writes()).toEqual(['apply:notes/a.md', 'clear', 'apply:notes/b.md'])
  })

  it('stops for good once disposed', async () => {
    const { writer, dirty, store } = setup({ files: { 'notes/a.md': '# a' } })

    writer.dispose()
    dirty.add('notes/a.md')

    await expect(writer.settled('notes/a.md')).resolves.toEqual({ status: 'deferred' })
    await writer.drained()
    expect(store.calls()).toEqual([])
  })
})

describe('createIndexWriter move healing (Plan 17)', () => {
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

  it('heals an external rename of one run: the rows move, then the new path is written', async () => {
    const { writer, dirty, store, writes, moves, reads } = setupRename()

    dirty.add(OLD, { kind: 'remove' })
    dirty.add(NEW, { modifiedMs: 42 })
    const outcomes = await Promise.all([writer.settled(OLD), writer.settled(NEW)])

    expect(writes()).toEqual([`move:${OLD}>${NEW}`, `apply:${NEW}`])
    expect(store.applied().map((note) => note.mtime)).toEqual([42])
    expect(moves).toEqual([[OLD, NEW]])
    expect(outcomes).toEqual([
      { status: 'applied', seq: 1 },
      { status: 'applied', seq: 2 },
    ])
    expect(reads).toEqual([NEW])
  })

  it('falls back to remove and apply when the ids do not match', async () => {
    const { writer, dirty, writes, moves } = setupRename({
      rowContent: '---\nid: 01zzzzzzzzzzzzzzzzzzzzzzzz\n---\n# Meeting Notes\n',
    })

    dirty.add(OLD, { kind: 'remove' })
    dirty.add(NEW)
    await writer.drained()

    expect(moves).toEqual([])
    expect(writes()).toEqual([`remove:${OLD}`, `apply:${NEW}`])
  })

  it('never pairs when the removed path has no row left', async () => {
    const { writer, dirty, writes, moves } = setup({ files: { [NEW]: CONTENT } })

    dirty.add(OLD, { kind: 'remove' })
    dirty.add(NEW)
    await writer.drained()

    expect(moves).toEqual([])
    expect(writes()).toEqual([`remove:${OLD}`, `apply:${NEW}`])
  })

  it('logs a refused move and falls back to remove and apply', async () => {
    const { writer, dirty, writes, moves, logger } = setup({
      files: { [NEW]: CONTENT },
      indexed: [{ path: OLD, markdown: CONTENT }],
      failStore: (call) => (call.method === 'move' ? new AppError('io', 'refused') : undefined),
    })

    dirty.add(OLD, { kind: 'remove' })
    dirty.add(NEW)
    await writer.drained()

    expect(moves).toEqual([])
    expect(writes()).toEqual([`move:${OLD}>${NEW}`, `remove:${OLD}`, `apply:${NEW}`])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      `id-based move failed (${OLD} → ${NEW}):`,
    ])
  })
})
