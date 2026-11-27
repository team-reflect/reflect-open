import { describe, expect, it } from 'vitest'
import { getNoteRowMenuItems } from './note-row-menu.ts'

describe('getNoteRowMenuItems', () => {
  it('offers Pin, Lock note, and a separate Delete for an unpinned public note', () => {
    expect(getNoteRowMenuItems({ isPinned: false, canDelete: true }, false)).toEqual([
      { type: 'action', id: 'pin', title: 'Pin' },
      { type: 'action', id: 'privacy', title: 'Lock note' },
      { type: 'separator' },
      { type: 'action', id: 'delete', title: 'Delete', destructive: true },
    ])
  })

  it('offers Unpin and Unlock note for a pinned private note', () => {
    expect(getNoteRowMenuItems({ isPinned: true, canDelete: true }, true)).toEqual([
      { type: 'action', id: 'pin', title: 'Unpin' },
      { type: 'action', id: 'privacy', title: 'Unlock note' },
      { type: 'separator' },
      { type: 'action', id: 'delete', title: 'Delete', destructive: true },
    ])
  })

  it('hides the privacy item while the privacy is unknown, and Delete for a daily note', () => {
    expect(getNoteRowMenuItems({ isPinned: false, canDelete: false }, undefined)).toEqual([
      { type: 'action', id: 'pin', title: 'Pin' },
    ])
  })
})
