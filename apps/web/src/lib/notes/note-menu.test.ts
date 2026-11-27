import { describe, expect, it } from 'vitest'
import type { ContextMenuItem } from '@reflect/app'
import { getNoteMenuItems, type NoteMenuTarget } from './note-menu.ts'

const PINNED: NoteMenuTarget = { path: 'notes/pinned.md', isPinned: true }
const UNPINNED: NoteMenuTarget = { path: 'notes/unpinned.md', isPinned: false }
const DAILY: NoteMenuTarget = { path: 'daily/2026-06-14.md', isPinned: false }

function getIds(items: readonly ContextMenuItem[]): string[] {
  return items.filter((item) => item.type === 'action').map((item) => item.id)
}

describe('getNoteMenuItems', () => {
  it('offers Pin while any target is unpinned, else Unpin', () => {
    expect(getIds(getNoteMenuItems([PINNED, UNPINNED], { surface: 'allNotes' }))).toContain('pin')
    expect(getIds(getNoteMenuItems([PINNED], { surface: 'allNotes' }))).not.toContain('pin')
    expect(getIds(getNoteMenuItems([PINNED], { surface: 'allNotes' }))).toContain('unpin')
  })

  it('labels the private toggle from the private state of a single target', () => {
    const titleFor = (isPrivate: boolean) => {
      return getNoteMenuItems([UNPINNED], { surface: 'sidebar', isPrivate }).find(
        (item) => item.type === 'action' && item.id === 'toggle-private',
      )
    }

    expect(titleFor(false)).toMatchObject({ title: 'Lock note' })
    expect(titleFor(true)).toMatchObject({ title: 'Unlock note' })
  })

  it('hides the single-target items for several targets', () => {
    const items = getNoteMenuItems([PINNED, UNPINNED], { surface: 'allNotes', isPrivate: false })

    expect(getIds(items)).toEqual(['pin', 'trash'])
  })

  it('hides Move to Trash when every target is a daily note', () => {
    expect(getIds(getNoteMenuItems([DAILY], { surface: 'allNotes' }))).not.toContain('trash')
    expect(getIds(getNoteMenuItems([DAILY, UNPINNED], { surface: 'allNotes' }))).toContain('trash')
  })

  it('offers neither Open nor Move to Trash in the sidebar', () => {
    const ids = getIds(getNoteMenuItems([UNPINNED], { surface: 'sidebar' }))

    expect(ids).not.toContain('open')
    expect(ids).not.toContain('trash')
  })

  it('separates groups without a leading, trailing or doubled separator', () => {
    const cases = [
      getNoteMenuItems([PINNED, UNPINNED], { surface: 'allNotes' }),
      getNoteMenuItems([PINNED, DAILY], { surface: 'sidebar' }),
      getNoteMenuItems([UNPINNED], { surface: 'allNotes', isPrivate: true }),
    ]
    for (const items of cases) {
      const types = items.map((item) => item.type)
      expect(types[0]).not.toBe('separator')
      expect(types.at(-1)).not.toBe('separator')
      expect(types.join(',')).not.toContain('separator,separator')
    }
  })
})
