import { describe, expect, it, vi } from 'vitest'
import { createNoteSession, type NoteSession, type NoteSessionSnapshot } from './note-session'
import {
  flushOpenDocuments,
  openSession,
  registerOpenDocument,
  reloadOpenDocuments,
} from './open-documents'

function fakeSession(path: string, log: string[]): NoteSession {
  return {
    ownerId: null,
    path,
    retarget: async () => {},
    releaseRetargetedPath: async () => {},
    load: () => {},
    editorChanged: () => {},
    externalChanged: () => {
      log.push(`externalChanged:${path}`)
    },
    flush: async () => {
      log.push(`flush:${path}`)
    },
    keepMine: () => {},
    isDirty: () => false,
    loadTheirs: () => {},
    commitFrontmatter: async () => true,
    content: () => '',
    liveContent: () => '',
    readFreshContent: async () => ({ source: '', revision: '' }),
    updateFrontmatter: () => true,
    commitTaskToggle: async () => false,
    commitTaskEdit: async () => false,
    commitTaskRemove: async () => false,
    commitTaskToBullet: async () => false,
    commitBodyAppend: async () => false,
    commitBodyMutation: async () => ({ status: 'refused', reason: 'no_write' }),
    commitConditionalTrash: async () => ({ kind: 'refused', reason: 'no_write' }),
    dispose: () => {},
    discard: () => {},
  }
}

describe('open documents', () => {
  it('looks up the live session by path and forgets it on unregister', () => {
    const session = fakeSession('notes/a.md', [])
    const unregister = registerOpenDocument({ session })
    expect(openSession('notes/a.md')).toBe(session)
    unregister()
    expect(openSession('notes/a.md')).toBeNull()
  })

  it('a reopened path replaces the entry; the old unregister cannot evict it', () => {
    const first = fakeSession('notes/a.md', [])
    const second = fakeSession('notes/a.md', [])
    const unregisterFirst = registerOpenDocument({ session: first })
    const unregisterSecond = registerOpenDocument({ session: second })
    unregisterFirst() // stale unregister after the reopen — must be a no-op
    expect(openSession('notes/a.md')).toBe(second)
    unregisterSecond()
  })

  it('flushOpenDocuments flushes, then settles, then awaits the settle work', async () => {
    const log: string[] = []
    const unregister = registerOpenDocument({
      session: fakeSession('notes/a.md', log),
      settle: () => {
        log.push('settle')
      },
      settled: async () => {
        await Promise.resolve()
        log.push('settled')
      },
    })
    try {
      await flushOpenDocuments()
      expect(log).toEqual(['flush:notes/a.md', 'settle', 'settled'])
    } finally {
      unregister()
    }
  })

  it('reloadOpenDocuments asks every open session to reconcile against disk', () => {
    const log: string[] = []
    const unregisterA = registerOpenDocument({ session: fakeSession('notes/a.md', log) })
    const unregisterB = registerOpenDocument({ session: fakeSession('notes/b.md', log) })
    try {
      reloadOpenDocuments()
      expect(log).toEqual(['externalChanged:notes/a.md', 'externalChanged:notes/b.md'])
    } finally {
      unregisterA()
      unregisterB()
    }
  })

  it('one failing document does not block the others, and nothing rejects', async () => {
    const log: string[] = []
    const failing = fakeSession('notes/bad.md', log)
    failing.flush = async () => {
      throw new Error('disk full')
    }
    const unregisterBad = registerOpenDocument({ session: failing })
    const unregisterGood = registerOpenDocument({ session: fakeSession('notes/good.md', log) })
    try {
      await expect(flushOpenDocuments()).resolves.toBeUndefined()
      expect(log).toContain('flush:notes/good.md')
    } finally {
      unregisterBad()
      unregisterGood()
    }
  })
})

describe('retargetOpenDocument (Plan 17)', () => {
  it('re-keys the entry; the original unregister still finds it by identity', async () => {
    const { retargetOpenDocument } = await import('./open-documents')
    const session = fakeSession('notes/a.md', [])
    const unregister = registerOpenDocument({ session })

    retargetOpenDocument('notes/a.md', 'notes/renamed.md', session)
    expect(openSession('notes/a.md')).toBeNull()
    expect(openSession('notes/renamed.md')).toBe(session)

    unregister() // registered under a.md, re-keyed since — must still evict
    expect(openSession('notes/renamed.md')).toBeNull()
  })

  it('re-keying a path with no entry is a no-op', async () => {
    const { retargetOpenDocument } = await import('./open-documents')
    retargetOpenDocument('notes/ghost.md', 'notes/elsewhere.md', fakeSession('notes/ghost.md', []))
    expect(openSession('notes/elsewhere.md')).toBeNull()
  })

  it("never re-keys a different pane's document at the same path", async () => {
    // The failed-move compensation re-keys (to → from); when the entry at
    // `to` belongs to another pane, it must stay exactly where it is.
    const { retargetOpenDocument } = await import('./open-documents')
    const foreign = fakeSession('notes/taken.md', [])
    const unregister = registerOpenDocument({ session: foreign })
    try {
      retargetOpenDocument('notes/taken.md', 'notes/old.md', fakeSession('notes/taken.md', []))
      expect(openSession('notes/taken.md')).toBe(foreign)
      expect(openSession('notes/old.md')).toBeNull()
    } finally {
      unregister()
    }
  })
})

describe('reloadOpenDocuments with live sessions', () => {
  // The iOS resume bug: the index reconcile re-reads a remotely edited note
  // into the index but emits no `index:changed`, so nothing ever told the open
  // session and it kept showing stale content until the app was relaunched.
  // These pin the whole path with real sessions: content changes on disk, no
  // file event fires, the reload converges the editor.

  function liveSession(
    read: () => string,
    applied: string[],
    snapshots: NoteSessionSnapshot[],
  ): NoteSession {
    return createNoteSession({
      path: 'notes/stale.md',
      // No writer: the session tracks dirtiness but never writes, so a dirty
      // buffer can't race a debounced save into the assertions.
      io: { read: async () => read(), write: null, writeIfRevision: null },
      classify: () => 'exact',
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot)
      },
      applyContent: (markdown) => {
        applied.push(markdown)
      },
    })
  }

  it('a clean open note adopts the new disk content silently', async () => {
    let disk = '# Old\n'
    const applied: string[] = []
    const snapshots: NoteSessionSnapshot[] = []
    const session = liveSession(() => disk, applied, snapshots)
    const unregister = registerOpenDocument({ session })
    try {
      session.load()
      await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))

      disk = '# New from the Mac\n' // the reconcile saw this; no index:changed fired
      reloadOpenDocuments()

      await vi.waitFor(() => expect(applied).toContain('# New from the Mac\n'))
      expect(snapshots.at(-1)?.conflict).toBeNull()
    } finally {
      unregister()
      session.dispose()
    }
  })

  it('a dirty open note parks the conflict banner instead of losing edits', async () => {
    let disk = '# Old\n'
    const snapshots: NoteSessionSnapshot[] = []
    const session = liveSession(() => disk, [], snapshots)
    const unregister = registerOpenDocument({ session })
    try {
      session.load()
      await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
      session.editorChanged('# Old\nmy unsaved line\n')

      disk = '# New from the Mac\n'
      reloadOpenDocuments()

      await vi.waitFor(() => expect(snapshots.at(-1)?.conflict).toBe('# New from the Mac\n'))
      expect(snapshots.at(-1)?.dirty).toBe(true)
    } finally {
      unregister()
      session.discard() // never flush the deliberately-dirty buffer
    }
  })

  it('an unchanged file is a no-op read: no editor push, no conflict', async () => {
    const applied: string[] = []
    const snapshots: NoteSessionSnapshot[] = []
    const session = liveSession(() => '# Old\n', applied, snapshots)
    const unregister = registerOpenDocument({ session })
    try {
      session.load()
      await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
      const settled = snapshots.length

      reloadOpenDocuments()
      await new Promise((resolve) => setTimeout(resolve, 0)) // drain the reconcile read

      expect(applied).toEqual([])
      expect(snapshots).toHaveLength(settled) // the echo guard emitted nothing
    } finally {
      unregister()
      session.dispose()
    }
  })
})
