import type { NoteTasks, TaskRead } from '@reflect/types'
import { sha256HexSync } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import { applyTaskEdits, projectTasks, type TaskEdit, type TaskLocator } from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'
import type { TaskOp } from './task-ops.ts'
import { TaskStore, type TaskWriteResult } from './task-store.ts'

const A = 'notes/a.md'
const B = 'notes/b.md'

function createStore(): TaskStore {
  let next = 0
  return new TaskStore(() => `t${next++}`)
}

/**
 * The tasks of `source` as an index read returns them for the note at `path`.
 */
function noteOf(path: string, source: string, checked: boolean | null = null): NoteTasks {
  return {
    path,
    hash: sha256HexSync(source),
    title: path,
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 1,
    tasks: projectTasks(source)
      .filter((task) => checked === null || task.checked === checked)
      .map(({ astPath, markdown, breadcrumbs, checked }) => {
        return { astPath: [...astPath], markdown, breadcrumbs: [...breadcrumbs], checked }
      }),
  }
}

/**
 * A read of the unchecked tasks of `files` at `seq`.
 */
function openRead(seq: number, files: Record<string, string>): TaskRead {
  const notes = Object.entries(files).map(([path, source]) => noteOf(path, source, false))
  return { seq, notes: notes.filter((note) => note.tasks.length > 0) }
}

/**
 * A read of every task of `files` at `seq`.
 */
function fullRead(seq: number, files: Record<string, string>): TaskRead {
  const notes = Object.entries(files).map(([path, source]) => noteOf(path, source))
  return { seq, notes: notes.filter((note) => note.tasks.length > 0) }
}

function locate(row: OpenTask): TaskLocator {
  const { revision, astPath, markdown, checked } = row
  return { revision, astPath, markdown, checked }
}

/**
 * The result of writing `edits` over `source` at index seq `indexSeq`.
 */
function resultOf(
  source: string,
  edits: readonly TaskEdit[],
  indexSeq: number | null,
): TaskWriteResult {
  const edit = applyTaskEdits(source, sha256HexSync(source), edits)
  return {
    ...edit,
    revision: sha256HexSync(edit.source),
    merged: false,
    indexSeq,
    updatedAt: 9,
  }
}

function labels(rows: readonly OpenTask[] | undefined): string[] | undefined {
  return rows?.map((row) => `${row.taskId}:${row.markdown}`)
}

describe('TaskStore reads', () => {
  it('shows no list until a read of every note lands', () => {
    const store = createStore()
    store.landPaths(fullRead(1, { [A]: '+ [ ] a\n' }), [A])
    expect(store.view()).toEqual({ open: undefined, completed: undefined, struck: [] })

    store.landAll(openRead(2, { [A]: '+ [ ] a\n+ [x] done\n' }), false)
    expect(labels(store.view().open)).toEqual(['t0:a'])
    expect(store.view().completed).toBeUndefined()
  })

  it('lists the checked tasks once a read holds them, most recent note first', () => {
    const store = createStore()
    const files = { [A]: '+ [ ] a\n+ [x] a done\n', [B]: '+ [x] b done\n' }
    const read = fullRead(1, files)
    read.notes[1]!.updatedAt = 5
    store.landAll(read, true)

    expect(labels(store.view().open)).toEqual(['t0:a'])
    expect(labels(store.view().completed)).toEqual(['t2:b done', 't1:a done'])

    store.landAll(openRead(2, files), false)
    expect(store.view().completed).toBeUndefined()
  })

  it('notifies once for a read of several notes, and once for a batch', () => {
    const store = createStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.landAll(openRead(1, { [A]: '+ [ ] a\n', [B]: '+ [ ] b\n' }), false)
    expect(listener).toHaveBeenCalledTimes(1)

    store.batch(() => {
      store.begin(A, [{ kind: 'toggle', taskId: 't0', checked: true }])
      store.begin(B, [{ kind: 'toggle', taskId: 't1', checked: true }])
    })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps the rows and their ids through an equal read', () => {
    const store = createStore()
    store.landAll(openRead(1, { [A]: '+ [ ] a\n+ [ ] b\n' }), false)
    const view = store.view()

    store.landAll(openRead(2, { [A]: '+ [ ] a\n+ [ ] b\n' }), false)
    expect(store.view()).toBe(view)
  })

  it('keeps the id of a task that another edit of its note moved', () => {
    const store = createStore()
    store.landAll(openRead(1, { [A]: '+ [ ] a\n+ [ ] b\n' }), false)

    store.landPaths(fullRead(2, { [A]: '+ [ ] new\n+ [ ] a\n+ [ ] b!\n' }), [A])
    expect(labels(store.view().open)).toEqual(['t2:new', 't0:a', 't3:b!'])
  })

  it('drops the rows of a path that a read reports without a task', () => {
    const store = createStore()
    store.landAll(openRead(1, { [A]: '+ [ ] a\n', [B]: '+ [ ] b\n' }), false)

    store.landPaths(fullRead(2, {}), [A])
    expect(labels(store.view().open)).toEqual(['t1:b'])
    store.landAll(openRead(3, {}), false)
    expect(store.view().open).toEqual([])
  })

  it('keeps the checked tasks of a note that a read of the unchecked tasks omits', () => {
    const store = createStore()
    store.landAll(fullRead(1, { [A]: '+ [ ] a\n+ [x] done\n' }), true)

    store.landAll(openRead(2, {}), false)
    expect(store.find(A, 't0')).toBeUndefined()
    expect(store.find(A, 't1')).toMatchObject({ markdown: 'done' })
  })

  it('drops the checked tasks of a changed note when a read holds only its unchecked tasks', () => {
    const store = createStore()
    store.landAll(fullRead(1, { [A]: '+ [ ] a\n+ [x] done\n' }), true)

    store.landAll(openRead(2, { [A]: '+ [ ] a2\n+ [x] done\n' }), false)
    expect(store.find(A, 't1')).toBeUndefined()
  })

  it('ignores a read of a note from before the index seq the note was learned at', () => {
    const store = createStore()
    store.landAll(openRead(1, { [A]: '+ [ ] a\n', [B]: '+ [ ] b\n' }), false)
    store.landPaths(fullRead(5, { [A]: '+ [ ] a2\n' }), [A, B])

    store.landAll(openRead(4, { [A]: '+ [ ] a\n', [B]: '+ [ ] b\n' }), false)
    expect(labels(store.view().open)).toEqual(['t0:a2'])

    store.landAll(openRead(5, { [A]: '+ [ ] a2\n', [B]: '+ [ ] b3\n' }), false)
    expect(labels(store.view().open)).toEqual(['t0:a2', 't2:b3'])
  })

  it('takes older reads again after the index seqs are forgotten', () => {
    const store = createStore()
    store.landAll(openRead(9, { [A]: '+ [ ] a\n' }), false)
    store.forgetSeqs()

    store.landAll(openRead(1, { [A]: '+ [ ] rebuilt\n' }), false)
    expect(labels(store.view().open)).toEqual(['t0:rebuilt'])
  })
})

describe('TaskStore struck tasks', () => {
  it('lists a struck task while it is checked, until the struck tasks are archived', () => {
    const store = createStore()
    store.landAll(fullRead(1, { [A]: '+ [ ] a\n+ [x] done\n' }), false)
    store.strike(['t0', 't1'])
    expect(labels(store.view().struck)).toEqual(['t1:done'])

    store.begin(A, [{ kind: 'toggle', taskId: 't0', checked: true }])
    expect(labels(store.view().struck)).toEqual(['t0:a', 't1:done'])

    store.archive()
    expect(store.view().struck).toEqual([])
  })

  it('keeps a struck task through a read of the unchecked tasks of the same text', () => {
    const store = createStore()
    const files = { [A]: '+ [ ] a\n+ [x] done\n' }
    store.landAll(fullRead(1, files), false)
    store.strike(['t1'])

    const read = openRead(2, files)
    read.notes[0]!.updatedAt = 9
    expect(store.landAll(read, false)).toEqual([A])
    expect(labels(store.view().struck)).toEqual(['t1:done'])
  })
})

describe('TaskStore writes', () => {
  const source = '+ [ ] a\n+ [ ] b\n'

  function loaded(): { store: TaskStore; a: OpenTask; b: OpenTask } {
    const store = createStore()
    store.landAll(openRead(1, { [A]: source }), false)
    const [a, b] = store.view().open!
    return { store, a: a!, b: b! }
  }

  it('shows the ops of a write until it fails', () => {
    const { store } = loaded()
    const write = store.begin(A, [{ kind: 'toggle', taskId: 't0', checked: true }])
    expect(labels(store.view().open)).toEqual(['t1:b'])

    store.fail(write)
    expect(labels(store.view().open)).toEqual(['t0:a', 't1:b'])
  })

  it('keeps the ops of another write when one write fails', () => {
    const { store } = loaded()
    const first = store.begin(A, [{ kind: 'toBullet', taskId: 't0' }])
    store.begin(A, [{ kind: 'toggle', taskId: 't1', checked: true }])

    store.fail(first)
    expect(labels(store.view().open)).toEqual(['t0:a'])
  })

  it('keeps the text of a failed write in its row until it is taken', () => {
    const { store, a } = loaded()
    store.fail(store.begin(A, [{ kind: 'setMarkdown', taskId: 't0', markdown: 'a!' }]))
    expect(labels(store.view().open)).toEqual(['t0:a!', 't1:b'])

    expect(store.takeText(a)).toEqual({ base: 'a', markdown: 'a!' })
    expect(labels(store.view().open)).toEqual(['t0:a', 't1:b'])
  })

  it('applies the ops over the rows a read lands during the write', () => {
    const { store } = loaded()
    store.begin(A, [{ kind: 'setMarkdown', taskId: 't1', markdown: 'b!' }])

    store.landPaths(fullRead(2, { [A]: '+ [ ] above\n+ [ ] a\n+ [ ] b\n' }), [A])
    expect(labels(store.view().open)).toEqual(['t2:above', 't0:a', 't1:b!'])
  })

  it('replaces the rows of the note with the tasks of the commit and keeps the ids', () => {
    const { store, a } = loaded()
    const ops: TaskOp[] = [{ kind: 'remove', taskId: 't0' }]
    const write = store.begin(A, ops)

    store.landCommit(A, resultOf(source, [{ kind: 'remove', task: locate(a) }], 2), write)
    expect(store.view().open).toMatchObject([
      {
        taskId: 't1',
        markdown: 'b',
        astPath: [0],
        revision: sha256HexSync('+ [ ] b\n'),
        updatedAt: 9,
      },
    ])
  })

  it('gives an inserted task the id of its op', () => {
    const { store, a } = loaded()
    const note = { notePath: A, noteTitle: A, dailyDate: null, isPinned: false, pinnedOrder: null }
    const write = store.begin(A, [
      { kind: 'insert', taskId: 'draft', note, after: 't0', markdown: '', updatedAt: 3 },
    ])
    expect(labels(store.view().open)).toEqual(['t0:a', 't1:b', 'draft:'])

    const edit: TaskEdit = {
      kind: 'insert',
      at: { kind: 'contextEnd', task: locate(a) },
      markdown: '',
    }
    store.landCommit(A, resultOf(source, [edit], 2), write)
    expect(labels(store.view().open)).toEqual(['t0:a', 't1:b', 'draft:'])
    expect(store.find(A, 'draft')).toMatchObject({ astPath: [2] })
  })

  it('shows a pending task of a note that has no row, and lands it under the same id', () => {
    const store = createStore()
    store.landAll(openRead(1, {}), false)
    const note = {
      notePath: B,
      noteTitle: 'B',
      dailyDate: '2026-11-23',
      isPinned: false,
      pinnedOrder: null,
    }
    const write = store.begin(B, [
      { kind: 'insert', taskId: 'draft', note, after: null, markdown: 'x', updatedAt: 3 },
    ])
    expect(store.view().open).toMatchObject([
      { taskId: 'draft', notePath: B, noteTitle: 'B', markdown: 'x' },
    ])

    const edit: TaskEdit = { kind: 'insert', at: { kind: 'tasksSection' }, markdown: 'x' }
    store.landCommit(B, resultOf('', [edit], 2), write)
    expect(store.view().open).toMatchObject([
      { taskId: 'draft', dailyDate: '2026-11-23', breadcrumbs: ['Tasks'], updatedAt: 9 },
    ])
  })

  it('aligns without the moves when the note text is not the output of the edit', () => {
    const { store, a } = loaded()
    const result = resultOf(source, [{ kind: 'remove', task: locate(a) }], 2)
    const merged = projectTasks('+ [ ] theirs\n+ [ ] a\n+ [ ] b\n')

    store.landCommit(A, { ...result, tasks: merged, merged: true }, null)
    expect(labels(store.view().open)).toEqual(['t2:theirs', 't0:a', 't1:b'])
  })

  it('gives an inserted task the id of its op when the note text is not the output of the edit', () => {
    const { store, a } = loaded()
    const note = { notePath: A, noteTitle: A, dailyDate: null, isPinned: false, pinnedOrder: null }
    const write = store.begin(A, [
      { kind: 'insert', taskId: 'draft', note, after: 't0', markdown: 'c', updatedAt: 3 },
    ])
    const edit: TaskEdit = {
      kind: 'insert',
      at: { kind: 'contextEnd', task: locate(a) },
      markdown: 'c',
    }
    const merged = projectTasks('+ [ ] theirs\n+ [ ] a\n+ [ ] b\n+ [ ] c\n')

    store.landCommit(A, { ...resultOf(source, [edit], 2), tasks: merged, merged: true }, write)
    expect(labels(store.view().open)).toEqual(['t2:theirs', 't0:a', 't1:b', 'draft:c'])
  })

  it('ignores a read from before the index seq of a commit', () => {
    const { store, a } = loaded()
    const result = resultOf(source, [{ kind: 'setMarkdown', task: locate(a), markdown: 'a!' }], 4)
    store.landCommit(A, result, null)

    store.landAll(openRead(3, { [A]: source }), false)
    expect(labels(store.view().open)).toEqual(['t0:a!', 't1:b'])
  })

  it('keeps the rows of a read from after the index seq of a commit', () => {
    const { store, a } = loaded()
    const result = resultOf(source, [{ kind: 'setMarkdown', task: locate(a), markdown: 'a!' }], 2)
    store.landPaths(fullRead(3, { [A]: '+ [ ] a!\n+ [ ] b\n+ [ ] later\n' }), [A])

    store.landCommit(A, result, null)
    expect(labels(store.view().open)).toEqual(['t0:a!', 't1:b', 't2:later'])
  })
})
