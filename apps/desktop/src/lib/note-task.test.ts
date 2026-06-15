import { TaskStaleError } from '@reflect/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteBusyError, toggleTask } from './note-task'

const openSession = vi.hoisted(() => vi.fn())
vi.mock('@/editor/open-documents', () => ({ openSession }))

const readNote = vi.hoisted(() => vi.fn())
const writeNote = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote,
  writeNote,
}))

// The marker `[` sits at offset 2 of `- [ ] do it`.
const task = { notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] do it' }

beforeEach(() => {
  openSession.mockReset()
  readNote.mockReset()
  writeNote.mockReset()
})

describe('toggleTask', () => {
  it('writes the toggled marker to disk when the note is not open', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('- [ ] do it\n')
    writeNote.mockResolvedValue(undefined)

    await toggleTask(task, 7)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '- [x] do it\n', 7)
  })

  it('takes the disk path for an open but clean note', async () => {
    const commitTaskToggle = vi.fn()
    openSession.mockReturnValue({ isDirty: () => false, commitTaskToggle })
    readNote.mockResolvedValue('- [ ] do it\n')
    writeNote.mockResolvedValue(undefined)

    await toggleTask(task, 7)
    expect(commitTaskToggle).not.toHaveBeenCalled()
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '- [x] do it\n', 7)
  })

  it('routes through the session for an open dirty note (no disk write)', async () => {
    const commitTaskToggle = vi.fn().mockResolvedValue(true)
    openSession.mockReturnValue({ isDirty: () => true, commitTaskToggle })

    await toggleTask(task, 7)
    expect(commitTaskToggle).toHaveBeenCalledWith({ markerOffset: 2, raw: '[ ] do it' })
    expect(writeNote).not.toHaveBeenCalled()
    expect(readNote).not.toHaveBeenCalled()
  })

  it('throws NoteBusyError when a dirty session declines, never clobbering via disk', async () => {
    const commitTaskToggle = vi.fn().mockResolvedValue(false)
    openSession.mockReturnValue({ isDirty: () => true, commitTaskToggle })

    await expect(toggleTask(task, 7)).rejects.toBeInstanceOf(NoteBusyError)
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('propagates TaskStaleError from the disk path when the index is stale', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('- [ ] something else entirely\n')

    await expect(toggleTask(task, 7)).rejects.toBeInstanceOf(TaskStaleError)
    expect(writeNote).not.toHaveBeenCalled()
  })
})
