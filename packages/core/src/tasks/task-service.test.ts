import { sha256HexSync } from '@reflect/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenDocumentsService,
  type OpenDocumentsService,
} from '../documents/open-documents-service.ts'
import { createGraphSession, type GraphSession } from '../graph/graph-session.ts'
import type { NoteWriteResult } from '../graph/note-file-service.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createNoteDocumentService } from '../documents/note-document-service.ts'
import {
  isSameTaskPath,
  parseNote,
  projectTasks,
  type TaskEditResult,
  type TaskSnapshot,
} from '../markdown/index.ts'
import { buildIndexedNote } from '../indexing/indexed-note.ts'
import type { SnippetTask } from '../indexing/snippet-tasks.ts'
import { WritableStore } from '../store.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import {
  createTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
} from '../testing/database.ts'
import { createTestNoteSession, type TestNoteSession } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestIndexLifecycleService } from '../testing/index-lifecycle.ts'
import { createTestNoteFileService, type TestNoteFileService } from '../testing/graph.ts'
import { createTestIpcBridgeService, type TestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService, type TestLoggerService } from '../testing/logger.ts'
import { createTestProgressPort, type TestProgressPort } from '../testing/ports.ts'
import { TaskHarness } from '../testing/task-harness.ts'
import type { OpenTask } from './open-task.ts'
import {
  createTaskService,
  type TaskRef,
  type TaskService,
  type TaskServiceDeps,
} from './task-service.ts'
import { sleep, noop } from '@ocavue/utils'

/**
 * The `index`th task of `source` as the index would hand it to the Tasks view.
 */
function ref(source: string, index = 0, notePath = 'notes/a.md'): TaskRef {
  const task = projectTasks(source)[index]
  if (task === undefined) {
    throw new Error(`no task #${index} in ${JSON.stringify(source)}`)
  }
  return {
    notePath,
    revision: sha256HexSync(source),
    astPath: task.astPath,
    markdown: task.markdown,
    checked: task.checked,
  }
}

/**
 * Where the write left the task that was at `astPath` before it.
 */
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

/**
 * An open session of `notes/a.md` holding `source`.
 */
function sessionOver(source: string, applied = true): TestNoteSession {
  return createTestNoteSession({ path: 'notes/a.md', content: source, accepts: applied })
}

const task = ref('+ [ ] do it\n')

let database: TestDatabaseService
let noteFile: TestNoteFileService
let openDocuments: OpenDocumentsService
let progress: TestProgressPort
let ipc: TestIpcBridgeService
let clock: TestClockService
let logger: TestLoggerService
let tasks: TaskService

const openGraph = createGraphSession({ root: '/g', name: 'g', generation: 7, indexGeneration: 1 })

function createTasks(graphSession: TaskServiceDeps['graphSession']): TaskService {
  return createTaskService({
    database,
    noteDocuments: createNoteDocumentService({
      openDocuments,
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 3 } }),
      indexLifecycle: createTestIndexLifecycleService(),
      logger: createTestLoggerService(),
    }),
    progress,
    clock,
    logger,
    graphSession,
    ipc,
  })
}

/**
 * Broadcast a commit of the index that wrote the notes at `paths`, or every note for `null`.
 */
function emitCommitted(paths: string[] | null): void {
  ipc.emit('index:committed', { seq: 1, paths })
}

function openSession(session: TestNoteSession): void {
  openDocuments.register({ session })
}

beforeEach(() => {
  database = createTestDatabaseService()
  noteFile = createTestNoteFileService()
  openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  progress = createTestProgressPort()
  ipc = createTestIpcBridgeService()
  clock = createTestClockService()
  logger = createTestLoggerService()
  tasks = createTasks(new WritableStore({ session: openGraph }))
})

const flushMicrotasks = () => sleep(0)

const UNMERGED_WRITE: NoteWriteResult = { merged: null, hash: '', modifiedMs: 0 }

describe('write serialization', () => {
  it('serializes concurrent writes to the same note — no read/write interleave', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n')
    const pendingFirstWrite = Promise.withResolvers<NoteWriteResult>()
    let writes = 0
    const writeNote = vi.spyOn(noteFile, 'write').mockImplementation(() => {
      writes += 1
      return writes === 1 ? pendingFirstWrite.promise : Promise.resolve(UNMERGED_WRITE)
    })

    const first = tasks.writeTask(task, [{ kind: 'toggle' }])
    const second = tasks.writeTask(task, [{ kind: 'toggle' }])
    await flushMicrotasks()

    // The first write is in flight; the second hasn't even read yet — it's queued.
    expect(noteFile.getReads()).toHaveLength(1)
    expect(writeNote).toHaveBeenCalledTimes(1)

    pendingFirstWrite.resolve(UNMERGED_WRITE)
    await Promise.all([first, second])
    // The second only read after the first's write settled.
    expect(noteFile.getReads()).toHaveLength(2)
    expect(writeNote).toHaveBeenCalledTimes(2)
  })

  it('keeps the chain alive when a write fails', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n')
    vi.spyOn(noteFile, 'write').mockRejectedValueOnce(new Error('disk full'))

    const first = tasks.writeTask(task, [{ kind: 'toggle' }])
    const second = tasks.writeTask(task, [{ kind: 'toggle' }])
    await expect(first).rejects.toThrow('disk full')
    await expect(second).resolves.toMatchObject({ source: '+ [x] do it\n' })
  })
})

describe('writeTask', () => {
  it('writes the toggled task to disk when the note is not open', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n')

    const result = await tasks.writeTask(task, [{ kind: 'toggle' }])
    expect(noteFile.getWrites('notes/a.md')).toContain('+ [x] do it\n')
    expect(movedFrom(result, [0])).toMatchObject({ astPath: [0], markdown: 'do it', checked: true })
  })

  it('routes through the live session whenever the note is open — never disk', async () => {
    // No isDirty gate: an open note always goes through the session, which reads
    // its buffer synchronously, so there is no read/write race with the editor.
    const session = sessionOver('+ [ ] do it\n')
    openSession(session)

    const result = await tasks.writeTask(task, [{ kind: 'toggle' }])
    expect(session.getCalls('commitSourceEdit')).toHaveLength(1)
    expect(result.source).toBe('+ [x] do it\n')
    expect(noteFile.writes()).toEqual([])
  })

  it('refuses as not writable when the session declines, never clobbering via disk', async () => {
    openSession(sessionOver('+ [ ] do it\n', false))

    await expect(tasks.writeTask(task, [{ kind: 'remove' }])).rejects.toMatchObject({
      kind: 'notWritable',
    })
    expect(noteFile.writes()).toEqual([])
  })

  it('propagates a stale refusal from the disk path when the index is stale', async () => {
    noteFile.set('notes/a.md', '+ [ ] something else entirely\n')

    await expect(tasks.writeTask(task, [{ kind: 'toggle' }])).rejects.toMatchObject({
      kind: 'stale',
    })
    expect(noteFile.writes()).toEqual([])
  })

  it('propagates a stale refusal from the session path too', async () => {
    openSession(sessionOver('+ [ ] something else entirely\n'))

    await expect(tasks.writeTask(task, [{ kind: 'toggle' }])).rejects.toMatchObject({
      kind: 'stale',
    })
  })

  it('replaces the Markdown, on disk or through the session', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n')
    await tasks.writeTask(task, [{ kind: 'setMarkdown', markdown: 'do it well' }])
    expect(noteFile.getWrites('notes/a.md')).toContain('+ [ ] do it well\n')

    openSession(sessionOver('+ [ ] do it\n'))
    const result = await tasks.writeTask(task, [{ kind: 'setMarkdown', markdown: 'do it well' }])
    expect(result.source).toBe('+ [ ] do it well\n')
    expect(noteFile.writes()).toHaveLength(1)
  })

  it('removes the task and reports the rows below it moving up', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n+ [ ] keep\n')

    const result = await tasks.writeTask(task, [{ kind: 'remove' }])
    expect(noteFile.getWrites('notes/a.md')).toContain('+ [ ] keep\n')
    expect(movedFrom(result, [0])).toBeNull()
    expect(movedFrom(result, [1])).toMatchObject({ astPath: [0], markdown: 'keep' })
  })

  it('drops the checkbox, so the row leaves the projection', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n+ [ ] keep\n')

    const result = await tasks.writeTask(task, [{ kind: 'toBullet' }])
    expect(noteFile.getWrites('notes/a.md')).toContain('+ do it\n+ [ ] keep\n')
    expect(movedFrom(result, [0])).toBeNull()
  })

  it('lands several actions in one write', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n')

    const result = await tasks.writeTask(task, [
      { kind: 'setMarkdown', markdown: 'done it' },
      { kind: 'toggle' },
    ])
    expect(noteFile.writes()).toHaveLength(1)
    expect(noteFile.getWrites('notes/a.md')).toContain('+ [x] done it\n')
    expect(movedFrom(result, [0])).toMatchObject({ markdown: 'done it', checked: true })

    noteFile.set('notes/a.md', '+ [ ] do it\n')
    await tasks.writeTask(task, [
      { kind: 'setMarkdown', markdown: 'just a note' },
      { kind: 'toBullet' },
    ])
    expect(noteFile.getWrites('notes/a.md').at(-1)).toBe('+ just a note\n')
  })
})

describe('rows read from the index', () => {
  /**
   * Subscribe and wait for the first read of the open tasks to land.
   */
  async function readOpen(): Promise<readonly OpenTask[]> {
    tasks.subscribe(noop)
    await flushMicrotasks()
    return tasks.get().open!
  }

  it('parses task breadcrumbs and normalizes boolean note context', async () => {
    seedNotes(database, [
      {
        path: 'notes/project.md',
        markdown:
          '---\npinned: 2\n---\n# Project\n\n- StartupToolbox\n  - *Reflections*\n    + [ ] ship [[it]] **now**\n    + [x] shipped\n',
        mtime: 123,
      },
    ])

    const rows = await readOpen()
    expect(rows).toEqual([
      expect.objectContaining({
        notePath: 'notes/project.md',
        markdown: 'ship [[it]] **now**',
        text: 'ship it now',
        checked: false,
        dueDate: null,
        noteTitle: 'Project',
        dailyDate: null,
        isPinned: true,
        pinnedOrder: 2,
        updatedAt: 123,
      }),
    ])
    const [row] = rows
    expect(row!.breadcrumbs.at(-2)).toBe('StartupToolbox')
    expect(row!.breadcrumbs.at(-1)).toBe('Reflections')
  })

  it('sorts rows by note path, then by their place in the note', async () => {
    seedNotes(database, [
      { path: 'notes/b.md', markdown: '+ [ ] b first\n' },
      { path: 'notes/a.md', markdown: '+ [ ] a first\n  + [ ] a nested\n\npara\n\n+ [ ] a last\n' },
    ])

    const rows = await readOpen()
    expect(rows.map((row) => [row.notePath, row.markdown])).toEqual([
      ['notes/a.md', 'a first'],
      ['notes/a.md', 'a nested'],
      ['notes/a.md', 'a last'],
      ['notes/b.md', 'b first'],
    ])
  })

  it('skips a row whose stored path does not decode', async () => {
    const source = '+ [ ] x\n'
    const note = buildIndexedNote(parseNote({ path: 'notes/a.md', source }), {
      fileHash: 'hash',
      mtime: 0,
      source,
    })
    const task = note.tasks[0]!
    database.applyProjection({
      ...note,
      tasks: [
        { ...task, astPath: 'not json' },
        { ...task, astPath: '[1]' },
        { ...task, astPath: '[]' },
      ],
    })

    const rows = await readOpen()
    expect(rows.map((row) => row.astPath)).toEqual([[1]])
  })

  it('never surfaces template checkboxes — boilerplate, not real tasks', async () => {
    seedNotes(database, [
      { path: 'templates/todo.md', markdown: '+ [ ] template task\n' },
      { path: 'notes/a.md', markdown: '+ [ ] real task\n' },
    ])

    const rows = await readOpen()
    expect(rows.map((row) => row.notePath)).toEqual(['notes/a.md'])
  })

  it('lists checked tasks, most recently edited note first', async () => {
    seedNotes(database, [
      { path: 'notes/old.md', markdown: '+ [x] old done\n+ [ ] old open\n', mtime: 1 },
      { path: 'notes/new.md', markdown: '+ [x] new done\n', mtime: 2 },
    ])

    tasks.includeCompleted()
    await flushMicrotasks()
    const completed = tasks.get().completed!
    expect(completed.map((row) => [row.notePath, row.markdown, row.checked])).toEqual([
      ['notes/new.md', 'new done', true],
      ['notes/old.md', 'old done', true],
    ])
  })
})

describe('write results', () => {
  it('stamps the write with the clock', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n')
    clock.setNow(4242)

    await expect(tasks.writeTask(task, [{ kind: 'toggle' }])).resolves.toMatchObject({
      updatedAt: 4242,
    })
  })
})

describe('snippet tasks', () => {
  const source = '+ [ ] do it\n'
  const anchors: SnippetTask[] = [
    {
      locator: { revision: '', astPath: [0], markdown: 'do it', checked: false },
      checked: false,
      text: 'do it',
    },
    { locator: null, checked: false, text: 'square box' },
  ]

  it('resolves a click whose index, state and text all match its anchor', () => {
    expect(tasks.resolveSnippetTask(anchors, { index: 0, checked: false, text: 'do it' })).toBe(
      anchors[0],
    )
    expect(
      tasks.resolveSnippetTask(anchors, { index: 1, checked: false, text: 'square box' }),
    ).toBe(anchors[1])
    expect(progress.get()).toEqual([])
  })

  it('refuses a drifted click and reports it', () => {
    expect(tasks.resolveSnippetTask(anchors, { index: 0, checked: true, text: 'do it' })).toBeNull()
    expect(
      tasks.resolveSnippetTask(anchors, { index: 0, checked: false, text: 'other' }),
    ).toBeNull()
    expect(
      tasks.resolveSnippetTask(anchors, { index: 9, checked: false, text: 'do it' }),
    ).toBeNull()
    expect(
      progress.get().map((operation) => [operation.label, operation.status, operation.message]),
    ).toEqual([
      ['Updating task', 'failed', 'The note has changed — try again in a moment.'],
      ['Updating task', 'failed', 'The note has changed — try again in a moment.'],
      ['Updating task', 'failed', 'The note has changed — try again in a moment.'],
    ])
  })

  it('toggles the source task', async () => {
    noteFile.set('notes/a.md', source)
    await tasks.toggleSnippetTask('notes/a.md', {
      locator: { revision: '', astPath: [0], markdown: 'do it', checked: false },
      checked: false,
    })
    expect(noteFile.getWrites('notes/a.md')).toEqual(['+ [x] do it\n'])
    expect(progress.get()).toEqual([])
  })

  it('reports a failed toggle, labelled for its direction, and rethrows', async () => {
    noteFile.set('notes/a.md', '+ [x] something else\n')
    await expect(
      tasks.toggleSnippetTask('notes/a.md', {
        locator: { revision: '', astPath: [0], markdown: 'do it', checked: true },
        checked: true,
      }),
    ).rejects.toMatchObject({ kind: 'stale' })
    expect(progress.findByLabel('Reopening task')?.status).toBe('failed')
  })
})

describe('no graph open', () => {
  it('rejects writes and skips snippet toggles', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n')
    const closed = createTasks(new WritableStore({ session: null }))

    await expect(closed.writeTask(task, [{ kind: 'toggle' }])).rejects.toThrow('No graph is open.')
    await closed.toggleSnippetTask('notes/a.md', { locator: task, checked: false })
    expect(noteFile.writes()).toEqual([])
    expect(progress.get()).toEqual([])
  })
})

describe('task list state', () => {
  const A = 'notes/a.md'
  const B = 'notes/b.md'

  /**
   * Put `files` on disk and in the index, subscribe, and wait for the first read to land.
   */
  async function subscribed(
    files: Record<string, string> = { [A]: '+ [ ] one\n', [B]: '+ [ ] two\n' },
  ): Promise<{ rows: readonly OpenTask[]; unsubscribe: () => void }> {
    seedNotes(
      database,
      Object.entries(files).map(([path, markdown]) => ({ path, markdown })),
    )
    for (const [path, markdown] of Object.entries(files)) {
      noteFile.set(path, markdown)
    }
    const unsubscribe = tasks.subscribe(noop)
    await flushMicrotasks()
    return { rows: tasks.get().open!, unsubscribe }
  }

  /**
   * How many times the tasks were read from the index, and with which filter.
   */
  function watchReads(): {
    count: () => number
    filters: () => unknown[]
    paths: () => unknown[]
  } {
    const read = vi.spyOn(database, 'read')
    const calls = () => {
      return read.mock.calls
        .filter(([command]) => command === 'index_tasks')
        .map(([, args]) => args as { checked: boolean | null; paths: string[] | null })
    }
    return {
      count: () => calls().length,
      filters: () => calls().map((args) => args.checked),
      paths: () => calls().map((args) => args.paths),
    }
  }

  function markdowns(rows: readonly OpenTask[] | undefined): string[] | undefined {
    return rows?.map((row) => row.markdown)
  }

  it('reads the open tasks on the first subscription, not before', async () => {
    seedNotes(database, [{ path: A, markdown: '+ [ ] one\n+ [x] done\n' }])
    const reads = watchReads()
    expect(tasks.get()).toEqual({ open: undefined, completed: undefined, struck: [] })
    expect(reads.count()).toBe(0)

    let changes = 0
    tasks.subscribe(() => {
      changes += 1
    })
    await flushMicrotasks()

    expect(markdowns(tasks.get().open)).toEqual(['one'])
    expect(tasks.get().completed).toBeUndefined()
    expect(tasks.get()).toBe(tasks.get())
    expect(changes).toBe(1)
  })

  it('reads the completed tasks only while they are included', async () => {
    const reads = watchReads()
    await subscribed({ [A]: '+ [ ] one\n+ [x] done\n' })
    expect(reads.filters()).toEqual([false])

    const release = tasks.includeCompleted()
    await flushMicrotasks()
    expect(markdowns(tasks.get().completed)).toEqual(['done'])
    expect(reads.filters()).toEqual([false, null])

    release()
    await tasks.refresh()
    expect(reads.filters()).toEqual([false, null, false])
  })

  it('reads the completed tasks again when they are included after a return', async () => {
    const { unsubscribe } = await subscribed({ [A]: '+ [ ] one\n+ [x] done\n' })
    const release = tasks.includeCompleted()
    await flushMicrotasks()
    release()
    unsubscribe()

    tasks.subscribe(noop)
    tasks.includeCompleted()
    await flushMicrotasks()
    expect(markdowns(tasks.get().completed)).toEqual(['done'])
  })

  it('keeps the rows while a read fails, and takes the read that lands after it', async () => {
    await subscribed()
    seedNotes(database, [{ path: A, markdown: '+ [ ] one changed\n' }])
    const read = vi.spyOn(database, 'read').mockRejectedValueOnce(new Error('no index'))

    const refreshing = tasks.refresh()
    await flushMicrotasks()
    expect(markdowns(tasks.get().open)).toEqual(['one', 'two'])

    await clock.advance(250)
    await refreshing
    expect(read).toHaveBeenCalledTimes(2)
    expect(markdowns(tasks.get().open)).toEqual(['one changed', 'two'])
  })

  /**
   * Type `markdown` into the editor of `row` and leave the row.
   */
  function edit(row: OpenTask, markdown: string): Promise<void> {
    tasks.commands.setDraft(row, markdown)
    return tasks.commands.commit(row)
  }

  /**
   * Fail the writes of the commands with `cause`.
   */
  function failWrites(cause: Error): void {
    vi.spyOn(tasks.commands, 'write').mockRejectedValue(cause)
  }

  it('shows the change before the write starts', async () => {
    const { rows } = await subscribed()
    const write = Promise.withResolvers<void>()
    const writeNote = tasks.commands.write.bind(tasks.commands)
    vi.spyOn(tasks.commands, 'write').mockImplementation(async (...args) => {
      await write.promise
      return await writeNote(...args)
    })

    const completing = tasks.commands.toggle([rows[0]!])

    expect(markdowns(tasks.get().open)).toEqual(['two'])
    expect(tasks.get().struck).toEqual([{ ...rows[0]!, checked: true }])
    write.resolve()
    await completing
    expect(markdowns(tasks.get().open)).toEqual(['two'])
    expect(noteFile.files().get(A)).toBe('+ [x] one\n')
  })

  it('keeps the typed text in the row and reports it when a write fails', async () => {
    const { rows } = await subscribed()
    failWrites(new Error('disk full'))

    const editing = edit(rows[0]!, 'edited [[2026-06-20]]')
    expect(tasks.get().open?.[0]).toMatchObject({
      taskId: rows[0]!.taskId,
      markdown: 'edited [[2026-06-20]]',
      text: 'edited 2026-06-20',
      dueDate: '2026-06-20',
    })

    await editing
    expect(tasks.get().open).toEqual([
      {
        ...rows[0]!,
        markdown: 'edited [[2026-06-20]]',
        text: 'edited 2026-06-20',
        dueDate: '2026-06-20',
      },
      rows[1]!,
    ])
    expect(noteFile.files().get(A)).toBe('+ [ ] one\n')
    expect(progress.findByLabel('Saving task')?.message).toBe('The task could not be saved.')
  })

  it('keeps the change of another note when one write fails', async () => {
    const { rows } = await subscribed()
    const writeNote = tasks.commands.write.bind(tasks.commands)
    const first = Promise.withResolvers<void>()
    vi.spyOn(tasks.commands, 'write').mockImplementation(async (generation, notePath, edits) => {
      if (notePath === A) {
        await first.promise
        throw new Error('disk full')
      }
      return await writeNote(generation, notePath, edits)
    })

    const failing = edit(rows[0]!, 'one!')
    const landing = edit(rows[1]!, 'two!')
    expect(markdowns(tasks.get().open)).toEqual(['one!', 'two!'])

    await landing
    first.resolve()
    await failing
    expect(markdowns(tasks.get().open)).toEqual(['one!', 'two!'])
    expect(noteFile.files().get(A)).toBe('+ [ ] one\n')
  })

  /**
   * Complete the one task of a note, and return its struck row.
   */
  async function struckRow(): Promise<OpenTask> {
    const { rows } = await subscribed({ [A]: '+ [ ] one\n' })
    await tasks.commands.toggle(rows)
    return tasks.get().struck[0]!
  }

  it('keeps a completed task struck, under its id, until the struck tasks are archived', async () => {
    const { rows } = await subscribed({ [A]: '+ [ ] one\n' })
    await tasks.commands.toggle(rows)

    expect(tasks.get().open).toEqual([])
    expect(tasks.get().struck).toMatchObject([
      { taskId: rows[0]!.taskId, checked: true, revision: sha256HexSync('+ [x] one\n') },
    ])

    tasks.commands.archive()
    expect(tasks.get().struck).toEqual([])
  })

  it('shows a reopened task as open, under the same id', async () => {
    const struck = await struckRow()

    await tasks.commands.toggle([struck])

    expect(tasks.get().struck).toEqual([])
    expect(tasks.get().open).toMatchObject([{ taskId: struck.taskId, checked: false }])
  })

  it('shows a struck task as open when the index reports it open again', async () => {
    const struck = await struckRow()

    await tasks.refresh()

    expect(tasks.get().struck).toEqual([])
    expect(tasks.get().open).toMatchObject([{ taskId: struck.taskId, markdown: 'one' }])
  })

  it('keeps a task struck when its note changed before a return', async () => {
    const reads = watchReads()
    const { rows, unsubscribe } = await subscribed({ [A]: '+ [ ] one\n' })
    await tasks.commands.toggle(rows)
    unsubscribe()
    seedNotes(database, [{ path: A, markdown: '+ [x] one\n+ [ ] two\n' }])

    tasks.subscribe(noop)
    await flushMicrotasks()
    expect(reads.paths()).toEqual([null, null, [A]])
    expect(tasks.get().struck).toMatchObject([{ taskId: rows[0]!.taskId, checked: true }])
    expect(markdowns(tasks.get().open)).toEqual(['two'])
  })

  it('keeps the row struck when an edit-and-reopen write fails', async () => {
    const struck = await struckRow()
    failWrites(new Error('disk full'))

    tasks.commands.setDraft(struck, 'edited')
    const reopening = tasks.commands.toggle([struck])
    expect(tasks.get().struck).toEqual([])
    expect(tasks.get().open).toEqual([
      { ...struck, checked: false, markdown: 'edited', text: 'edited' },
    ])

    await reopening
    expect(tasks.get().open).toEqual([])
    expect(tasks.get().struck).toEqual([{ ...struck, markdown: 'edited', text: 'edited' }])
  })

  it('keeps a checked task struck when its delete fails', async () => {
    const struck = await struckRow()
    failWrites(new Error('disk full'))

    const deleting = tasks.commands.remove([struck])
    expect(tasks.get().struck).toEqual([])

    await deleting
    expect(tasks.get().struck).toEqual([struck])
  })

  it('takes the rows a backlink snippet toggle left', async () => {
    const { rows } = await subscribed({ [A]: '+ [ ] one\n+ [ ] two\n' })

    await tasks.toggleSnippetTask(A, { locator: rows[0]!, checked: false })

    expect(markdowns(tasks.get().open)).toEqual(['two'])
  })

  it('reads the tasks of the notes a commit names, and of every note when it names none', async () => {
    const reads = watchReads()
    await subscribed()
    seedNotes(database, [
      { path: A, markdown: '+ [ ] one changed\n' },
      { path: B, markdown: '+ [ ] two changed\n' },
    ])

    emitCommitted([A])
    await flushMicrotasks()
    expect(reads.paths()).toEqual([null, [A]])
    expect(markdowns(tasks.get().open)).toEqual(['one changed', 'two'])

    emitCommitted(null)
    await flushMicrotasks()
    expect(reads.paths()).toEqual([null, [A], null])
    expect(markdowns(tasks.get().open)).toEqual(['one changed', 'two changed'])
  })

  it('drops the rows of a committed note that has no task left', async () => {
    await subscribed()
    seedNotes(database, [{ path: A, markdown: 'no task\n' }])

    emitCommitted([A])
    await flushMicrotasks()
    expect(markdowns(tasks.get().open)).toEqual(['two'])
  })

  it('reads once more after a read of every note that a commit overtook', async () => {
    const reads = watchReads()
    await subscribed()

    emitCommitted(null)
    emitCommitted(null)
    emitCommitted(null)
    await flushMicrotasks()
    expect(reads.count()).toBe(3)
  })

  it('keeps reading while one subscription is left, however often another unsubscribes', async () => {
    const reads = watchReads()
    const { unsubscribe } = await subscribed()
    tasks.subscribe(vi.fn())
    unsubscribe()
    unsubscribe()

    emitCommitted(null)
    await flushMicrotasks()
    expect(reads.count()).toBe(2)
  })

  it('reads again on the next subscription after the last one ended', async () => {
    const reads = watchReads()
    const { unsubscribe } = await subscribed()

    unsubscribe()
    emitCommitted(null)
    await flushMicrotasks()
    expect(reads.count()).toBe(1)

    tasks.subscribe(noop)
    await flushMicrotasks()
    expect(reads.count()).toBe(2)
  })

  it('keeps the state on an equal read', async () => {
    await subscribed()
    const state = tasks.get()
    const listener = vi.fn()
    tasks.subscribe(listener)

    await tasks.refresh()
    expect(tasks.get()).toBe(state)
    expect(listener).not.toHaveBeenCalled()
  })

  it('drops the rows on a graph switch and reads the new graph', async () => {
    const source = new WritableStore<{ session: GraphSession | null }>({ session: openGraph })
    const switching = createTasks(source)
    seedNotes(database, [{ path: A, markdown: '+ [ ] one\n' }])
    const reads = watchReads()
    switching.subscribe(noop)
    await flushMicrotasks()
    expect(markdowns(switching.get().open)).toEqual(['one'])

    seedNotes(database, [{ path: A, markdown: '+ [ ] two\n' }])
    source.set({
      session: createGraphSession({ root: '/h', name: 'h', generation: 8, indexGeneration: 1 }),
    })
    expect(switching.get().open).toBeUndefined()
    await flushMicrotasks()
    expect(markdowns(switching.get().open)).toEqual(['two'])

    source.set({ session: null })
    expect(switching.get().open).toBeUndefined()
    await switching.refresh()
    expect(reads.count()).toBe(2)
  })
})

describe('reads racing writes', () => {
  const NOTE = 'daily/2026-11-20.md'
  let harness: TaskHarness

  afterEach(() => {
    harness.close()
  })

  /**
   * Puts `source` on disk and in the index, subscribes, and waits for the first read to land.
   */
  async function indexed(source: string): Promise<readonly OpenTask[]> {
    harness = new TaskHarness({ files: { [NOTE]: source } })
    await harness.start()
    return harness.tasks.get().open!
  }

  it('keeps an edit when a read that started during its write lands after it', async () => {
    const [row] = await indexed('## Tasks\n\n+ [ ] \n')
    harness.holdWrites()

    const editing = harness.edit(row!, 'buy milk')
    expect(harness.tasks.get().open?.[0]?.markdown).toBe('buy milk')

    harness.holdReads()
    void harness.tasks.refresh()
    await harness.landWrite()
    await editing
    await harness.landRead()

    expect(harness.tasks.get().open?.[0]?.markdown).toBe('buy milk')
  })

  it('keeps an added row when a read that started during its write lands after it', async () => {
    const [row] = await indexed('## Tasks\n\n+ [ ] first\n')
    harness.holdWrites()

    const created = harness.tasks.commands.continueAfter(row!)
    const adding = harness.edit(created, 'buy milk')
    harness.holdReads()
    void harness.tasks.refresh()
    await harness.landWrite()
    await adding
    await harness.landRead()

    const open = harness.tasks.get().open!
    expect(open.map((row) => [row.taskId, row.markdown])).toEqual([
      [row!.taskId, 'first'],
      [created.taskId, 'buy milk'],
    ])
  })

  it('deletes an edited row after a read that started during the edit landed', async () => {
    const [row] = await indexed('## Tasks\n\n+ [ ] \n')
    harness.holdWrites()
    const editing = harness.edit(row!, 'buy milk')
    harness.holdReads()
    void harness.tasks.refresh()
    await harness.landWrite()
    await editing
    await harness.landRead()
    await harness.drain()

    expect(harness.files.files().get(NOTE)).toBe('## Tasks\n\n+ [ ] buy milk\n')
    await harness.tasks.commands.remove([harness.tasks.get().open![0]!])
    expect(harness.files.files().get(NOTE)).toBe('## Tasks\n')
  })

  it('keeps an edit when a read for a commit of another note lands after it', async () => {
    const OTHER = 'notes/other.md'
    const [row] = await indexed('## Tasks\n\n+ [ ] \n')
    harness.holdReads()
    harness.editExternally(OTHER, '+ [ ] other\n')
    await harness.deliverWatcherBatch()

    await harness.edit(row!, 'buy milk')
    expect(harness.tasks.get().open?.[0]?.markdown).toBe('buy milk')

    await harness.drain()
    expect(harness.tasks.get().open?.map((row) => row.markdown)).toEqual(['buy milk', 'other'])
  })

  it('lands an edit whose stale path matches two identical tasks on one of them', async () => {
    const stale = '+ [ ] \n+ [ ] \n'
    const second = ref(stale, 1, NOTE)
    const source = '## Tasks\n\n+ [ ] \n+ [ ] \n'
    harness = new TaskHarness({ files: { [NOTE]: source } })

    await harness.tasks.writeTask(second, [{ kind: 'setMarkdown', markdown: 'buy milk' }])
    expect(harness.files.files().get(NOTE)).toBe('## Tasks\n\n+ [ ] buy milk\n+ [ ] \n')
  })
})
