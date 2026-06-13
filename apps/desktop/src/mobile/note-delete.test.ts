import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteOpenNote } from './note-delete'

/**
 * `deleteOpenNote` deletes first, then discards the open session — so a
 * failed delete never leaves a discarded-but-mounted session (which would
 * silently stop persisting the user's edits).
 */

const deleteNoteMock = vi.fn<(path: string, generation: number) => Promise<void>>()
const discard = vi.fn()
const openSessionMock = vi.fn<(path: string) => { discard: () => void } | null>()

vi.mock('@reflect/core', () => ({
  deleteNote: (path: string, generation: number) => deleteNoteMock(path, generation),
}))
vi.mock('@/editor/open-documents', () => ({
  openSession: (path: string) => openSessionMock(path),
}))

afterEach(() => {
  deleteNoteMock.mockReset()
  discard.mockReset()
  openSessionMock.mockReset()
})

describe('deleteOpenNote', () => {
  it('discards the open session after a successful delete', async () => {
    deleteNoteMock.mockResolvedValue()
    openSessionMock.mockReturnValue({ discard })

    await deleteOpenNote('notes/gone.md', 3)

    expect(deleteNoteMock).toHaveBeenCalledWith('notes/gone.md', 3)
    expect(discard).toHaveBeenCalledOnce()
  })

  it('leaves the session intact when the delete fails', async () => {
    deleteNoteMock.mockRejectedValue(new Error('disk full'))
    openSessionMock.mockReturnValue({ discard })

    await expect(deleteOpenNote('notes/gone.md', 3)).rejects.toThrow('disk full')

    // The session was never discarded — the screen stays editable.
    expect(discard).not.toHaveBeenCalled()
    expect(openSessionMock).not.toHaveBeenCalled()
  })
})
