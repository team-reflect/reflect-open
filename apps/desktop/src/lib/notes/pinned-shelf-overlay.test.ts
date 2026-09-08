import { describe, expect, it } from 'vitest'
import type { PinnedNote } from '@reflect/core'
import { withPinOverlays } from './pinned-shelf-overlay'

function note(path: string, title: string, pinnedOrder: number | null = null): PinnedNote {
  return { path, title, dailyDate: null, pinnedOrder }
}

const ZETA = note('notes/zeta.md', 'Zeta', 0)
const ALPHA = note('notes/alpha.md', 'Alpha', 1)
const BARE = note('notes/bare.md', 'Bare')

describe('withPinOverlays', () => {
  it('returns the indexed list untouched when nothing is asserted', () => {
    const indexed = [ZETA, ALPHA]
    expect(withPinOverlays(indexed, [])).toBe(indexed)
  })

  it('adds an asserted pin after the explicitly ordered pins', () => {
    // Toggling a pin on writes a bare `pinned: true`, so the new note belongs
    // in the unordered group — never ahead of a note the user dragged.
    expect(
      withPinOverlays(
        [ZETA, ALPHA],
        [{ path: 'notes/mid.md', isPinned: true }],
      ).map((pinned) => pinned.title),
    ).toEqual(['Zeta', 'Alpha', 'mid'])
  })

  it('sorts the asserted pin into the unordered group by title', () => {
    expect(
      withPinOverlays([BARE], [{ path: 'notes/apple.md', isPinned: true }]).map(
        (pinned) => pinned.title,
      ),
    ).toEqual(['apple', 'Bare'])
  })

  it('drops a note the assertion unpinned', () => {
    expect(
      withPinOverlays([ZETA, ALPHA], [{ path: 'notes/zeta.md', isPinned: false }]).map(
        (pinned) => pinned.path,
      ),
    ).toEqual(['notes/alpha.md'])
  })

  it('does not duplicate a note the index already lists as pinned', () => {
    expect(withPinOverlays([ZETA], [{ path: 'notes/zeta.md', isPinned: true }])).toEqual([ZETA])
  })

  it('carries the daily date of an asserted daily note', () => {
    expect(withPinOverlays([], [{ path: 'daily/2026-06-10.md', isPinned: true }])).toEqual([
      { path: 'daily/2026-06-10.md', title: '2026-06-10', dailyDate: '2026-06-10', pinnedOrder: null },
    ])
  })
})
