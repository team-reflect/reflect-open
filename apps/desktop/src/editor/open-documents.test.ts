import { describe, expect, it } from 'vitest'
import type { NoteSession } from './note-session'
import { flushOpenDocuments, openSession, registerOpenDocument } from './open-documents'

function fakeSession(path: string, log: string[]): NoteSession {
  return {
    path,
    retarget: () => {},
    load: () => {},
    editorChanged: () => {},
    externalChanged: () => {},
    flush: async () => {
      log.push(`flush:${path}`)
    },
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
