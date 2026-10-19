import type { MaybePromise } from '@reflect/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenDocumentsService,
  type OpenDocumentsService,
} from '../documents/open-documents-service.ts'
import { createGraphSession, type GraphSession } from '../graph/graph-session.ts'
import type { NoteWriteResult } from '../graph/note-file-service.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createNoteDocumentService, NoteBusyError } from '../documents/note-document-service.ts'
import {
  isSameTaskPath,
  parseNote,
  projectTasks,
  TaskStaleError,
  type TaskEditResult,
  type TaskSnapshot,
} from '../markdown/index.ts'
import type {
  IndexAppliedEvent,
  IndexReconciledEvent,
} from '../indexing/index-lifecycle-service.ts'
import { buildIndexedNote } from '../indexing/indexed-note.ts'
import type { SnippetTask } from '../indexing/snippet-tasks.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import {
  createNodeTestDatabaseService,
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
import { makeOpenTask } from '../testing/tasks.ts'
import type { OpenTask } from './open-task.ts'
import { getTaskKey } from './task-identity.ts'
import {
  createTaskService,
  type TaskRef,
  type TaskService,
  type TaskServiceDeps,
} from './task-service.ts'

/**
 * The `index`th task of `source` as the index would hand it to the Tasks view.
 */
function ref(source: string, index = 0, notePath = 'notes/a.md'): TaskRef {
  const task = projectTasks(source)[index]
  if (task === undefined) {
    throw new Error(`no task #${index} in ${JSON.stringify(source)}`)
  }
  return { notePath, astPath: task.astPath, markdown: task.markdown, checked: task.checked }
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
let appliedListeners: Set<(event: IndexAppliedEvent) => void>
let reconciledListeners: Set<(event: IndexReconciledEvent) => MaybePromise<void>>

const openGraph = createGraphSession({ root: '/g', name: 'g', generation: 7, indexGeneration: 1 })

/**
 * A graph session source over `read`, plus a way to report a switch to its subscribers.
 */
function sessionSource(read: () => GraphSession | null): TaskServiceDeps['graphSession'] & {
  notify: () => void
} {
  const listeners = new Set<() => void>()
  return {
    getState: () => ({ session: read() }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify: () => {
      for (const listener of listeners) {
        listener()
      }
    },
  }
}

function createTasks(
  graphSession: TaskServiceDeps['graphSession'],
  role: TaskServiceDeps['role'] = 'main',
): TaskService {
  const indexLifecycle = createTestIndexLifecycleService()
  vi.spyOn(indexLifecycle, 'onApplied').mockImplementation((listener) => {
    appliedListeners.add(listener)
    return () => {
      appliedListeners.delete(listener)
    }
  })
  vi.spyOn(indexLifecycle, 'onReconciled').mockImplementation((listener) => {
    reconciledListeners.add(listener)
    return () => {
      reconciledListeners.delete(listener)
    }
  })
  return createTaskService({
    database,
    noteDocuments: createNoteDocumentService({
      openDocuments,
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 3 } }),
    }),
    progress,
    clock,
    logger,
    graphSession,
    indexLifecycle,
    role,
    ipc,
  })
}

function emitApplied(): void {
  for (const listener of appliedListeners) {
    listener({ generation: 1, changes: [] })
  }
}

function openSession(session: TestNoteSession): void {
  openDocuments.register({ session })
}

beforeEach(() => {
  database = createNodeTestDatabaseService()
  noteFile = createTestNoteFileService()
  openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  progress = createTestProgressPort()
  ipc = createTestIpcBridgeService()
  clock = createTestClockService()
  logger = createTestLoggerService()
  appliedListeners = new Set()
  reconciledListeners = new Set()
  tasks = createTasks(sessionSource(() => openGraph))
})

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('write serialization', () => {
  it('serializes concurrent writes to the same note — no read/write interleave', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n')
    const pendingFirstWrite = Promise.withResolvers<NoteWriteResult>()
    let writes = 0
    const writeNote = vi.spyOn(noteFile, 'write').mockImplementation(() => {
      writes += 1
      return writes === 1 ? pendingFirstWrite.promise : Promise.resolve({ merged: null })
    })

    const first = tasks.writeTask(task, [{ kind: 'toggle' }])
    const second = tasks.writeTask(task, [{ kind: 'toggle' }])
    await flushMicrotasks()

    // The first write is in flight; the second hasn't even read yet — it's queued.
    expect(noteFile.getReads()).toHaveLength(1)
    expect(writeNote).toHaveBeenCalledTimes(1)

    pendingFirstWrite.resolve({ merged: null })
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

  it('throws NoteBusyError when the session declines, never clobbering via disk', async () => {
    openSession(sessionOver('+ [ ] do it\n', false))

    await expect(tasks.writeTask(task, [{ kind: 'remove' }])).rejects.toBeInstanceOf(NoteBusyError)
    expect(noteFile.writes()).toEqual([])
  })

  it('propagates TaskStaleError from the disk path when the index is stale', async () => {
    noteFile.set('notes/a.md', '+ [ ] something else entirely\n')

    await expect(tasks.writeTask(task, [{ kind: 'toggle' }])).rejects.toBeInstanceOf(TaskStaleError)
    expect(noteFile.writes()).toEqual([])
  })

  it('propagates TaskStaleError from the session path too', async () => {
    openSession(sessionOver('+ [ ] something else entirely\n'))

    await expect(tasks.writeTask(task, [{ kind: 'toggle' }])).rejects.toBeInstanceOf(TaskStaleError)
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

describe('insertTask', () => {
  it('starts an empty note with a Tasks section and reports the new address', async () => {
    noteFile.set('notes/a.md', '')

    clock.setNow(1000)

    await expect(tasks.insertTask('notes/a.md')).resolves.toEqual({
      created: { astPath: [1], markdown: '', breadcrumbs: ['Tasks'], checked: false },
      moved: [],
      updatedAt: 1000,
    })
    expect(noteFile.getWrites('notes/a.md')).toContain('## Tasks\n\n+ [ ] \n')
  })

  it('joins an existing Tasks section and reports the tasks it shifted', async () => {
    noteFile.set('notes/a.md', '## Tasks\n\n+ [ ] a\n\n## Later\n\n+ [ ] b\n')

    const result = await tasks.insertTask('notes/a.md')

    expect(result.created).toMatchObject({ astPath: [2] })
    expect(movedFrom(result, [1])).toMatchObject({ astPath: [1], markdown: 'a' })
    expect(movedFrom(result, [3])).toMatchObject({ astPath: [4], markdown: 'b' })
    expect(noteFile.getWrites('notes/a.md')).toContain(
      '## Tasks\n\n+ [ ] a\n+ [ ] \n\n## Later\n\n+ [ ] b\n',
    )
  })

  it('starts a note that does not exist yet', async () => {
    await tasks.insertTask('daily/2026-06-14.md')
    expect(noteFile.getWrites('daily/2026-06-14.md')).toContain('## Tasks\n\n+ [ ] \n')
  })

  it('appends through the live session when the note is open', async () => {
    const session = sessionOver('## Tasks\n\n+ [ ] first\n')
    openSession(session)

    await expect(tasks.insertTask('notes/a.md')).resolves.toMatchObject({
      created: { astPath: [2] },
    })
    expect(noteFile.writes()).toEqual([])
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
    noteFile.set('notes/a.md', source)

    const result = await tasks.continueTaskInContext(ref(source), 'edited first')

    const written = [
      '+ StartupToolbox',
      '  + Reflections',
      '    + [ ] edited first',
      '    + [ ] ',
      '  + Later',
      '    + [ ] third',
      '',
    ].join('\n')
    expect(noteFile.getWrites('notes/a.md')).toContain(written)
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
    noteFile.set('notes/a.md', source)

    const result = await tasks.continueTaskInContext(ref(source), '')

    const written = '+ Group\n  + [ ] peer\n  + [ ] \n'
    expect(noteFile.getWrites('notes/a.md')).toContain(written)
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
    noteFile.set('notes/a.md', source)

    await tasks.continueTaskInContext(ref(indexedSource), 'filled')
    expect(noteFile.getWrites('notes/a.md')).toContain(
      'Intro\n\n+ Group\n  + [ ] filled\n  + [ ] \n',
    )
  })

  it('continues the own list of a root-level task', async () => {
    const source = '+ [ ] alone\n'
    noteFile.set('notes/a.md', source)

    const result = await tasks.continueTaskInContext(ref(source), null)

    expect(noteFile.getWrites('notes/a.md')).toContain('+ [ ] alone\n+ [ ] \n')
    expect(result.created).toMatchObject({ astPath: [1] })
  })

  it('returns a result shaped for the cache', async () => {
    const source = '+ Group\n  + [ ] first\n'
    noteFile.set('notes/a.md', source)

    const result = await tasks.continueTaskInContext(ref(source), null)
    const first = { astPath: [0, 1], markdown: 'first', breadcrumbs: ['Group'], checked: false }
    expect(result.moved).toEqual([{ from: first, to: first }])
  })
})

describe('getOpenTasks', () => {
  it('parses task breadcrumbs and normalizes boolean note context', async () => {
    seedNotes(database, [
      {
        path: 'notes/project.md',
        markdown:
          '---\npinned: 2\n---\n# Project\n\n- StartupToolbox\n  - *Reflections*\n    + [ ] ship [[it]] **now**\n    + [x] shipped\n',
        mtime: 123,
      },
    ])

    await expect(tasks.getOpenTasks()).resolves.toEqual([
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
    const [row] = await tasks.getOpenTasks()
    expect(row!.breadcrumbs.at(-2)).toBe('StartupToolbox')
    expect(row!.breadcrumbs.at(-1)).toBe('Reflections')
  })

  it('sorts rows by note path, then by their place in the note', async () => {
    seedNotes(database, [
      { path: 'notes/b.md', markdown: '+ [ ] b first\n' },
      { path: 'notes/a.md', markdown: '+ [ ] a first\n  + [ ] a nested\n\npara\n\n+ [ ] a last\n' },
    ])

    const rows = await tasks.getOpenTasks()
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

    const rows = await tasks.getOpenTasks()
    expect(rows.map((row) => row.astPath)).toEqual([[1]])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'tasks: skipping an unreadable row in notes/a.md (not json)',
      'tasks: skipping an unreadable row in notes/a.md ([])',
    ])
  })

  it('never surfaces template checkboxes — boilerplate, not real tasks', async () => {
    seedNotes(database, [
      { path: 'templates/todo.md', markdown: '+ [ ] template task\n' },
      { path: 'notes/a.md', markdown: '+ [ ] real task\n' },
    ])

    const rows = await tasks.getOpenTasks()
    expect(rows.map((row) => row.notePath)).toEqual(['notes/a.md'])
  })
})

describe('getCompletedTasks', () => {
  it('lists checked tasks, most recently edited note first', async () => {
    seedNotes(database, [
      { path: 'notes/old.md', markdown: '+ [x] old done\n+ [ ] old open\n', mtime: 1 },
      { path: 'notes/new.md', markdown: '+ [x] new done\n', mtime: 2 },
    ])

    const completed = await tasks.getCompletedTasks()
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

describe('batch writes', () => {
  it('writes in order and re-addresses the rest of the batch after each write', async () => {
    const source = '+ [ ] one\n+ [ ] two\n+ [ ] three\n'
    noteFile.set('notes/a.md', source)
    const rows = projectTasks(source).map((row) =>
      makeOpenTask({ notePath: 'notes/a.md', astPath: [...row.astPath], markdown: row.markdown }),
    )

    await tasks.deleteTasks([rows[0]!, rows[2]!])

    // Removing "one" moved "three" up; its write addresses the new place.
    expect(noteFile.getWrites('notes/a.md')).toEqual(['+ [ ] two\n+ [ ] three\n', '+ [ ] two\n'])
  })

  it('stops at the first failed write, leaving the earlier ones landed', async () => {
    noteFile.set('notes/a.md', '+ [ ] one\n')
    const one = makeOpenTask({ notePath: 'notes/a.md', astPath: [0], markdown: 'one' })
    const gone = makeOpenTask({ notePath: 'notes/a.md', astPath: [5], markdown: 'gone' })

    await expect(tasks.completeTasks([one, gone])).rejects.toBeInstanceOf(TaskStaleError)
    expect(noteFile.getWrites('notes/a.md')).toEqual(['+ [x] one\n'])
  })
})

describe('snippet tasks', () => {
  const source = '+ [ ] do it\n'
  const anchors: SnippetTask[] = [
    { locator: { astPath: [0], markdown: 'do it', checked: false }, checked: false, text: 'do it' },
    { locator: null, checked: false, text: 'square box' },
  ]

  it('resolves a click whose index, state and text all match its anchor', () => {
    expect(tasks.resolveSnippetTask(anchors, { index: 0, checked: false, text: 'do it' })).toBe(
      anchors[0],
    )
    expect(
      tasks.resolveSnippetTask(anchors, { index: 1, checked: false, text: 'square box' }),
    ).toBe(anchors[1])
    expect(progress.getAll()).toEqual([])
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
      progress.getAll().map((operation) => [operation.label, operation.status, operation.message]),
    ).toEqual([
      ['Updating task', 'failed', 'The note has changed — try again in a moment.'],
      ['Updating task', 'failed', 'The note has changed — try again in a moment.'],
      ['Updating task', 'failed', 'The note has changed — try again in a moment.'],
    ])
  })

  it('toggles the source task', async () => {
    noteFile.set('notes/a.md', source)
    await tasks.toggleSnippetTask('notes/a.md', {
      locator: { astPath: [0], markdown: 'do it', checked: false },
      checked: false,
    })
    expect(noteFile.getWrites('notes/a.md')).toEqual(['+ [x] do it\n'])
    expect(progress.getAll()).toEqual([])
  })

  it('reports a failed toggle, labelled for its direction, and rethrows', async () => {
    noteFile.set('notes/a.md', '+ [x] something else\n')
    await expect(
      tasks.toggleSnippetTask('notes/a.md', {
        locator: { astPath: [0], markdown: 'do it', checked: true },
        checked: true,
      }),
    ).rejects.toBeInstanceOf(TaskStaleError)
    expect(progress.findByLabel('Reopening task')?.status).toBe('failed')
  })
})

describe('no graph open', () => {
  it('rejects writes and skips snippet toggles', async () => {
    noteFile.set('notes/a.md', '+ [ ] do it\n')
    const closed = createTasks(sessionSource(() => null))

    await expect(closed.writeTask(task, [{ kind: 'toggle' }])).rejects.toThrow('No graph is open.')
    await closed.toggleSnippetTask('notes/a.md', { locator: task, checked: false })
    expect(noteFile.writes()).toEqual([])
    expect(progress.getAll()).toEqual([])
  })

  it('stops a batch once its graph is replaced', async () => {
    noteFile.set('notes/a.md', '+ [ ] one\n+ [ ] two\n')
    const controller = new AbortController()
    let session = createGraphSession(
      { root: '/g', name: 'g', generation: 7, indexGeneration: 1 },
      controller.signal,
    )
    const switching = createTasks(sessionSource(() => session))
    const one = makeOpenTask({ notePath: 'notes/a.md', astPath: [0], markdown: 'one' })
    const two = makeOpenTask({ notePath: 'notes/a.md', astPath: [1], markdown: 'two' })
    const writeTask = switching.writeTask.bind(switching)
    vi.spyOn(switching, 'writeTask').mockImplementation(async (task, actions) => {
      const result = await writeTask(task, actions)
      controller.abort()
      session = createGraphSession({ root: '/h', name: 'h', generation: 8, indexGeneration: 1 })
      return result
    })

    await expect(switching.completeTasks([one, two])).rejects.toThrow('No graph is open.')
    expect(noteFile.getWrites('notes/a.md')).toEqual(['+ [x] one\n+ [ ] two\n'])
  })
})

describe('recently completed', () => {
  const a = makeOpenTask({ notePath: 'notes/a.md', astPath: [0], markdown: 'a', updatedAt: 10 })
  const b = makeOpenTask({ notePath: 'notes/b.md', astPath: [0], markdown: 'b', updatedAt: 10 })

  it('keeps completed rows as checked copies, scoped to their graph', () => {
    tasks.markRecentlyCompleted('/g', [a])
    expect(tasks.getRecentlyCompleted('/g')).toEqual([{ ...a, checked: true }])
    expect(tasks.hasRecentlyCompleted('/g', getTaskKey(a))).toBe(true)
    expect(tasks.getRecentlyCompleted('/other')).toEqual([])
    expect(tasks.hasRecentlyCompleted('/other', getTaskKey(a))).toBe(false)

    // Marking for another graph discards the previous graph's rows.
    tasks.markRecentlyCompleted('/other', [b])
    expect(tasks.getRecentlyCompleted('/g')).toEqual([])
  })

  it('notifies subscribers on every change until they unsubscribe', () => {
    let calls = 0
    const unsubscribe = tasks.subscribeRecentlyCompleted(() => {
      calls += 1
    })
    tasks.markRecentlyCompleted('/g', [a, b])
    tasks.forgetRecentlyCompleted('/g', [getTaskKey(a)])
    tasks.forgetRecentlyCompleted('/g', [getTaskKey(a)])
    tasks.archiveRecentlyCompleted('/g')
    expect(calls).toBe(3)

    unsubscribe()
    tasks.markRecentlyCompleted('/g', [a])
    expect(calls).toBe(3)
  })

  it('drops a struck row the index reports open again with a newer updatedAt', () => {
    tasks.markRecentlyCompleted('/g', [a, b])
    tasks.reconcileRecentlyCompleted('/g', [
      { ...a, checked: false, updatedAt: 11 },
      { ...b, checked: false, updatedAt: 10 },
    ])
    expect(tasks.getRecentlyCompleted('/g').map(getTaskKey)).toEqual([getTaskKey(b)])
  })

  it('re-keys struck rows a note write moved', () => {
    tasks.markRecentlyCompleted('/g', [a])
    const from = { astPath: [0], markdown: 'a', breadcrumbs: [], checked: true }
    tasks.relocateRecentlyCompleted('/g', 'notes/a.md', [{ from, to: { ...from, astPath: [2] } }])
    expect(tasks.getRecentlyCompleted('/g').map((row) => row.astPath)).toEqual([[2]])
  })

  it('is separate per service', () => {
    tasks.markRecentlyCompleted('/g', [a])
    const other = createTasks(sessionSource(() => openGraph))
    expect(other.getRecentlyCompleted('/g')).toEqual([])
  })
})

describe('task list state', () => {
  const one = makeOpenTask({ notePath: 'notes/a.md', astPath: [0], markdown: 'one', text: 'one' })
  const two = makeOpenTask({ notePath: 'notes/b.md', astPath: [0], markdown: 'two', text: 'two' })
  const written = { source: '', moved: [], inserted: [], tasks: [], updatedAt: 0 }

  /**
   * Subscribe to `tasks` over `open` and wait for the first read to land.
   */
  async function subscribed(open: readonly OpenTask[] = [one, two]) {
    const getOpenTasks = vi.spyOn(tasks, 'getOpenTasks').mockResolvedValue([...open])
    const unsubscribe = tasks.subscribe(() => {})
    await flushMicrotasks()
    return { getOpenTasks, unsubscribe }
  }

  it('reads the open tasks on the first subscription, not before', async () => {
    seedNotes(database, [{ path: 'notes/a.md', markdown: '+ [ ] one\n+ [x] done\n' }])
    const getOpenTasks = vi.spyOn(tasks, 'getOpenTasks')
    expect(tasks.getState()).toEqual({
      open: undefined,
      completed: undefined,
      openFailed: false,
      completedFailed: false,
    })
    expect(getOpenTasks).not.toHaveBeenCalled()

    let changes = 0
    tasks.subscribe(() => {
      changes += 1
    })
    await flushMicrotasks()

    expect(tasks.getState().open?.map((row) => row.markdown)).toEqual(['one'])
    expect(tasks.getState().completed).toBeUndefined()
    expect(tasks.getState()).toBe(tasks.getState())
    expect(changes).toBe(1)
  })

  it('reads the completed tasks only while they are included', async () => {
    await subscribed()
    const getCompletedTasks = vi.spyOn(tasks, 'getCompletedTasks').mockResolvedValue([one])
    expect(getCompletedTasks).not.toHaveBeenCalled()

    const release = tasks.includeCompleted()
    await flushMicrotasks()
    expect(tasks.getState().completed).toEqual([one])

    release()
    await tasks.refresh()
    expect(getCompletedTasks).toHaveBeenCalledTimes(1)
  })

  it('reports a failed read and clears it once a read lands', async () => {
    const getOpenTasks = vi.spyOn(tasks, 'getOpenTasks').mockRejectedValue(new Error('no index'))
    tasks.subscribe(() => {})
    await flushMicrotasks()
    expect(tasks.getState()).toMatchObject({ open: undefined, openFailed: true })

    getOpenTasks.mockResolvedValue([one])
    await tasks.refresh()
    expect(tasks.getState()).toMatchObject({ open: [one], openFailed: false })
  })

  it('applies the optimistic patch before the write starts', async () => {
    await subscribed()
    const write = Promise.withResolvers<typeof written>()
    const writeTask = vi.spyOn(tasks, 'writeTask').mockReturnValue(write.promise)

    const completing = tasks.completeTasks([one])

    expect(tasks.getState().open).toEqual([two])
    expect(tasks.getRecentlyCompleted('/g')).toEqual([{ ...one, checked: true }])
    expect(writeTask).toHaveBeenCalledWith(one, [{ kind: 'toggle' }])
    write.resolve(written)
    await completing
    expect(tasks.getState().open).toEqual([two])
  })

  it('drops a read in flight when a bulk action patches the rows', async () => {
    const { getOpenTasks } = await subscribed()
    const read = Promise.withResolvers<OpenTask[]>()
    getOpenTasks.mockReturnValue(read.promise)
    vi.spyOn(tasks, 'writeTask').mockResolvedValue(written)

    const refreshing = tasks.refresh()
    await tasks.completeTasks([one])
    read.resolve([one, two])
    await refreshing
    await flushMicrotasks()

    expect(tasks.getState().open).toEqual([two])
  })

  it('restores the rows and rethrows when a single write fails', async () => {
    await subscribed()
    vi.spyOn(tasks, 'writeTask').mockRejectedValue(new Error('disk full'))

    const editing = tasks.editTask(one, 'edited')
    expect(tasks.getState().open?.[0]).toMatchObject({ markdown: 'edited', text: 'edited' })

    await expect(editing).rejects.toThrow('disk full')
    expect(tasks.getState().open).toEqual([one, two])
  })

  it('restores the struck row when an edit-and-reopen write fails', async () => {
    await subscribed([])
    tasks.markRecentlyCompleted('/g', [one])
    const struck = { ...one, checked: true }
    vi.spyOn(tasks, 'writeTask').mockRejectedValue(new Error('disk full'))

    const reopening = tasks.editAndToggleTask(struck, 'edited')
    expect(tasks.hasRecentlyCompleted('/g', getTaskKey(one))).toBe(false)
    expect(tasks.getState().open).toEqual([
      { ...struck, checked: false, markdown: 'edited', text: 'edited' },
    ])

    await expect(reopening).rejects.toThrow('disk full')
    expect(tasks.getState().open).toEqual([])
    expect(tasks.getRecentlyCompleted('/g')).toEqual([struck])
  })

  it('re-reads instead of restoring when a batch fails', async () => {
    const { getOpenTasks } = await subscribed()
    getOpenTasks.mockResolvedValue([one])
    vi.spyOn(tasks, 'writeTask').mockRejectedValue(new Error('stale index'))

    await expect(tasks.completeTasks([one, two])).rejects.toThrow('stale index')
    await flushMicrotasks()

    expect(getOpenTasks).toHaveBeenCalledTimes(2)
    expect(tasks.getState().open).toEqual([one])
    expect(tasks.getRecentlyCompleted('/g')).toEqual([])
  })

  it('keeps a checked task struck when its delete fails', async () => {
    await subscribed([])
    const struck = { ...one, checked: true }
    tasks.markRecentlyCompleted('/g', [one])
    vi.spyOn(tasks, 'writeTask').mockRejectedValue(new Error('disk full'))

    const deleting = tasks.deleteTasks([struck])
    expect(tasks.getRecentlyCompleted('/g')).toEqual([])

    await expect(deleting).rejects.toThrow('disk full')
    expect(tasks.getRecentlyCompleted('/g')).toEqual([struck])
  })

  it('re-keys the rows a write moved and adds the inserted row', async () => {
    await subscribed()
    const from = { astPath: [0], markdown: 'one', breadcrumbs: [], checked: false }
    vi.spyOn(tasks, 'insertTask').mockResolvedValue({
      created: { astPath: [0], markdown: '', breadcrumbs: [], checked: false },
      moved: [{ from, to: { ...from, astPath: [1] } }],
      updatedAt: 5,
    })

    const created = await tasks.addTask(one)

    expect(created).toMatchObject({ notePath: 'notes/a.md', astPath: [0], markdown: '' })
    expect(tasks.getState().open?.map((row) => [row.markdown, row.astPath])).toEqual([
      ['one', [1]],
      ['two', [0]],
      ['', [0]],
    ])
  })

  it('drops a read in flight that an optimistic write overtook', async () => {
    const { getOpenTasks } = await subscribed()
    const read = Promise.withResolvers<OpenTask[]>()
    getOpenTasks.mockReturnValue(read.promise)
    vi.spyOn(tasks, 'writeTask').mockResolvedValue(written)

    const refreshing = tasks.refresh()
    await tasks.editTask(one, 'edited')
    read.resolve([one, two])
    await refreshing

    expect(tasks.getState().open?.[0]).toMatchObject({ markdown: 'edited' })
  })

  it('re-reads on index changes while subscribed, at most once per throttle window', async () => {
    const { getOpenTasks, unsubscribe } = await subscribed()

    emitApplied()
    emitApplied()
    emitApplied()
    await flushMicrotasks()
    expect(getOpenTasks).toHaveBeenCalledTimes(2)

    await clock.advance(3_000)
    expect(getOpenTasks).toHaveBeenCalledTimes(3)

    // Unsubscribed, a change only marks the rows stale for the next subscriber.
    unsubscribe()
    await clock.advance(3_000)
    emitApplied()
    await flushMicrotasks()
    expect(getOpenTasks).toHaveBeenCalledTimes(3)
    tasks.subscribe(() => {})
    await flushMicrotasks()
    expect(getOpenTasks).toHaveBeenCalledTimes(4)
  })

  it('re-reads on an index:written broadcast in a note window only', async () => {
    for (const [role, reads] of [
      ['main', 1],
      ['note-window', 2],
    ] as const) {
      tasks = createTasks(
        sessionSource(() => openGraph),
        role,
      )
      const getOpenTasks = vi.spyOn(tasks, 'getOpenTasks').mockResolvedValue([one])
      tasks.subscribe(() => {})
      await flushMicrotasks()

      ipc.emit('index:written', null)
      await flushMicrotasks()

      expect(getOpenTasks).toHaveBeenCalledTimes(reads)
    }
  })

  it('re-reads after a requested rebuild but not after a sync pass', async () => {
    const { getOpenTasks } = await subscribed()

    for (const listener of reconciledListeners) {
      void listener({ generation: 1, fileGeneration: 1, source: 'sync' })
    }
    await flushMicrotasks()
    expect(getOpenTasks).toHaveBeenCalledTimes(1)

    for (const listener of reconciledListeners) {
      void listener({ generation: 1, fileGeneration: 1, source: 'rebuild' })
    }
    await flushMicrotasks()
    expect(getOpenTasks).toHaveBeenCalledTimes(2)
  })

  it('drops the rows on a graph switch and reads the new graph', async () => {
    let session: GraphSession | null = openGraph
    const source = sessionSource(() => session)
    const switching = createTasks(source)
    const getOpenTasks = vi.spyOn(switching, 'getOpenTasks').mockResolvedValue([one])
    switching.subscribe(() => {})
    await flushMicrotasks()
    expect(switching.getState().open).toEqual([one])

    getOpenTasks.mockResolvedValue([two])
    session = createGraphSession({ root: '/h', name: 'h', generation: 8, indexGeneration: 1 })
    source.notify()
    expect(switching.getState().open).toBeUndefined()
    await flushMicrotasks()
    expect(switching.getState().open).toEqual([two])

    session = null
    source.notify()
    expect(switching.getState().open).toBeUndefined()
    await switching.refresh()
    expect(getOpenTasks).toHaveBeenCalledTimes(2)
  })
})
