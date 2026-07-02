import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onNoteMoved } from '@/lib/note-moves'
import { followHealedMove, moveNoteCarryingSession } from './move-note'
import type { NoteSession } from './note-session'
import { openSession, registerOpenDocument } from './open-documents'

/**
 * The shared move helper's carry/compensate contract (Plan 17): the session
 * and registry follow the file, a failure undoes exactly what was done — and
 * never touches a *different* pane's document that happens to sit at the
 * destination (the Bugbot-reported foreign-re-key case).
 */

const core = vi.hoisted(() => ({ moveNoteIndexed: vi.fn() }))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  moveNoteIndexed: core.moveNoteIndexed,
}))

function fakeSession(path: string) {
  let current = path
  const flush = vi.fn(async () => {})
  const session: NoteSession = {
    get path() {
      return current
    },
    retarget: (to: string) => {
      current = to
    },
    load: () => {},
    editorChanged: () => {},
    externalChanged: () => {},
    flush,
    keepMine: () => {},
    loadTheirs: () => {},
    commitFrontmatter: async () => true,
    content: () => '',
    liveContent: () => '',
    updateFrontmatter: () => true,
    commitTaskToggle: async () => false,
    commitTaskEdit: async () => false,
    commitTaskRemove: async () => false,
    commitTaskToBullet: async () => false,
    commitBodyAppend: async () => false,
    dispose: () => {},
    discard: () => {},
  }
  return { session, flush }
}

beforeEach(() => {
  core.moveNoteIndexed.mockReset()
  core.moveNoteIndexed.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('moveNoteCarryingSession', () => {
  it('flushes, retargets, re-keys, moves, and announces', async () => {
    const { session, flush } = fakeSession('notes/a.md')
    const unregister = registerOpenDocument({ session })
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => moves.push([from, to]))
    try {
      await moveNoteCarryingSession('notes/a.md', 'notes/b.md', 7)

      expect(flush).toHaveBeenCalled()
      expect(session.path).toBe('notes/b.md')
      expect(openSession('notes/b.md')).toBe(session)
      expect(core.moveNoteIndexed).toHaveBeenCalledWith('notes/a.md', 'notes/b.md', 7)
      expect(moves).toEqual([['notes/a.md', 'notes/b.md']])
    } finally {
      unsubscribe()
      unregister()
    }
  })

  it('a failed move with a carried session retargets and re-keys back', async () => {
    core.moveNoteIndexed.mockRejectedValue(new Error('disk full'))
    const { session } = fakeSession('notes/a.md')
    const unregister = registerOpenDocument({ session })
    try {
      await expect(moveNoteCarryingSession('notes/a.md', 'notes/b.md', 7)).rejects.toThrow(
        'disk full',
      )
      expect(session.path).toBe('notes/a.md')
      expect(openSession('notes/a.md')).toBe(session)
      expect(openSession('notes/b.md')).toBeNull()
    } finally {
      unregister()
    }
  })

  it("a failed move with no carried session never re-keys a foreign pane's document", async () => {
    core.moveNoteIndexed.mockRejectedValue(new Error('refused'))
    // Another pane legitimately holds a note at the destination path.
    const foreign = fakeSession('notes/b.md')
    const unregister = registerOpenDocument({ session: foreign.session })
    try {
      await expect(moveNoteCarryingSession('notes/a.md', 'notes/b.md', 7)).rejects.toThrow(
        'refused',
      )
      // The foreign document stays exactly where it was — quit-time flush and
      // openSession lookups keep targeting the right path.
      expect(openSession('notes/b.md')).toBe(foreign.session)
      expect(openSession('notes/a.md')).toBeNull()
      expect(foreign.session.path).toBe('notes/b.md')
    } finally {
      unregister()
    }
  })
})

describe('followHealedMove', () => {
  it('carries a live session to the healed path and announces', () => {
    const { session } = fakeSession('notes/a.md')
    const unregister = registerOpenDocument({ session })
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => moves.push([from, to]))
    try {
      followHealedMove('notes/a.md', 'notes/renamed.md')

      // The open pane follows the externally renamed file: its next save
      // writes the new path instead of resurrecting the dead one.
      expect(session.path).toBe('notes/renamed.md')
      expect(openSession('notes/renamed.md')).toBe(session)
      expect(openSession('notes/a.md')).toBeNull()
      expect(moves).toEqual([['notes/a.md', 'notes/renamed.md']])
    } finally {
      unsubscribe()
      unregister()
    }
  })

  it('a heal of a closed note just announces (routes still follow)', () => {
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => moves.push([from, to]))
    try {
      followHealedMove('notes/a.md', 'notes/renamed.md')
      expect(moves).toEqual([['notes/a.md', 'notes/renamed.md']])
    } finally {
      unsubscribe()
    }
  })
})
