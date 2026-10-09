import {
  isSameTaskPath,
  projectTasks,
  TaskStaleError,
  type TaskEditResult,
  type TaskSnapshot,
} from '@reflect/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  continueTaskInContext,
  convertTaskToBullet,
  deleteTask,
  editAndConvertTaskToBullet,
  editAndToggleTask,
  editTask,
  insertTask,
  NoteBusyError,
  toggleTask,
  type TaskRef,
} from './note-task.ts'

const openSession = vi.hoisted(() => vi.fn())
vi.mock('@/editor/open-documents.ts', () => ({ openSession }))

const readNote = vi.hoisted(() => vi.fn())
const writeNote = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote,
  writeNote,
}))

/** The `index`th task of `source` as the index would hand it to the Tasks view. */
function ref(source: string, index = 0, notePath = 'notes/a.md'): TaskRef {
  const task = projectTasks(source)[index]
  if (task === undefined) {
    throw new Error(`no task #${index} in ${JSON.stringify(source)}`)
  }
  return { notePath, astPath: task.astPath, markdown: task.markdown, checked: task.checked }
}

/** Where the write left the task that was at `astPath` before it. */
function movedFrom(
  result: Pick<TaskEditResult, 'moved'>,
  astPath: readonly number[],
): TaskSnapshot | null {
  const move = result.moved.find((candidate) => isSameTaskPath(candidate.from.astPath, astPath))
  if (move === undefined) {
    throw new Error(`no task was at ${JSON.stringify(astPath)}`)
  }
  return move.to
}

/** A session stub whose `commitSourceEdit` runs the transform over `source`. */
function sessionOver(source: string, applied = true) {
  const commitSourceEdit = vi.fn(async (transform: (full: string) => string) => {
    if (!applied) {
      return false
    }
    transform(source)
    return true
  })
  return { commitSourceEdit }
}

const task = ref('+ [ ] do it\n')

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
    await expect(second).resolves.toMatchObject({ source: '+ [x] do it\n' })
  })
})

describe('toggleTask', () => {
  it('writes the toggled task to disk when the note is not open', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n')
    writeNote.mockResolvedValue(undefined)

    const result = await toggleTask(task, 7)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ [x] do it\n', 7)
    expect(movedFrom(result, [0])).toMatchObject({ astPath: [0], markdown: 'do it', checked: true })
  })

  it('routes through the live session whenever the note is open — never disk', async () => {
    // No isDirty gate: an open note always goes through the session, which reads
    // its buffer synchronously, so there is no read/write race with the editor.
    const session = sessionOver('+ [ ] do it\n')
    openSession.mockReturnValue(session)

    const result = await toggleTask(task, 7)
    expect(session.commitSourceEdit).toHaveBeenCalledTimes(1)
    expect(result.source).toBe('+ [x] do it\n')
    expect(writeNote).not.toHaveBeenCalled()
    expect(readNote).not.toHaveBeenCalled()
  })

  it('throws NoteBusyError when the session declines, never clobbering via disk', async () => {
    openSession.mockReturnValue(sessionOver('+ [ ] do it\n', false))

    await expect(toggleTask(task, 7)).rejects.toBeInstanceOf(NoteBusyError)
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('propagates TaskStaleError from the disk path when the index is stale', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] something else entirely\n')

    await expect(toggleTask(task, 7)).rejects.toBeInstanceOf(TaskStaleError)
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('propagates TaskStaleError from the session path too', async () => {
    openSession.mockReturnValue(sessionOver('+ [ ] something else entirely\n'))

    await expect(toggleTask(task, 7)).rejects.toBeInstanceOf(TaskStaleError)
  })
})

describe('editTask', () => {
  it('writes the rewritten Markdown to disk when the note is not open', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n')
    writeNote.mockResolvedValue(undefined)

    await editTask(task, 'do it well', 7)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ [ ] do it well\n', 7)
  })

  it('routes the new Markdown through the live session when the note is open', async () => {
    const session = sessionOver('+ [ ] do it\n')
    openSession.mockReturnValue(session)

    const result = await editTask(task, 'do it well', 7)
    expect(result.source).toBe('+ [ ] do it well\n')
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
  it('removes the task on disk when the note is not open', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n+ [ ] keep\n')
    writeNote.mockResolvedValue(undefined)

    const result = await deleteTask(task, 7)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ [ ] keep\n', 7)
    // The removed task maps to null; the one below it moved up.
    expect(movedFrom(result, [0])).toBeNull()
    expect(movedFrom(result, [1])).toMatchObject({ astPath: [0], markdown: 'keep' })
  })

  it('throws NoteBusyError when the session declines, never clobbering via disk', async () => {
    openSession.mockReturnValue(sessionOver('+ [ ] do it\n', false))
    await expect(deleteTask(task, 7)).rejects.toBeInstanceOf(NoteBusyError)
    expect(writeNote).not.toHaveBeenCalled()
  })
})

describe('convertTaskToBullet', () => {
  it('drops the checkbox on disk when the note is not open', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n+ [ ] keep\n')
    writeNote.mockResolvedValue(undefined)

    const result = await convertTaskToBullet(task, 7)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ do it\n+ [ ] keep\n', 7)
    expect(movedFrom(result, [0])).toBeNull()
  })

  it('propagates TaskStaleError from the disk path when the index is stale', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] something else entirely\n')
    await expect(convertTaskToBullet(task, 7)).rejects.toBeInstanceOf(TaskStaleError)
    expect(writeNote).not.toHaveBeenCalled()
  })
})

describe('editAndToggleTask', () => {
  it('rewrites and toggles the task in one write', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n')
    writeNote.mockResolvedValue(undefined)

    const result = await editAndToggleTask(task, 'done it', 7)
    expect(writeNote).toHaveBeenCalledTimes(1)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ [x] done it\n', 7)
    expect(movedFrom(result, [0])).toMatchObject({
      astPath: [0],
      markdown: 'done it',
      checked: true,
    })
  })
})

describe('editAndConvertTaskToBullet', () => {
  it('rewrites the task and drops its checkbox in one write', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('+ [ ] do it\n')
    writeNote.mockResolvedValue(undefined)

    await editAndConvertTaskToBullet(task, 'just a note', 7)
    expect(writeNote).toHaveBeenCalledTimes(1)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ just a note\n', 7)
  })
})

describe('insertTask', () => {
  it('starts an empty note with a Tasks section and reports the new address', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('')
    writeNote.mockResolvedValue(undefined)

    await expect(insertTask('notes/a.md', 7)).resolves.toEqual({
      created: { astPath: [1], markdown: '', breadcrumbs: [], checked: false },
      moved: [],
    })
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '## Tasks\n\n+ [ ] \n', 7)
  })

  it('joins an existing Tasks section and reports the tasks it shifted', async () => {
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue('## Tasks\n\n+ [ ] a\n\n## Later\n\n+ [ ] b\n')
    writeNote.mockResolvedValue(undefined)

    const result = await insertTask('notes/a.md', 7)

    expect(result.created).toMatchObject({ astPath: [2] })
    expect(movedFrom(result, [1])).toMatchObject({ astPath: [1], markdown: 'a' })
    expect(movedFrom(result, [3])).toMatchObject({ astPath: [4], markdown: 'b' })
    expect(writeNote).toHaveBeenCalledWith(
      'notes/a.md',
      '## Tasks\n\n+ [ ] a\n+ [ ] \n\n## Later\n\n+ [ ] b\n',
      7,
    )
  })

  it('starts a note that does not exist yet', async () => {
    openSession.mockReturnValue(null)
    readNote.mockRejectedValue(Object.assign(new Error('missing'), { kind: 'notFound' }))
    writeNote.mockResolvedValue(undefined)

    await insertTask('daily/2026-06-14.md', 7)
    expect(writeNote).toHaveBeenCalledWith('daily/2026-06-14.md', '## Tasks\n\n+ [ ] \n', 7)
  })

  it('appends through the live session when the note is open', async () => {
    const session = sessionOver('## Tasks\n\n+ [ ] first\n')
    openSession.mockReturnValue(session)

    await expect(insertTask('notes/a.md', 7)).resolves.toMatchObject({ created: { astPath: [2] } })
    expect(writeNote).not.toHaveBeenCalled()
  })
})

describe('continueTaskInContext', () => {
  it('saves an edited task and adds the next row to the same nested context', async () => {
    const source = [
      '+ StartupToolbox',
      '  + Reflections',
      '    + [ ] first',
      '  + Later',
      '    + [ ] third',
      '',
    ].join('\n')
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue(source)
    writeNote.mockResolvedValue(undefined)

    const result = await continueTaskInContext(ref(source), 'edited first', 7)

    const written = [
      '+ StartupToolbox',
      '  + Reflections',
      '    + [ ] edited first',
      '    + [ ] ',
      '  + Later',
      '    + [ ] third',
      '',
    ].join('\n')
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', written, 7)
    expect(result.created).toEqual({
      astPath: [0, 1, 2],
      markdown: '',
      breadcrumbs: ['StartupToolbox', 'Reflections'],
      checked: false,
    })
    expect(projectTasks(written)[1]?.breadcrumbs).toEqual(['StartupToolbox', 'Reflections'])
    expect(movedFrom(result, [0, 1, 1])).toMatchObject({
      astPath: [0, 1, 1],
      markdown: 'edited first',
    })
    expect(movedFrom(result, [0, 2, 1])).toMatchObject({ astPath: [0, 2, 1], markdown: 'third' })
  })

  it('replaces a cleared row with one empty task at the end of its context', async () => {
    const source = '+ Group\n  + [ ] old\n  + [ ] peer\n'
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue(source)
    writeNote.mockResolvedValue(undefined)

    const result = await continueTaskInContext(ref(source), '', 7)

    const written = '+ Group\n  + [ ] peer\n  + [ ] \n'
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', written, 7)
    expect(result.created).toEqual({
      astPath: [0, 2],
      markdown: '',
      breadcrumbs: ['Group'],
      checked: false,
    })
    expect(movedFrom(result, [0, 1])).toBeNull()
    expect(movedFrom(result, [0, 2])).toMatchObject({ astPath: [0, 1], markdown: 'peer' })
  })

  it('relocates a stale anchor by its content when the note grew above it', async () => {
    const indexedSource = '+ Group\n  + [ ] \n'
    const source = `Intro\n\n${indexedSource}`
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue(source)
    writeNote.mockResolvedValue(undefined)

    await continueTaskInContext(ref(indexedSource), 'filled', 7)
    expect(writeNote).toHaveBeenCalledWith(
      'notes/a.md',
      'Intro\n\n+ Group\n  + [ ] filled\n  + [ ] \n',
      7,
    )
  })

  it('continues the own list of a root-level task', async () => {
    const source = '+ [ ] alone\n'
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue(source)
    writeNote.mockResolvedValue(undefined)

    const result = await continueTaskInContext(ref(source), null, 7)

    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '+ [ ] alone\n+ [ ] \n', 7)
    expect(result.created).toMatchObject({ astPath: [1] })
  })

  it('returns a result shaped for the cache', async () => {
    const source = '+ Group\n  + [ ] first\n'
    openSession.mockReturnValue(null)
    readNote.mockResolvedValue(source)
    writeNote.mockResolvedValue(undefined)

    const result = await continueTaskInContext(ref(source), null, 7)
    const first = { astPath: [0, 1], markdown: 'first', breadcrumbs: ['Group'], checked: false }
    expect(result.moved).toEqual([{ from: first, to: first }])
  })
})
