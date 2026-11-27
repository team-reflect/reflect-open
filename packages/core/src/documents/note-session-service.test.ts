import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import {
  createTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
} from '../testing/database.ts'
import { createLinkedDailyNoteService } from './linked-daily-note-service.ts'
import { createTestFileChangeService, type TestFileChangeService } from '../testing/file-change.ts'
import {
  createTestNoteCreationService,
  createTestNoteFileService,
  type TestNoteFileService,
} from '../testing/graph.ts'
import {
  createTestGraphSessionService,
  type TestGraphSessionService,
} from '../testing/graph-session.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createNoteSessionService, type SessionCoordinator } from './note-session-service.ts'
import type { NoteSession, NoteSessionService } from './note-session-types.ts'
import { noop } from '@ocavue/utils'

const PATH = 'notes/a.md'

let clock: TestClockService
let fileChanges: TestFileChangeService
let noteFile: TestNoteFileService
let database: TestDatabaseService
let graphSession: TestGraphSessionService
let coordinators: Array<{ path: string; log: string[] }>
let noteSessions: NoteSessionService

function setup(files: Record<string, string>): void {
  noteFile = createTestNoteFileService({ files })
  database = createTestDatabaseService()
  graphSession = createTestGraphSessionService({ graph: { generation: 1 } })
  noteSessions = createNoteSessionService({
    noteFile,
    clock,
    logger: createTestLoggerService(),
    graphSession,
    fileChanges,
    noteCreation: createTestNoteCreationService(),
    linkedDailyNotes: createLinkedDailyNoteService({
      noteFile,
      wikiResolver: createWikiResolverService({ database }),
      logger: createTestLoggerService(),
    }),
    createCoordinator: (path): SessionCoordinator => {
      const coordinator = { path, log: [] as string[] }
      coordinators.push(coordinator)
      return {
        content: noop,
        settle: () => {
          coordinator.log.push('settle')
        },
        settled: noop,
        retarget: (to) => {
          coordinator.log.push(`retarget:${to}`)
        },
        dispose: () => {
          coordinator.log.push('dispose')
        },
      }
    },
  })
}

/**
 * Let pending reads, writes and microtasks finish.
 */
async function settled(): Promise<void> {
  await clock.advance(50)
}

/**
 * Subscribe to `session` as a view does, and wait for its load.
 */
async function observe(session: NoteSession): Promise<() => void> {
  const unlisten = session.subscribe(vi.fn())
  await settled()
  return unlisten
}

beforeEach(() => {
  clock = createTestClockService()
  fileChanges = createTestFileChangeService()
  coordinators = []
  setup({ [PATH]: '# A\n' })
})

describe('sessionFor', () => {
  it('returns one session per path and reads nothing until it is observed', async () => {
    const read = vi.spyOn(noteFile, 'readWithHash')
    const session = noteSessions.sessionFor(PATH)

    expect(noteSessions.sessionFor(PATH)).toBe(session)
    expect(noteSessions.existingSessionFor(PATH)).toBe(session)
    expect(noteSessions.existingSessionFor('notes/b.md')).toBeNull()
    await settled()
    expect(read).not.toHaveBeenCalled()
    expect(session.get().status).toBe('loading')

    await observe(session)
    expect(session.get().status).toBe('ready')
    expect(session.editorSeed()).toBe('# A\n')
  })

  it('derives lazy creation, the seed and rename tracking from the path', async () => {
    const daily = noteSessions.sessionFor('daily/2026-11-26.md')
    const untitled = noteSessions.sessionFor('notes/01arz3ndektsv4rrffq69g5fav.md')
    const missing = noteSessions.sessionFor('notes/missing.md')
    await Promise.all([observe(daily), observe(untitled), observe(missing)])

    expect(daily.get()).toMatchObject({ status: 'ready', missing: true })
    expect(daily.editorSeed()).toBe('')
    expect(untitled.editorSeed()).toBe('#\n')
    expect(missing.get().status).toBe('error')
    expect(coordinators.map((coordinator) => coordinator.path)).toEqual([
      'notes/01arz3ndektsv4rrffq69g5fav.md',
      'notes/missing.md',
    ])
  })

  it('prefetch loads a session before a view observes it', async () => {
    noteSessions.prefetch(PATH)
    await settled()

    expect(noteSessions.sessionFor(PATH).get().status).toBe('ready')
  })
})

describe('an unobserved session', () => {
  it('keeps its text when the last view leaves, and shows it to the next view at once', async () => {
    const session = noteSessions.sessionFor(PATH)
    const unlisten = await observe(session)
    session.editorChanged('# A\n\ntyped\n')
    unlisten()
    await settled()
    expect(noteFile.files().get(PATH)).toBe('# A\n\ntyped\n')

    const again = noteSessions.sessionFor(PATH)
    const statuses: string[] = []
    again.subscribe(() => {
      statuses.push(again.get().status)
    })

    // Before its check of the file resolves.
    expect(again).toBe(session)
    expect(again.get().status).toBe('ready')
    expect(again.editorSeed()).toBe('# A\n\ntyped\n')
    await settled()
    expect(statuses).not.toContain('loading')
  })

  it('settles its coordinator after the flush when the last view leaves', async () => {
    const session = noteSessions.sessionFor(PATH)
    const first = await observe(session)
    const second = session.subscribe(vi.fn())

    first()
    await settled()
    expect(coordinators[0]?.log).toEqual([])

    second()
    await settled()
    expect(coordinators[0]?.log).toEqual(['settle'])
  })

  it('stays observed when a view swaps its subscription in one task', async () => {
    const session = noteSessions.sessionFor(PATH)
    const first = await observe(session)

    first()
    session.subscribe(vi.fn())
    await settled()

    expect(coordinators[0]?.log).toEqual([])
  })

  it('reads no file on a change, and catches up when it is next observed', async () => {
    const session = noteSessions.sessionFor(PATH)
    ;(await observe(session))()
    await settled()
    const read = vi.spyOn(noteFile, 'readWithHash')

    noteFile.set(PATH, '# From the Mac\n')
    fileChanges.emit({ changes: [{ path: PATH, kind: 'upsert' }], source: 'external' })
    await settled()
    expect(read).not.toHaveBeenCalled()
    expect(session.editorSeed()).toBe('# A\n')

    await observe(session)
    expect(session.get().status).toBe('ready')
    expect(session.editorSeed()).toBe('# From the Mac\n')
  })

  it('catches up before currentSessionFor returns it', async () => {
    const session = noteSessions.sessionFor(PATH)
    ;(await observe(session))()
    await settled()
    noteFile.set(PATH, '# From the Mac\n')
    noteSessions.invalidateAll()

    const current = await noteSessions.currentSessionFor(PATH)

    expect(current).toBe(session)
    expect(current?.liveContent()).toBe('# From the Mac\n')
    await expect(noteSessions.currentSessionFor('notes/b.md')).resolves.toBeNull()
  })

  it('reads again when the file changes during its catch-up', async () => {
    const session = noteSessions.sessionFor(PATH)
    ;(await observe(session))()
    await settled()
    noteFile.set(PATH, '# One\n')
    noteSessions.invalidateAll()
    const read = noteFile.readWithHash.bind(noteFile)
    vi.spyOn(noteFile, 'readWithHash').mockImplementationOnce(async (path, generation) => {
      const result = await read(path, generation)
      noteFile.set(PATH, '# Two\n')
      noteSessions.invalidateAll()
      return result
    })

    const current = await noteSessions.currentSessionFor(PATH)

    expect(current?.liveContent()).toBe('# Two\n')
  })

  it('is forgotten when its clean note file is removed', async () => {
    const session = noteSessions.sessionFor(PATH)
    ;(await observe(session))()
    await settled()

    fileChanges.emit({ changes: [{ path: PATH, kind: 'remove' }], source: 'external' })
    await settled()

    expect(noteSessions.existingSessionFor(PATH)).toBeNull()
    expect(coordinators[0]?.log).toContain('dispose')
  })

  it('ends as a fresh load does when its file is gone at the next observe', async () => {
    setup({ [PATH]: '# A\n', 'daily/2026-11-26.md': 'today\n' })
    const note = noteSessions.sessionFor(PATH)
    const daily = noteSessions.sessionFor('daily/2026-11-26.md')
    ;(await observe(note))()
    ;(await observe(daily))()
    await settled()
    await noteFile.delete(PATH, 1)
    await noteFile.delete('daily/2026-11-26.md', 1)
    noteSessions.invalidateAll()

    await observe(note)
    await observe(daily)

    expect(note.get().status).toBe('error')
    expect(daily.get()).toMatchObject({ status: 'ready', missing: true })
    expect(daily.editorSeed()).toBe('')
  })

  it('keeps unsaved edits and retries a failed save with no view', async () => {
    const session = noteSessions.sessionFor(PATH)
    const unlisten = await observe(session)
    const write = vi.spyOn(noteFile, 'write').mockRejectedValueOnce(new Error('disk full'))
    session.editorChanged('# A\n\ntyped\n')

    unlisten()
    await settled()

    expect(write).toHaveBeenCalledTimes(2)
    expect(noteFile.files().get(PATH)).toBe('# A\n\ntyped\n')
    expect(noteSessions.sessionFor(PATH)).toBe(session)
  })

  it('disposes the least recently observed clean sessions beyond the limit', async () => {
    const first = noteSessions.sessionFor(PATH)
    ;(await observe(first))()
    await settled()

    for (let i = 0; i < 32; i += 1) {
      noteSessions.prefetch(`daily/2026-01-${String(i + 1).padStart(2, '0')}.md`)
    }

    expect(noteSessions.existingSessionFor(PATH)).toBeNull()
    expect(noteSessions.sessionFor(PATH)).not.toBe(first)
  })

  it('keeps a session with unsaved edits beyond the limit', async () => {
    const dirty = noteSessions.sessionFor(PATH)
    const unlisten = await observe(dirty)
    vi.spyOn(noteFile, 'write').mockRejectedValue(new Error('disk full'))
    dirty.editorChanged('# A\n\ntyped\n')
    unlisten()
    await settled()

    for (let i = 0; i < 40; i += 1) {
      noteSessions.prefetch(`daily/2026-01-${String(i + 1).padStart(2, '0')}.md`)
    }

    expect(noteSessions.existingSessionFor(PATH)).toBe(dirty)
    expect(noteSessions.dirtyPaths()).toEqual([PATH])
  })
})

describe('an observed session', () => {
  it('reconciles with the file on an upsert of its path', async () => {
    const session = noteSessions.sessionFor(PATH)
    await observe(session)

    noteFile.set(PATH, '# From the Mac\n')
    fileChanges.emit({ changes: [{ path: 'notes/b.md', kind: 'upsert' }], source: 'external' })
    await settled()
    expect(session.editorSeed()).toBe('# A\n')

    fileChanges.emit({ changes: [{ path: PATH, kind: 'upsert' }], source: 'external' })
    await settled()
    expect(session.editorSeed()).toBe('# From the Mac\n')
  })

  it('reconciles on invalidateAll, the signal of a reconcile pass', async () => {
    const session = noteSessions.sessionFor(PATH)
    await observe(session)

    noteFile.set(PATH, '# From the Mac\n')
    noteSessions.invalidateAll()
    await settled()

    expect(session.editorSeed()).toBe('# From the Mac\n')
    expect(session.get().dirty).toBe(false)
  })

  it('shows a removed note as a fresh load does when a view returns', async () => {
    const session = noteSessions.sessionFor(PATH)
    const unlisten = await observe(session)
    await noteFile.delete(PATH, 1)
    fileChanges.emit({ changes: [{ path: PATH, kind: 'remove' }], source: 'external' })
    await settled()
    expect(session.editorSeed()).toBe('# A\n')

    unlisten()
    await settled()
    await observe(noteSessions.sessionFor(PATH))

    expect(noteSessions.sessionFor(PATH).get().status).toBe('error')
  })

  it('loads a note that failed to load when its file appears', async () => {
    const session = noteSessions.sessionFor('notes/later.md')
    await observe(session)
    expect(session.get().status).toBe('error')

    noteFile.set('notes/later.md', '# Later\n')
    fileChanges.emit({ changes: [{ path: 'notes/later.md', kind: 'upsert' }], source: 'external' })
    await settled()

    expect(session.get().status).toBe('ready')
  })

  it('loads again when a view returns to a session that failed to load', async () => {
    const session = noteSessions.sessionFor('notes/later.md')
    ;(await observe(session))()
    await settled()
    expect(session.get().status).toBe('error')

    noteFile.set('notes/later.md', '# Later\n')
    await observe(session)

    expect(session.get().status).toBe('ready')
  })
})

describe('linked daily notes', () => {
  const DAY = 'daily/2026-12-01.md'
  const linker = { path: 'notes/b.md', markdown: '# B\n\n[[2026-12-01]]\n' }

  it('creates the daily note of a day that a saved note links to', async () => {
    const session = noteSessions.sessionFor(PATH)
    await observe(session)

    session.editorChanged('# A\n\n[[2026-12-01]]\n')
    await session.flush()
    await vi.waitFor(() => {
      expect(noteFile.files().get(DAY)).toBe('')
    })
  })

  it('creates the daily note of an opened day that has no file and that a note links to', async () => {
    seedNotes(database, [linker])
    await observe(noteSessions.sessionFor(DAY))
    await observe(noteSessions.sessionFor('daily/2026-12-02.md'))
    await vi.waitFor(() => {
      expect(noteFile.files().get(DAY)).toBe('')
    })
    expect(noteFile.files().has('daily/2026-12-02.md')).toBe(false)
  })

  it('creates no note for a session of a graph that is no longer open', async () => {
    seedNotes(database, [linker])
    const session = noteSessions.sessionFor(DAY)
    graphSession.setGraph({ root: '/other', generation: 1 })
    await observe(session)
    expect(session.get().status).toBe('ready')
    expect(noteFile.files().has(DAY)).toBe(false)
  })
})

describe('moveSession', () => {
  it('carries the session and its coordinator to the new path', async () => {
    const session = noteSessions.sessionFor(PATH)
    await observe(session)

    expect(noteSessions.moveSession(PATH, 'notes/b.md')).toBe(session)

    expect(session.path).toBe('notes/b.md')
    expect(session.get().path).toBe('notes/b.md')
    expect(noteSessions.existingSessionFor(PATH)).toBeNull()
    expect(noteSessions.sessionFor('notes/b.md')).toBe(session)
    expect(coordinators[0]?.log).toEqual(['retarget:notes/b.md'])
    expect(noteSessions.moveSession('notes/none.md', 'notes/c.md')).toBeNull()
  })

  it('disposes a session already at the destination, after its flush', async () => {
    setup({ [PATH]: '# A\n', 'notes/b.md': '# B\n' })
    const session = noteSessions.sessionFor(PATH)
    const occupant = noteSessions.sessionFor('notes/b.md')
    await observe(session)
    await observe(occupant)
    occupant.editorChanged('# B\n\ntyped\n')

    noteSessions.moveSession(PATH, 'notes/b.md')
    await settled()

    expect(noteSessions.existingSessionFor('notes/b.md')).toBe(session)
    expect(noteFile.files().get('notes/b.md')).toBe('# B\n\ntyped\n')
  })

  it('routes a change of the new path to the moved session', async () => {
    const session = noteSessions.sessionFor(PATH)
    await observe(session)
    noteSessions.moveSession(PATH, 'notes/b.md')

    noteFile.set('notes/b.md', '# Moved and edited\n')
    fileChanges.emit({ changes: [{ path: 'notes/b.md', kind: 'upsert' }], source: 'external' })
    await settled()

    expect(session.editorSeed()).toBe('# Moved and edited\n')
  })
})

describe('discardSession', () => {
  it('forgets the session and disposes its coordinator without settling', async () => {
    const session = noteSessions.sessionFor(PATH)
    await observe(session)

    noteSessions.discardSession(PATH)

    expect(noteSessions.existingSessionFor(PATH)).toBeNull()
    expect(coordinators[0]?.log).toEqual(['dispose'])
  })
})

describe('teardown', () => {
  it('flushAll lands every buffer, then settles each coordinator', async () => {
    const session = noteSessions.sessionFor(PATH)
    await observe(session)
    session.editorChanged('# A\n\ntyped\n')

    await noteSessions.flushAll()

    expect(noteFile.files().get(PATH)).toBe('# A\n\ntyped\n')
    expect(coordinators[0]?.log).toEqual(['settle'])
  })

  it('releaseAll flushes and forgets every session', async () => {
    const session = noteSessions.sessionFor(PATH)
    await observe(session)
    session.editorChanged('# A\n\ntyped\n')

    noteSessions.releaseAll()
    await settled()

    expect(noteFile.files().get(PATH)).toBe('# A\n\ntyped\n')
    expect(noteSessions.existingSessionFor(PATH)).toBeNull()
    expect(coordinators[0]?.log).toEqual(['settle', 'dispose'])
  })

  it('listens to file changes only while it holds a session', async () => {
    expect(fileChanges.listenerCount().changes).toBe(0)
    const session = noteSessions.sessionFor(PATH)
    expect(fileChanges.listenerCount().changes).toBe(1)

    await observe(session)
    noteSessions.discardSession(PATH)

    expect(fileChanges.listenerCount().changes).toBe(0)
  })
})
