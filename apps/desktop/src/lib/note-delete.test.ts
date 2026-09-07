import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import type { NoteSession } from '@/editor/note-session'
import { openSession } from '@/editor/open-documents'
import { deleteOpenNote } from './note-delete'

vi.mock('@/editor/open-documents', () => ({ openSession: vi.fn() }))

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(null)
  vi.mocked(openSession).mockReset()
})

afterEach(() => {
  setBridge(null) // don't leak the mock transport into other suites in this worker
})

describe('deleteOpenNote', () => {
  it('discards a new note that has not reached disk without trying to trash a file', async () => {
    const discard = vi.fn()
    vi.mocked(openSession).mockReturnValue({
      prepareDelete: async () => true,
      discard,
    } as unknown as NoteSession)

    await deleteOpenNote('notes/new.md', 7)

    expect(mockInvoke).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledTimes(1)
  })

  it('trashes the file, then discards its open session so it cannot resurrect', async () => {
    const discard = vi.fn()
    vi.mocked(openSession).mockReturnValue({
      prepareDelete: async () => false,
      discard,
    } as unknown as NoteSession)

    await deleteOpenNote('notes/keep.md', 7)

    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/keep.md', generation: 7 })
    // Discarded *after* the file is gone — otherwise a teardown flush could
    // re-create it. The mock invoke resolves before `discard` is reached.
    expect(discard).toHaveBeenCalledTimes(1)
  })

  it('trashes a note with no open session without error', async () => {
    vi.mocked(openSession).mockReturnValue(null)

    await deleteOpenNote('notes/keep.md', 7)

    expect(mockInvoke).toHaveBeenCalledWith('note_delete', { path: 'notes/keep.md', generation: 7 })
  })

  it('resumes persistence when trashing a prepared session fails', async () => {
    const cancelDelete = vi.fn()
    const discard = vi.fn()
    vi.mocked(openSession).mockReturnValue({
      prepareDelete: async () => false,
      cancelDelete,
      discard,
    } as unknown as NoteSession)
    mockInvoke.mockRejectedValue(new Error('disk full'))

    await expect(deleteOpenNote('notes/keep.md', 7)).rejects.toThrow('disk full')

    expect(cancelDelete).toHaveBeenCalledOnce()
    expect(discard).not.toHaveBeenCalled()
  })

  it('refuses to delete a daily note and never touches disk or sessions', async () => {
    await expect(deleteOpenNote('daily/2026-06-15.md', 7)).rejects.toThrow(/daily/i)

    expect(mockInvoke).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
  })
})
