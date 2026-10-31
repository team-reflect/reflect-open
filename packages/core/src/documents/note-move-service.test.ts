import { describe, expect, it } from 'vitest'
import { createTestNoteSession } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestIndexStoreService } from '../testing/index-store.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createNoteMoveService, NOTE_MOVED_EVENT } from './note-move-service.ts'
import { createOpenDocumentsService } from './open-documents-service.ts'
import type { NoteSession } from './note-session-types.ts'

/**
 * The move service's carry/compensate contract (Plan 17): the session and
 * registry follow the file, a failure undoes exactly what was done — and
 * never touches a *different* pane's document that happens to sit at the
 * destination (the Bugbot-reported foreign-re-key case).
 */

function setup(options?: { sessions?: readonly NoteSession[]; moveError?: Error }) {
  const ipc = createTestIpcBridgeService()
  const indexStore = createTestIndexStoreService({
    fail: (call) => (call.method === 'moveIndexed' ? options?.moveError : undefined),
  })
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  for (const session of options?.sessions ?? []) {
    openDocuments.register({ session })
  }
  const logger = createTestLoggerService()
  const noteMove = createNoteMoveService({ ipc, indexStore, openDocuments, logger })
  const moves: Array<[string, string]> = []
  noteMove.onMoved((from, to) => {
    moves.push([from, to])
  })
  return { ipc, indexStore, openDocuments, logger, noteMove, moves }
}

describe('moveNote', () => {
  it('flushes, retargets, re-keys, moves, and announces', async () => {
    const session = createTestNoteSession({ path: 'notes/a.md' })
    const { noteMove, openDocuments, indexStore, moves } = setup({ sessions: [session] })

    await noteMove.moveNote('notes/a.md', 'notes/b.md', 7)

    expect(session.getCalls('flush')).toHaveLength(1)
    expect(session.path).toBe('notes/b.md')
    expect(openDocuments.sessionFor('notes/b.md')).toBe(session)
    expect(indexStore.calls()).toEqual([
      { method: 'moveIndexed', from: 'notes/a.md', to: 'notes/b.md', fileGeneration: 7 },
    ])
    expect(moves).toEqual([['notes/a.md', 'notes/b.md']])
  })

  it('a failed move with a carried session retargets and re-keys back', async () => {
    const session = createTestNoteSession({ path: 'notes/a.md' })
    const { noteMove, openDocuments, moves } = setup({
      sessions: [session],
      moveError: new Error('disk full'),
    })

    await expect(noteMove.moveNote('notes/a.md', 'notes/b.md', 7)).rejects.toThrow('disk full')

    expect(session.path).toBe('notes/a.md')
    expect(openDocuments.sessionFor('notes/a.md')).toBe(session)
    expect(openDocuments.sessionFor('notes/b.md')).toBeNull()
    expect(moves).toEqual([])
  })

  it("a failed move with no carried session never re-keys a foreign pane's document", async () => {
    // Another pane legitimately holds a note at the destination path.
    const foreign = createTestNoteSession({ path: 'notes/b.md' })
    const { noteMove, openDocuments } = setup({
      sessions: [foreign],
      moveError: new Error('refused'),
    })

    await expect(noteMove.moveNote('notes/a.md', 'notes/b.md', 7)).rejects.toThrow('refused')

    // The foreign document stays exactly where it was — quit-time flush and
    // sessionFor lookups keep targeting the right path.
    expect(openDocuments.sessionFor('notes/b.md')).toBe(foreign)
    expect(openDocuments.sessionFor('notes/a.md')).toBeNull()
    expect(foreign.path).toBe('notes/b.md')
  })
})

describe('followHealedMove', () => {
  it('carries a live session to the healed path and announces', () => {
    const session = createTestNoteSession({ path: 'notes/a.md' })
    const { noteMove, openDocuments, indexStore, moves } = setup({ sessions: [session] })

    noteMove.followHealedMove('notes/a.md', 'notes/renamed.md')

    // The open pane follows the externally renamed file: its next save
    // writes the new path instead of resurrecting the dead one.
    expect(session.path).toBe('notes/renamed.md')
    expect(session.getCalls('flush')).toHaveLength(0)
    expect(openDocuments.sessionFor('notes/renamed.md')).toBe(session)
    expect(openDocuments.sessionFor('notes/a.md')).toBeNull()
    expect(indexStore.calls()).toEqual([])
    expect(moves).toEqual([['notes/a.md', 'notes/renamed.md']])
  })

  it('a heal of a closed note just announces (routes still follow)', () => {
    const { noteMove, moves } = setup()

    noteMove.followHealedMove('notes/a.md', 'notes/renamed.md')

    expect(moves).toEqual([['notes/a.md', 'notes/renamed.md']])
  })
})

describe('onMoved', () => {
  it('stops delivering after the unsubscribe', () => {
    const { noteMove } = setup()
    const heard: Array<[string, string]> = []
    const unsubscribe = noteMove.onMoved((from, to) => {
      heard.push([from, to])
    })

    noteMove.followHealedMove('notes/a.md', 'notes/b.md')
    unsubscribe()
    noteMove.followHealedMove('notes/b.md', 'notes/c.md')

    expect(heard).toEqual([['notes/a.md', 'notes/b.md']])
  })

  it('isolates a throwing listener: later listeners still hear the move', () => {
    const { noteMove, logger } = setup()
    const failure = new Error('listener broke')
    const heard: Array<[string, string]> = []
    noteMove.onMoved(() => {
      throw failure
    })
    noteMove.onMoved((from, to) => {
      heard.push([from, to])
    })

    noteMove.followHealedMove('notes/a.md', 'notes/b.md')

    expect(heard).toEqual([['notes/a.md', 'notes/b.md']])
    expect(logger.getErrors()).toEqual([{ message: 'note-moved listener failed:', cause: failure }])
  })
})

describe('followNativeMoves', () => {
  it('follows each `note:moved` broadcast until unlistened', async () => {
    const session = createTestNoteSession({ path: 'notes/a.md' })
    const { noteMove, ipc, openDocuments, moves } = setup({ sessions: [session] })

    const unlisten = noteMove.followNativeMoves()
    await Promise.resolve()
    ipc.emit(NOTE_MOVED_EVENT, { from: 'notes/a.md', to: 'notes/b.md' })

    expect(session.path).toBe('notes/b.md')
    expect(openDocuments.sessionFor('notes/b.md')).toBe(session)
    expect(moves).toEqual([['notes/a.md', 'notes/b.md']])

    unlisten()
    ipc.emit(NOTE_MOVED_EVENT, { from: 'notes/b.md', to: 'notes/c.md' })
    expect(moves).toEqual([['notes/a.md', 'notes/b.md']])
  })

  it('logs a payload that is not a move and follows nothing', () => {
    const { noteMove, ipc, logger, moves } = setup()

    noteMove.followNativeMoves()
    ipc.emit(NOTE_MOVED_EVENT, { from: 'notes/a.md' })

    expect(moves).toEqual([])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'invalid note:moved payload:',
    ])
  })
})
