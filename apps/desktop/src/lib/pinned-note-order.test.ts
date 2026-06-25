import { describe, expect, it } from 'vitest'
import type { PinnedNote } from '@reflect/core'
import { movePinnedNote } from './pinned-note-order'

function pinnedNote(path: string): PinnedNote {
  return { path, title: path, dailyDate: null }
}

describe('movePinnedNote', () => {
  it('moves a pinned note to the hovered position', () => {
    const moved = movePinnedNote(
      [pinnedNote('notes/a.md'), pinnedNote('notes/b.md'), pinnedNote('notes/c.md')],
      'notes/c.md',
      'notes/a.md',
    )

    expect(moved?.map((note) => note.path)).toEqual([
      'notes/c.md',
      'notes/a.md',
      'notes/b.md',
    ])
  })

  it('returns null when the drag does not change order', () => {
    const notes = [pinnedNote('notes/a.md'), pinnedNote('notes/b.md')]

    expect(movePinnedNote(notes, 'notes/a.md', 'notes/a.md')).toBeNull()
    expect(movePinnedNote(notes, 'notes/missing.md', 'notes/a.md')).toBeNull()
  })
})
