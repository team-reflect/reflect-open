import { TaskStaleError } from '@reflect/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  convertTaskToBullet,
  deleteTask,
  editTask,
  insertTask,
  NoteBusyError,
  toggleTask,
} from './note-task'

const openSession = vi.hoisted(() => vi.fn())
vi.mock('@/editor/open-documents', () => ({ openSession }))

const readNote = vi.hoisted(() => vi.fn())
const writeNote = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote,
  writeNote,
}))

// The marker `[` sits at offset 2 of `+ [ ] do it`.
const task = { notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] do it' }

beforeEach(() => {
  openSession.mockReset()
  readNote.mockReset()
  writeNote.mockReset()
})

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('write serialization', () => {
  it('serializes concurrent writes to the same note — no read/write interleave', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n')
    let releaseFirstWrite: () => void = () => {}
    let writes = 0
    writeNote.mockImplementation(() => {
      writes += 1
      return writes === 1
        ? new Promise<void>((resolve) => {
            releaseFirstWrite = resolve
          })
        : Promise.resolve()
    })

    const first = toggleTask(task, 7)
    const second = toggleTask(task, 7)
    await flushMicrotasks()

    // The first write is in flight; the second hasn't even read yet — it's queued.
    expect(readNote).toHaveBeenCalledTimes(1)
    expect(writeNote).toHaveBeenCalledTimes(1)

    releaseFirstWrite()
    await Promise.all([first, second])
    // The second only read after the first's write settled.
    expect(readNote).toHaveBeenCalledTimes(2)
    expect(writeNote).toHaveBeenCalledTimes(2)
  })

  it('keeps the chain alive when a write fails', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n')
    writeNote.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)

    const first = toggleTask(task, 7)
    const second = toggleTask(task, 7)
    await expect(first).rejects.toThrow('disk full')
    await expect(second).resolves.toBeUndefined() // not wedged by the prior failure
  })
})

describe('toggleTask', () => {
  it('writes the toggled marker to disk when the note is not open', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n')
    writeNote.mockResolvedValue(undefined)

    await toggleTask(task, 7)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ [x] do it\n', 7)
  })

  it('routes through the live session whenever the note is open — never disk', async () => {
    // No isDirty gate: an open note always goes through the session, which reads
    // its buffer synchronously, so there is no read/write race with the editor.
    const commitTaskToggle = vi.fn().mockResolvedValue(true)
    openSession.mockReturnValue({ commitTaskToggle })

    await toggleTask(task, 7)
    expect(commitTaskToggle).toHaveBeenCalledWith({ markerOffset: 2, raw: '[ ] do it' })
    expect(writeNote).not.toHaveBeenCalled()
    expect(readNote).not.toHaveBeenCalled()
  })

  it('throws NoteBusyError when the session declines, never clobbering via disk', async () => {
    const commitTaskToggle = vi.fn().mockResolvedValue(false)
    openSession.mockReturnValue({ commitTaskToggle })

    await expect(toggleTask(task, 7)).rejects.toBeInstanceOf(NoteBusyError)
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('propagates TaskStaleError from the disk path when the index is stale', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] something else entirely\n')

    await expect(toggleTask(task, 7)).rejects.toBeInstanceOf(TaskStaleError)
    expect(writeNote).not.toHaveBeenCalled()
  })
})

describe('editTask', () => {
  it('writes the rewritten content to disk when the note is not open', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n')
    writeNote.mockResolvedValue(undefined)

    await editTask(task, 'do it well', 7)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ [ ] do it well\n', 7)
  })

  it('routes the new content through the live session when the note is open', async () => {
    const commitTaskEdit = vi.fn().mockResolvedValue(true)
    openSession.mockReturnValue({ commitTaskEdit })

    await editTask(task, 'do it well', 7)
    expect(commitTaskEdit).toHaveBeenCalledWith({ markerOffset: 2, raw: '[ ] do it' }, 'do it well')
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('throws NoteBusyError when the session declines, never clobbering via disk', async () => {
    openSession.mockReturnValue({ commitTaskEdit: vi.fn().mockResolvedValue(false) })
    await expect(editTask(task, 'x', 7)).rejects.toBeInstanceOf(NoteBusyError)
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('propagates TaskStaleError from the disk path when the index is stale', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] something else entirely\n')
    await expect(editTask(task, 'x', 7)).rejects.toBeInstanceOf(TaskStaleError)
    expect(writeNote).not.toHaveBeenCalled()
  })
})

describe('deleteTask', () => {
  it('removes the task line on disk when the note is not open', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n+ [ ] keep\n')
    writeNote.mockResolvedValue(undefined)

    await deleteTask(task, 7)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ [ ] keep\n', 7)
  })

  it('routes through the live session when the note is open', async () => {
    const commitTaskRemove = vi.fn().mockResolvedValue(true)
    openSession.mockReturnValue({ commitTaskRemove })

    await deleteTask(task, 7)
    expect(commitTaskRemove).toHaveBeenCalledWith({ markerOffset: 2, raw: '[ ] do it' })
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('throws NoteBusyError when the session declines, never clobbering via disk', async () => {
    openSession.mockReturnValue({ commitTaskRemove: vi.fn().mockResolvedValue(false) })
    await expect(deleteTask(task, 7)).rejects.toBeInstanceOf(NoteBusyError)
    expect(writeNote).not.toHaveBeenCalled()
  })
})

describe('convertTaskToBullet', () => {
  it('strips the marker to a plain bullet on disk when the note is not open', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n+ [ ] keep\n')
    writeNote.mockResolvedValue(undefined)

    await convertTaskToBullet(task, 7)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ do it\n+ [ ] keep\n', 7)
  })

  it('routes through the live session when the note is open', async () => {
    const commitTaskToBullet = vi.fn().mockResolvedValue(true)
    openSession.mockReturnValue({ commitTaskToBullet })

    await convertTaskToBullet(task, 7)
    expect(commitTaskToBullet).toHaveBeenCalledWith({ markerOffset: 2, raw: '[ ] do it' })
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('throws NoteBusyError when the session declines, never clobbering via disk', async () => {
    openSession.mockReturnValue({ commitTaskToBullet: vi.fn().mockResolvedValue(false) })
    await expect(convertTaskToBullet(task, 7)).rejects.toBeInstanceOf(NoteBusyError)
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('propagates TaskStaleError from the disk path when the index is stale', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] something else entirely\n')
    await expect(convertTaskToBullet(task, 7)).rejects.toBeInstanceOf(TaskStaleError)
    expect(writeNote).not.toHaveBeenCalled()
  })
})

describe('insertTask', () => {
  it('writes round task syntax to an empty note', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('')
    writeNote.mockResolvedValue(undefined)

    await expect(insertTask('notes/a.md', 7)).resolves.toBe(2)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ [ ] \n', 7)
  })

  it('appends round task syntax after existing content', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('# Notes\n\nbody\n')
    writeNote.mockResolvedValue(undefined)

    await expect(insertTask('notes/a.md', 7)).resolves.toBe('# Notes\n\nbody\n+ '.length)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '# Notes\n\nbody\n+ [ ] \n', 7)
  })
})
