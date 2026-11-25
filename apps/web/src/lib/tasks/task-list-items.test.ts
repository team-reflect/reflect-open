import { describe, expect, it } from 'vitest'
import { composeVisibleTaskGroups } from '@reflect/core'
import { makeOpenTask as task } from '@reflect/core/testing'
import { flattenTaskGroups } from './task-list-items.ts'

function flatten(tasks: ReturnType<typeof task>[]): ReturnType<typeof flattenTaskGroups> {
  const groups = composeVisibleTaskGroups({
    open: tasks,
    completed: undefined,
    struck: [],
    filters: {
      pinned: true,
      current: true,
      overdue: true,
      upcoming: true,
      other: true,
      archived: false,
    },
    needle: '',
    today: '2026-06-14',
  })
  return flattenTaskGroups(groups)
}

describe('flattenTaskGroups', () => {
  it('puts each group header before its breadcrumbs and tasks', () => {
    const { items, headerIndexes, indexByTaskId } = flatten([
      task({ text: 'a', notePath: 'notes/a.md', noteTitle: 'A', astPath: [0] }),
      task({
        text: 'b',
        notePath: 'notes/a.md',
        noteTitle: 'A',
        astPath: [1],
        breadcrumbs: ['Plan'],
      }),
      task({ text: 'c', notePath: 'notes/c.md', noteTitle: 'C', astPath: [0] }),
    ])

    expect(items.map((item) => item.kind)).toEqual([
      'header',
      'task',
      'breadcrumbs',
      'task',
      'header',
      'task',
    ])
    expect(headerIndexes).toEqual([0, 4])
    expect([...indexByTaskId.values()]).toEqual([1, 3, 5])
    expect(items.map((item) => item.kind === 'task' && item.groupEnd)).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
    ])
  })

  it('gives every item a different key', () => {
    const { items } = flatten([
      task({
        text: 'today',
        dailyDate: '2026-06-14',
        notePath: 'daily/2026-06-14.md',
        astPath: [0],
      }),
      task({ text: 'a', notePath: 'notes/a.md', astPath: [0], breadcrumbs: ['Plan'] }),
      task({ text: 'b', notePath: 'notes/a.md', astPath: [1], breadcrumbs: ['Later'] }),
    ])

    expect(new Set(items.map((item) => item.key)).size).toBe(items.length)
  })
})
