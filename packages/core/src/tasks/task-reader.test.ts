import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { INDEX_COMMITTED_EVENT } from '../ipc/ipc-service.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createTestDatabaseService, seedNotes } from '../testing/database.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTaskReader } from './task-reader.ts'

function setup() {
  const database = createTestDatabaseService()
  const ipc = createTestIpcBridgeService()
  const clock = createTestClockService()
  const logger = createTestLoggerService()
  const reader = createTaskReader({ database, ipc, clock, logger })
  return { database, ipc, clock, logger, reader, signal: new AbortController().signal }
}

describe('read', () => {
  it('reads the tasks of every note by state, and every task of the given paths', async () => {
    const { database, reader, signal } = setup()
    seedNotes(database, [
      { path: 'notes/a.md', markdown: '+ [ ] open a\n+ [x] done a\n' },
      { path: 'notes/b.md', markdown: '+ [ ] open b\n' },
      { path: 'notes/plain.md', markdown: 'no task\n' },
    ])

    const open = await reader.readAll(false, signal)
    expect(open!.notes.map((note) => [note.path, note.tasks.map((task) => task.markdown)])).toEqual(
      [
        ['notes/a.md', ['open a']],
        ['notes/b.md', ['open b']],
      ],
    )

    const some = await reader.readPaths(['notes/a.md', 'notes/plain.md', 'notes/absent.md'], signal)
    expect(some!.seq).toBe(open!.seq)
    expect(some!.notes.map((note) => [note.path, note.hash, note.tasks.length])).toEqual([
      ['notes/a.md', 'hash-notes/a.md', 2],
    ])
  })

  it('tries a failed read again after a growing wait, until it succeeds', async () => {
    const { database, clock, logger, reader, signal } = setup()
    const read = vi
      .spyOn(database, 'read')
      .mockRejectedValueOnce(new AppError('io', 'database is locked'))
      .mockRejectedValueOnce(new AppError('io', 'database is locked'))

    const result = reader.readAll(false, signal)
    await clock.advance(249)
    expect(read).toHaveBeenCalledTimes(1)
    await clock.advance(1)
    expect(read).toHaveBeenCalledTimes(2)
    await clock.advance(499)
    expect(read).toHaveBeenCalledTimes(2)
    await clock.advance(1)

    expect(await result).toEqual({ seq: 0, notes: [] })
    expect(logger.getErrors()).toHaveLength(2)
  })

  it('stops trying and resolves null once the signal aborts', async () => {
    const { database, clock, reader } = setup()
    const read = vi.spyOn(database, 'read').mockRejectedValue(new AppError('io', 'closed'))
    const controller = new AbortController()

    const result = reader.readAll(false, controller.signal)
    await clock.advance(0)
    controller.abort()
    await clock.advance(60_000)

    expect(await result).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('subscribe', () => {
  it('delivers each commit until unlistened, and logs a payload that is not a commit', async () => {
    const { ipc, logger, reader } = setup()
    const commits = vi.fn()

    const unlisten = reader.subscribe(commits)
    await Promise.resolve()
    ipc.emit(INDEX_COMMITTED_EVENT, { seq: 3, paths: ['notes/a.md'] })
    ipc.emit(INDEX_COMMITTED_EVENT, { seq: 4, paths: null })
    ipc.emit(INDEX_COMMITTED_EVENT, null)

    expect(commits.mock.calls).toEqual([
      [{ seq: 3, paths: ['notes/a.md'] }],
      [{ seq: 4, paths: null }],
    ])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'invalid index:committed payload:',
    ])

    unlisten()
    ipc.emit(INDEX_COMMITTED_EVENT, { seq: 5, paths: null })
    expect(commits).toHaveBeenCalledTimes(2)
  })
})
