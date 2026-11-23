import { describe, expect, it } from 'vitest'
import {
  applyTaskEdits,
  projectTasks,
  renderTaskSnapshot,
  type TaskEdit,
  type TaskLocator,
} from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'
import { applyTaskOp, type TaskOp } from './task-ops.ts'

const NOTE = {
  notePath: 'notes/a.md',
  noteTitle: 'A',
  dailyDate: null,
  isPinned: false,
  pinnedOrder: null,
}

/**
 * The rows of `source`, with the ids `t0`, `t1`, ... in document order.
 */
function rowsOf(source: string): OpenTask[] {
  return projectTasks(source).map((task, i) => ({
    ...NOTE,
    ...renderTaskSnapshot(task),
    taskId: `t${i}`,
    revision: 'r1',
    updatedAt: 0,
  }))
}

function locate(rows: readonly OpenTask[], taskId: string): TaskLocator {
  const { revision, astPath, markdown, checked } = rows.find((row) => row.taskId === taskId)!
  return { revision, astPath, markdown, checked }
}

/**
 * The edit of the note text that `op` stands for.
 */
function toEdit(rows: readonly OpenTask[], op: TaskOp): TaskEdit {
  if (op.kind !== 'insert') {
    return { ...op, task: locate(rows, op.taskId) }
  }
  return {
    kind: 'insert',
    at:
      op.after === null
        ? { kind: 'tasksSection' }
        : { kind: 'contextEnd', task: locate(rows, op.after) },
    markdown: op.markdown,
  }
}

function contentOf(tasks: ReadonlyArray<Pick<OpenTask, 'markdown' | 'checked' | 'dueDate'>>) {
  return tasks.map(({ markdown, checked, dueDate }) => ({ markdown, checked, dueDate }))
}

const insert = { kind: 'insert', taskId: 'new', note: NOTE, updatedAt: 5 } as const

describe('applyTaskOp', () => {
  const nested = '## Tasks\n\n+ [ ] a\n  + [ ] a1\n  + [x] a2\n+ [ ] b\n\npara\n\n+ [ ] c\n'

  it.each<[string, string, TaskOp]>([
    ['toggle', nested, { kind: 'toggle', taskId: 't1', checked: true }],
    ['toggle back', nested, { kind: 'toggle', taskId: 't2', checked: false }],
    [
      'setMarkdown',
      nested,
      { kind: 'setMarkdown', taskId: 't0', markdown: ' due [[2026-06-20]] ', typed: true },
    ],
    ['remove with nested tasks', nested, { kind: 'remove', taskId: 't0' }],
    ['toBullet with nested tasks', nested, { kind: 'toBullet', taskId: 't0' }],
    ['insert at the end of a nested list', nested, { ...insert, after: 't1', markdown: 'x' }],
    ['insert at the end of a root list', nested, { ...insert, after: 't0', markdown: 'x' }],
    ['insert after the last list', nested, { ...insert, after: 't4', markdown: 'x' }],
    [
      'insert into the Tasks section',
      '# T\n\n## Tasks\n\n+ [ ] a\n\n## Later\n\n+ [ ] z\n',
      { ...insert, after: null, markdown: 'x' },
    ],
    ['insert into a note with no task', '# T\n', { ...insert, after: null, markdown: 'x' }],
  ])('leaves the tasks the written note has: %s', (_name, source, op) => {
    const rows = rowsOf(source)
    const written = applyTaskEdits(source, 'r1', [toEdit(rows, op)]).source

    expect(contentOf(applyTaskOp(rows, op))).toEqual(contentOf(projectTasks(written)))
  })

  it('keeps the id and the address of a changed row', () => {
    const rows = rowsOf(nested)
    const [edited] = applyTaskOp(rows, {
      kind: 'setMarkdown',
      taskId: 't0',
      markdown: 'a!',
      typed: true,
    })

    expect(edited).toEqual({ ...rows[0], markdown: 'a!', text: 'a!' })
  })

  it('gives a new row the id of the op and the context of its anchor', () => {
    const rows = rowsOf(nested)
    const next = applyTaskOp(rows, { ...insert, after: 't1', markdown: 'x' })

    expect(next.map((row) => row.taskId)).toEqual(['t0', 't1', 't2', 'new', 't3', 't4'])
    expect(next[3]).toMatchObject({ ...NOTE, breadcrumbs: rows[1]!.breadcrumbs, updatedAt: 5 })
  })

  it('starts the rows of a note that has none', () => {
    expect(applyTaskOp([], { ...insert, after: null, markdown: 'x' })).toEqual([
      {
        ...NOTE,
        taskId: 'new',
        revision: '',
        astPath: [],
        markdown: 'x',
        text: 'x',
        dueDate: null,
        checked: false,
        breadcrumbs: ['Tasks'],
        updatedAt: 5,
      },
    ])
  })

  it('changes nothing for an id that names no row', () => {
    const rows = rowsOf(nested)

    expect(applyTaskOp(rows, { kind: 'remove', taskId: 'gone' })).toEqual(rows)
    expect(applyTaskOp(rows, { ...insert, after: 'gone', markdown: 'x' }).at(-1)?.taskId).toBe(
      'new',
    )
  })
})
