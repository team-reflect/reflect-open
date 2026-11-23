import { sha256HexSync } from '@reflect/utils'
import type { MaybePromise } from '@reflect/utils'
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
import type {
  IndexAppliedEvent,
  IndexReconciledEvent,
} from '../indexing/index-lifecycle-service.ts'
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
import { makeOpenTask } from '../testing/tasks.ts'
import type { OpenTask } from './open-task.ts'
import { getTaskKey } from './task-identity.ts'
import { todaysDailyTarget } from './task-navigation.ts'
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
let appliedListeners: Set<(event: IndexAppliedEvent) => void>
let reconciledListeners: Set<(event: IndexReconciledEvent) => MaybePromise<void>>

const openGraph = createGraphSession({ root: '/g', name: 'g', generation: 7, indexGeneration: 1 })

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
      indexLifecycle: createTestIndexLifecycleService(),
      logger: createTestLoggerService(),
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
  database = createTestDatabaseService()
  noteFile = createTestNoteFileService()
  openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  progress = createTestProgressPort()
  ipc = createTestIpcBridgeService()
  clock = createTestClockService()
  logger = createTestLoggerService()
  appliedListeners = new Set()
  reconciledListeners = new Set()
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

describe('insertTask', () => {
  it('starts an empty note with a Tasks section and reports the new address', async () => {
    noteFile.set('notes/a.md', '')

    clock.setNow(1000)

    const created = { astPath: [1], markdown: '', breadcrumbs: ['Tasks'], checked: false }
    await expect(tasks.insertTask('notes/a.md')).resolves.toEqual({
      created,
      source: '## Tasks\n\n+ [ ] \n',
      baseRevision: sha256HexSync(''),
      revision: sha256HexSync('## Tasks\n\n+ [ ] \n'),
      moved: [],
      inserted: [created],
      tasks: [created],
      merged: false,
      indexSeq: null,
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

describe('batch writes', () => {
  it('writes in order and re-addresses the rest of the batch after each write', async () => {
    const source = '+ [ ] one\n+ [ ] two\n+ [ ] three\n'
    noteFile.set('notes/a.md', source)
    const rows = projectTasks(source).map((row) => {
      return makeOpenTask({
        notePath: 'notes/a.md',
        astPath: [...row.astPath],
        markdown: row.markdown,
      })
    })

    await tasks.deleteTasks([rows[0]!, rows[2]!])

    // Removing "one" moved "three" up; its write addresses the new place.
    expect(noteFile.getWrites('notes/a.md')).toEqual(['+ [ ] two\n+ [ ] three\n', '+ [ ] two\n'])
  })

  it('stops at the first failed write, leaving the earlier ones landed', async () => {
    noteFile.set('notes/a.md', '+ [ ] one\n')
    const one = makeOpenTask({ notePath: 'notes/a.md', astPath: [0], markdown: 'one' })
    const gone = makeOpenTask({ notePath: 'notes/a.md', astPath: [5], markdown: 'gone' })

    await expect(tasks.completeTasks([one, gone])).rejects.toMatchObject({ kind: 'stale' })
    expect(noteFile.getWrites('notes/a.md')).toEqual(['+ [x] one\n'])
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

  it('stops a batch once its graph is replaced', async () => {
    noteFile.set('notes/a.md', '+ [ ] one\n+ [ ] two\n')
    const controller = new AbortController()
    const source = new WritableStore<{ session: GraphSession | null }>({
      session: createGraphSession(
        { root: '/g', name: 'g', generation: 7, indexGeneration: 1 },
        controller.signal,
      ),
    })
    const switching = createTasks(source)
    const one = makeOpenTask({ notePath: 'notes/a.md', astPath: [0], markdown: 'one' })
    const two = makeOpenTask({ notePath: 'notes/a.md', astPath: [1], markdown: 'two' })
    const writeTask = switching.writeTask.bind(switching)
    vi.spyOn(switching, 'writeTask').mockImplementation(async (task, actions) => {
      const result = await writeTask(task, actions)
      controller.abort()
      source.set({
        session: createGraphSession({ root: '/h', name: 'h', generation: 8, indexGeneration: 1 }),
      })
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
    expect(tasks.recentlyCompleted.get()).toEqual({ root: '/g', tasks: [{ ...a, checked: true }] })
    expect(tasks.hasRecentlyCompleted('/g', getTaskKey(a))).toBe(true)
    expect(tasks.hasRecentlyCompleted('/other', getTaskKey(a))).toBe(false)

    // Marking for another graph discards the previous graph's rows.
    tasks.markRecentlyCompleted('/other', [b])
    expect(tasks.recentlyCompleted.get()).toEqual({
      root: '/other',
      tasks: [{ ...b, checked: true }],
    })
  })

  it('notifies subscribers on every change until they unsubscribe', () => {
    let calls = 0
    const unsubscribe = tasks.recentlyCompleted.subscribe(() => {
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
    expect(tasks.recentlyCompleted.get().tasks.map(getTaskKey)).toEqual([getTaskKey(b)])
  })

  it('re-keys struck rows a note write moved', () => {
    tasks.markRecentlyCompleted('/g', [a])
    const from = { astPath: [0], markdown: 'a', breadcrumbs: [], checked: true }
    tasks.relocateRecentlyCompleted('/g', 'notes/a.md', {
      baseRevision: '',
      revision: '',
      moved: [{ from, to: { ...from, astPath: [2] } }],
    })
    expect(tasks.recentlyCompleted.get().tasks.map((row) => row.astPath)).toEqual([[2]])
  })

  it('is separate per service', () => {
    tasks.markRecentlyCompleted('/g', [a])
    const other = createTasks(new WritableStore({ session: openGraph }))
    expect(other.recentlyCompleted.get().tasks).toEqual([])
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
  function watchReads(): { count: () => number; filters: () => unknown[] } {
    const read = vi.spyOn(database, 'read')
    const calls = () => read.mock.calls.filter(([command]) => command === 'index_tasks')
    return {
      count: () => calls().length,
      filters: () => calls().map(([, args]) => (args as { checked: boolean | null }).checked),
    }
  }

  function markdowns(rows: readonly OpenTask[] | undefined): string[] | undefined {
    return rows?.map((row) => row.markdown)
  }

  it('reads the open tasks on the first subscription, not before', async () => {
    seedNotes(database, [{ path: A, markdown: '+ [ ] one\n+ [x] done\n' }])
    const reads = watchReads()
    expect(tasks.get()).toEqual({ open: undefined, completed: undefined })
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

  it('shows the change before the write starts', async () => {
    const { rows } = await subscribed()
    const write = Promise.withResolvers<void>()
    const writeTask = tasks.writeTask.bind(tasks)
    const spy = vi.spyOn(tasks, 'writeTask').mockImplementation(async (ref, actions) => {
      await write.promise
      return await writeTask(ref, actions)
    })

    const completing = tasks.completeTasks([rows[0]!])

    expect(markdowns(tasks.get().open)).toEqual(['two'])
    expect(tasks.recentlyCompleted.get().tasks).toEqual([{ ...rows[0]!, checked: true }])
    expect(spy).toHaveBeenCalledWith(rows[0], [{ kind: 'toggle' }])
    write.resolve()
    await completing
    expect(markdowns(tasks.get().open)).toEqual(['two'])
    expect(noteFile.files().get(A)).toBe('+ [x] one\n')
  })

  it('puts the row back and rethrows when a single write fails', async () => {
    const { rows } = await subscribed()
    vi.spyOn(tasks, 'writeTask').mockRejectedValue(new Error('disk full'))

    const editing = tasks.editTask(rows[0]!, 'edited [[2026-06-20]]')
    expect(tasks.get().open?.[0]).toMatchObject({
      taskId: rows[0]!.taskId,
      markdown: 'edited [[2026-06-20]]',
      text: 'edited 2026-06-20',
      dueDate: '2026-06-20',
    })

    await expect(editing).rejects.toThrow('disk full')
    expect(tasks.get().open).toEqual(rows)
  })

  it('keeps the change of another write when one write fails', async () => {
    const { rows } = await subscribed({ [A]: '+ [ ] one\n+ [ ] two\n' })
    const writeTask = tasks.writeTask.bind(tasks)
    const first = Promise.withResolvers<void>()
    vi.spyOn(tasks, 'writeTask').mockImplementation(async (ref, actions) => {
      if (ref.markdown === 'one') {
        await first.promise
        throw new Error('disk full')
      }
      return await writeTask(ref, actions)
    })

    const failing = tasks.editTask(rows[0]!, 'one!')
    const landing = tasks.editTask(rows[1]!, 'two!')
    expect(markdowns(tasks.get().open)).toEqual(['one!', 'two!'])

    await landing
    first.resolve()
    await expect(failing).rejects.toThrow('disk full')
    expect(markdowns(tasks.get().open)).toEqual(['one', 'two!'])
  })

  it('restores the struck row when an edit-and-reopen write fails', async () => {
    await subscribed({ [A]: '+ [x] one\n' })
    tasks.includeCompleted()
    await flushMicrotasks()
    const struck = tasks.get().completed![0]!
    tasks.markRecentlyCompleted('/g', [struck])
    vi.spyOn(tasks, 'writeTask').mockRejectedValue(new Error('disk full'))

    const reopening = tasks.editAndToggleTask(struck, 'edited')
    expect(tasks.hasRecentlyCompleted('/g', getTaskKey(struck))).toBe(false)
    expect(tasks.get().open).toEqual([
      { ...struck, checked: false, markdown: 'edited', text: 'edited' },
    ])

    await expect(reopening).rejects.toThrow('disk full')
    expect(tasks.get().open).toEqual([])
    expect(tasks.recentlyCompleted.get().tasks).toEqual([struck])
  })

  it('keeps the writes of a batch that landed and puts the other rows back', async () => {
    const { rows } = await subscribed({ [A]: '+ [ ] one\n+ [ ] two\n+ [ ] three\n' })
    const writeTask = tasks.writeTask.bind(tasks)
    vi.spyOn(tasks, 'writeTask').mockImplementation(async (ref, actions) => {
      if (ref.markdown === 'two') {
        throw new Error('stale index')
      }
      return await writeTask(ref, actions)
    })

    const completing = tasks.completeTasks(rows)
    expect(tasks.get().open).toEqual([])

    await expect(completing).rejects.toThrow('stale index')
    expect(markdowns(tasks.get().open)).toEqual(['two', 'three'])
    expect(noteFile.files().get(A)).toBe('+ [x] one\n+ [ ] two\n+ [ ] three\n')
    expect(tasks.recentlyCompleted.get().tasks).toEqual([])
  })

  it('keeps a checked task struck when its delete fails', async () => {
    await subscribed({ [A]: '+ [x] one\n' })
    tasks.includeCompleted()
    await flushMicrotasks()
    const struck = tasks.get().completed![0]!
    tasks.markRecentlyCompleted('/g', [struck])
    vi.spyOn(tasks, 'writeTask').mockRejectedValue(new Error('disk full'))

    const deleting = tasks.deleteTasks([struck])
    expect(tasks.recentlyCompleted.get().tasks).toEqual([])
    expect(tasks.get().completed).toEqual([])

    await expect(deleting).rejects.toThrow('disk full')
    expect(tasks.recentlyCompleted.get().tasks).toEqual([struck])
    expect(tasks.get().completed).toEqual([struck])
  })

  it('adds the inserted row and keeps the ids of the rows the write moved', async () => {
    const { rows } = await subscribed({
      [A]: '+ [ ] loose\n\n## Tasks\n\n+ [ ] one\n\n## Later\n\n+ [ ] last\n',
    })
    clock.setNow(5)

    const created = await tasks.addTask(rows[0]!)

    expect(created).toMatchObject({ notePath: A, astPath: [3], markdown: '', updatedAt: 5 })
    expect(tasks.get().open?.map((row) => [row.taskId, row.markdown, row.astPath])).toEqual([
      [rows[0]!.taskId, 'loose', [0]],
      [rows[1]!.taskId, 'one', [2]],
      [created.taskId, '', [3]],
      [rows[2]!.taskId, 'last', [5]],
    ])
  })

  it('adds the first task of a note that has no file', async () => {
    await subscribed({})
    const target = todaysDailyTarget('2026-06-14')

    const created = await tasks.addTask(target)

    expect(tasks.get().open).toEqual([created])
    expect(created).toMatchObject({ ...target, markdown: '', breadcrumbs: ['Tasks'] })
  })

  it('resolves the anchor and adds the next row in one write', async () => {
    const { rows } = await subscribed({ [A]: '+ [ ] one\n+ [ ] two\n' })

    const adding = tasks.addTaskAfter(rows[0]!, 'one!')
    expect(markdowns(tasks.get().open)).toEqual(['one!', 'two'])
    const created = await adding

    expect(noteFile.getWrites(A)).toEqual(['+ [ ] one!\n+ [ ] two\n+ [ ] \n'])
    expect(tasks.get().open?.map((row) => [row.taskId, row.markdown])).toEqual([
      [rows[0]!.taskId, 'one!'],
      [rows[1]!.taskId, 'two'],
      [created.taskId, ''],
    ])
  })

  it('takes the rows a backlink snippet toggle left', async () => {
    const { rows } = await subscribed({ [A]: '+ [ ] one\n+ [ ] two\n' })

    await tasks.toggleSnippetTask(A, { locator: rows[0]!, checked: false })

    expect(markdowns(tasks.get().open)).toEqual(['two'])
  })

  it('re-reads on index changes while subscribed, at most once per throttle window', async () => {
    const reads = watchReads()
    const { unsubscribe } = await subscribed()

    emitApplied()
    emitApplied()
    emitApplied()
    await flushMicrotasks()
    expect(reads.count()).toBe(2)

    await clock.advance(3_000)
    expect(reads.count()).toBe(3)

    // Unsubscribed, the service stops listening and the next subscriber reads again.
    unsubscribe()
    expect(appliedListeners.size).toBe(0)
    expect(reconciledListeners.size).toBe(0)
    await clock.advance(3_000)
    emitApplied()
    await flushMicrotasks()
    expect(reads.count()).toBe(3)
    tasks.subscribe(noop)
    await flushMicrotasks()
    expect(reads.count()).toBe(4)
  })

  it('keeps reading while one subscription is left, however often another unsubscribes', async () => {
    const reads = watchReads()
    const { unsubscribe } = await subscribed()
    tasks.subscribe(vi.fn())
    unsubscribe()
    unsubscribe()

    emitApplied()
    await flushMicrotasks()
    expect(reads.count()).toBe(2)
  })

  it('keeps the state on an equal read and apart from the recently-completed set', async () => {
    const { rows } = await subscribed()
    const state = tasks.get()
    const listener = vi.fn()
    tasks.subscribe(listener)
    const struckListener = vi.fn()
    tasks.recentlyCompleted.subscribe(struckListener)

    await tasks.refresh()
    tasks.markRecentlyCompleted('/g', [rows[0]!])
    expect(tasks.get()).toBe(state)
    expect(listener).not.toHaveBeenCalled()
    expect(struckListener).toHaveBeenCalledTimes(1)
  })

  it('re-reads on an index:committed broadcast in a note window only', async () => {
    for (const [role, count] of [
      ['main', 1],
      ['note-window', 2],
    ] as const) {
      tasks = createTasks(new WritableStore({ session: openGraph }), role)
      const reads = watchReads()
      tasks.subscribe(noop)
      await flushMicrotasks()

      ipc.emit('index:committed', { seq: 1, paths: null })
      await flushMicrotasks()

      expect(reads.count()).toBe(count)
      vi.restoreAllMocks()
    }
  })

  it('re-reads after a requested rebuild but not after a sync pass', async () => {
    const reads = watchReads()
    await subscribed()

    for (const listener of reconciledListeners) {
      void listener({ generation: 1, fileGeneration: 1, source: 'sync' })
    }
    await flushMicrotasks()
    expect(reads.count()).toBe(1)

    for (const listener of reconciledListeners) {
      void listener({ generation: 1, fileGeneration: 1, source: 'rebuild' })
    }
    await flushMicrotasks()
    expect(reads.count()).toBe(2)
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

    const editing = harness.tasks.editTask(row!, 'buy milk')
    expect(harness.tasks.get().open?.[0]?.markdown).toBe('buy milk')

    harness.holdReads()
    void harness.tasks.refresh()
    await harness.landWrite()
    await editing
    await harness.landRead()

    expect(harness.tasks.get().open?.[0]?.markdown).toBe('buy milk')
  })

  it('keeps an added row when a read that started during its write lands after it', async () => {
    const [row] = await indexed('## Tasks\n\n+ [ ] \n')
    harness.holdWrites()

    const adding = harness.tasks.addTaskAfter(row!, 'buy milk')
    harness.holdReads()
    void harness.tasks.refresh()
    await harness.landWrite()
    const created = await adding
    await harness.landRead()

    const open = harness.tasks.get().open!
    expect(open.map((row) => row.markdown)).toEqual(['buy milk', ''])
    expect(open.some((row) => isSameTaskPath(row.astPath, created.astPath))).toBe(true)
    expect(open.some((row) => row.taskId === created.taskId)).toBe(true)
  })

  it('deletes an edited row after a read that started during the edit landed', async () => {
    const [row] = await indexed('## Tasks\n\n+ [ ] \n')
    harness.holdWrites()
    const editing = harness.tasks.editTask(row!, 'buy milk')
    harness.holdReads()
    void harness.tasks.refresh()
    await harness.landWrite()
    await editing
    await harness.landRead()
    await harness.drain()

    expect(harness.files.files().get(NOTE)).toBe('## Tasks\n\n+ [ ] buy milk\n')
    await harness.tasks.deleteTasks([harness.tasks.get().open![0]!])
    expect(harness.files.files().get(NOTE)).toBe('## Tasks\n')
  })

  it('keeps an edit when the trailing throttled read lands before the index has it', async () => {
    const OTHER = 'notes/other.md'
    const [row] = await indexed('## Tasks\n\n+ [ ] \n')
    harness.editExternally(OTHER, 'one\n')
    await harness.deliverWatcherBatch()
    await harness.clock.advance(1_000)
    harness.editExternally(OTHER, 'two\n')
    await harness.deliverWatcherBatch()

    await harness.clock.advance(1_900)
    await harness.tasks.editTask(row!, 'buy milk')
    expect(harness.tasks.get().open?.[0]?.markdown).toBe('buy milk')

    await harness.clock.advance(100)
    await flushMicrotasks()
    expect(harness.tasks.get().open?.[0]?.markdown).toBe('buy milk')
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
