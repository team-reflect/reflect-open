import { describe, expect, it } from 'vitest'
import type { NoteSession } from './note-session'
import { flushOpenDocuments, openSession, registerOpenDocument } from './open-documents'

function fakeSession(path: string, log: string[]): NoteSession {
  return {
    path,
    load: () => {},
    editorChanged: () => {},
    externalChanged: () => {},
    flush: async () => {
      log.push(`flush:${path}`)
    },
    keepMine: () => {},
    loadTheirs: () => {},
    content: () => '',
    updateFrontmatter: () => true,
    dispose: () => {},
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
