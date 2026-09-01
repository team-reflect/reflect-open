import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteOpenNote } from './note-delete'

/**
 * `deleteOpenNote` discards an unpersisted note locally. Persisted notes are
 * deleted first, then their session is discarded — so a failed delete never
 * leaves a discarded-but-mounted session (which would silently stop
 * persisting the user's edits).
 */

const deleteNoteMock = vi.fn<(path: string, generation: number) => Promise<void>>()
const isDailyMock = vi.fn<(path: string) => boolean>()
const discard = vi.fn()
const openSessionMock =
  vi.fn<(path: string) => { isUnpersisted: () => boolean; discard: () => void } | null>()

vi.mock('@reflect/core', () => ({
  deleteNote: (path: string, generation: number) => deleteNoteMock(path, generation),
  isDaily: (path: string) => isDailyMock(path),
}))
vi.mock('@/editor/open-documents', () => ({
  openSession: (path: string) => openSessionMock(path),
}))

afterEach(() => {
  deleteNoteMock.mockReset()
  isDailyMock.mockReset().mockReturnValue(false)
  discard.mockReset()
  openSessionMock.mockReset()
})

describe('deleteOpenNote', () => {
  it('discards an unpersisted note without deleting a missing file', async () => {
    openSessionMock.mockReturnValue({ isUnpersisted: () => true, discard })

    await deleteOpenNote('notes/new.md', 3)

    expect(deleteNoteMock).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledOnce()
  })

  it('discards the open session after a successful delete', async () => {
    deleteNoteMock.mockResolvedValue()
    openSessionMock.mockReturnValue({ isUnpersisted: () => false, discard })

    await deleteOpenNote('notes/gone.md', 3)

    expect(deleteNoteMock).toHaveBeenCalledWith('notes/gone.md', 3)
    expect(discard).toHaveBeenCalledOnce()
  })

  it('leaves the session intact when the delete fails', async () => {
    deleteNoteMock.mockRejectedValue(new Error('disk full'))
    openSessionMock.mockReturnValue({ isUnpersisted: () => false, discard })

    await expect(deleteOpenNote('notes/gone.md', 3)).rejects.toThrow('disk full')

    // The session was never discarded — the screen stays editable.
    expect(discard).not.toHaveBeenCalled()
    expect(openSessionMock).toHaveBeenCalledOnce()
  })

  it('rejects daily notes without touching disk', async () => {
    isDailyMock.mockReturnValue(true)

    await expect(deleteOpenNote('daily/2026-06-10.md', 3)).rejects.toThrow(
      'Daily notes cannot be deleted',
    )

    expect(deleteNoteMock).not.toHaveBeenCalled()
    expect(openSessionMock).not.toHaveBeenCalled()
  })
})
