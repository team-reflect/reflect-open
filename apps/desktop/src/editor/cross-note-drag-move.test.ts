import { describe, expect, it } from 'vitest'
import { crossNoteMoveDeletion } from './cross-note-drag-move'

/** The settled state of a task/block move dropped in another day's editor. */
const crossNoteNodeMove = {
  isSourceView: true,
  droppedInAnotherView: true,
  move: true,
  hasNode: true,
  selectionEmpty: true,
}

describe('crossNoteMoveDeletion', () => {
  it('deletes the dragged node when a move lands in another editor (issue #747)', () => {
    expect(crossNoteMoveDeletion(crossNoteNodeMove)).toBe('node')
  })

  it('deletes the source selection for a cross-editor text-selection move', () => {
    expect(
      crossNoteMoveDeletion({ ...crossNoteNodeMove, hasNode: false, selectionEmpty: false }),
    ).toBe('selection')
  })

  it('keeps the original for a copy drag, so both notes have it', () => {
    expect(crossNoteMoveDeletion({ ...crossNoteNodeMove, move: false })).toBe('none')
  })

  it('does nothing when the drop stayed in the same editor — PM already moved it', () => {
    expect(crossNoteMoveDeletion({ ...crossNoteNodeMove, droppedInAnotherView: false })).toBe(
      'none',
    )
  })

  it('does nothing on a cancelled drop (dragend fires, no drop landed)', () => {
    // A cancelled drop leaves `droppedInAnotherView` false — never delete the
    // original, or a drag that goes nowhere would lose the task.
    expect(crossNoteMoveDeletion({ ...crossNoteNodeMove, droppedInAnotherView: false })).toBe(
      'none',
    )
  })

  it('ignores the target editor’s dragend — only the source cleans up', () => {
    expect(crossNoteMoveDeletion({ ...crossNoteNodeMove, isSourceView: false })).toBe('none')
  })

  it('has nothing to delete for a node-less drag with an empty source selection', () => {
    expect(
      crossNoteMoveDeletion({ ...crossNoteNodeMove, hasNode: false, selectionEmpty: true }),
    ).toBe('none')
  })
})
