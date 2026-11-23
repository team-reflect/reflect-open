import { describe, expect, it } from 'vitest'
import { sha256HexSync } from '@reflect/utils'
import { applyTaskEdits, projectTasks, type TaskEdit, type TaskLocator } from '../markdown/index.ts'
import { reconcileNoteTasks, type IdentifiedTask } from './task-reconcile.ts'

/**
 * The tasks of `source`, the `i`th holding the `i`th of `taskIds`.
 */
function identify(source: string, taskIds: readonly string[]): IdentifiedTask[] {
  return projectTasks(source).map((task, i) => ({ ...task, taskId: taskIds[i]! }))
}

/**
 * Hands out `new1`, `new2`, and so on.
 */
function createCounter(): () => string {
  let count = 0
  return () => `new${++count}`
}

function reconcileSources(previous: string, taskIds: readonly string[], next: string): string[] {
  return reconcileNoteTasks(identify(previous, taskIds), projectTasks(next), null, createCounter())
}

describe('reconcileNoteTasks without moves', () => {
  it('keeps the id of a task whose path and content are unchanged', () => {
    expect(reconcileSources('+ [ ] a\n+ [ ] b\n', ['t1', 't2'], '+ [ ] a\n+ [ ] b\n')).toEqual([
      't1',
      't2',
    ])
  })

  it('follows a task with unique content to its new path', () => {
    expect(
      reconcileSources('+ [ ] a\n+ [ ] b\n', ['t1', 't2'], 'Intro\n\n+ [ ] b\n+ [ ] a\n'),
    ).toEqual(['t2', 't1'])
  })

  it('gives a new id to a task whose content changed', () => {
    expect(reconcileSources('+ [ ] a\n+ [ ] b\n', ['t1', 't2'], '+ [ ] a\n+ [x] b\n')).toEqual([
      't1',
      'new1',
    ])
  })

  it('gives new ids to identical tasks that all moved', () => {
    expect(
      reconcileSources(
        '+ [ ] same\n+ [ ] same\n',
        ['t1', 't2'],
        'Intro\n\nMore\n\n+ [ ] same\n+ [ ] same\n',
      ),
    ).toEqual(['new1', 'new2'])
  })

  it('gives a new id to a second copy of a task', () => {
    expect(reconcileSources('+ [ ] a\n', ['t1'], '+ [ ] a\n+ [ ] a\n')).toEqual(['t1', 'new1'])
  })

  it('keeps ids in place when two identical tasks swap', () => {
    expect(
      reconcileSources('+ [ ] same\n+ [ ] same\n', ['t1', 't2'], '+ [ ] same\n+ [ ] same\n'),
    ).toEqual(['t1', 't2'])
  })
})

describe('reconcileNoteTasks with moves', () => {
  function locate(source: string, index: number): TaskLocator {
    return { ...projectTasks(source)[index]!, revision: sha256HexSync(source) }
  }

  function reconcileEdit(
    source: string,
    taskIds: readonly string[],
    edits: readonly TaskEdit[],
  ): string[] {
    const edit = applyTaskEdits(source, null, edits)
    return reconcileNoteTasks(identify(source, taskIds), edit.tasks, edit.moved, createCounter())
  }

  it('follows identical tasks through a removal', () => {
    const source = '+ [ ] same\n+ [ ] same\n+ [ ] same\n'
    expect(
      reconcileEdit(source, ['t1', 't2', 't3'], [{ kind: 'remove', task: locate(source, 1) }]),
    ).toEqual(['t1', 't3'])
  })

  it('keeps the id of a task whose content the edit changed', () => {
    const source = '+ [ ] a\n+ [ ] b\n'
    expect(
      reconcileEdit(
        source,
        ['t1', 't2'],
        [
          { kind: 'setMarkdown', task: locate(source, 1), markdown: 'c' },
          { kind: 'toggle', task: locate(source, 1) },
        ],
      ),
    ).toEqual(['t1', 't2'])
  })

  it('gives a new id to an inserted task, even with the content of a removed one', () => {
    const source = '+ [ ] a\n+ [ ] b\n'
    expect(
      reconcileEdit(
        source,
        ['t1', 't2'],
        [
          { kind: 'remove', task: locate(source, 0) },
          { kind: 'insert', at: { kind: 'documentEnd' }, markdown: 'a' },
        ],
      ),
    ).toEqual(['t2', 'new1'])
  })
})
