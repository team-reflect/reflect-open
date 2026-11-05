import { describe, expect, it } from 'vitest'
import { getTaskKey, type TaskGroup } from '@reflect/core'
import { makeOpenTask } from '@reflect/core/testing'
import { flattenTaskGroups } from './task-list-items.ts'

const today = makeOpenTask({ notePath: 'daily/2026-06-14.md', astPath: [0], text: 'today' })
const first = makeOpenTask({
  notePath: 'notes/p.md',
  astPath: [1, 0],
  text: 'first',
  breadcrumbs: ['Launch'],
})
const second = makeOpenTask({
  notePath: 'notes/p.md',
  astPath: [1, 1],
  text: 'second',
  breadcrumbs: ['Launch'],
})
const loose = makeOpenTask({ notePath: 'notes/p.md', astPath: [2], text: 'loose' })

const groups: TaskGroup[] = [
  { kind: 'current', label: 'Current', notePath: null, tasks: [today] },
  { kind: 'note', label: 'Project', notePath: 'notes/p.md', tasks: [first, second, loose] },
]

describe('flattenTaskGroups', () => {
  it('lists each header, then its breadcrumbs and tasks', () => {
    const { items } = flattenTaskGroups(groups)

    expect(items.map((item) => item.kind)).toEqual([
      'header',
      'task',
      'header',
      'breadcrumbs',
      'task',
      'task',
      'task',
    ])
    expect(items[3]).toMatchObject({
      labels: ['Launch'],
      taskKeys: [getTaskKey(first), getTaskKey(second)],
    })
  })

  it('shows the source note only in date buckets', () => {
    const { items } = flattenTaskGroups(groups)

    const showSource = items.flatMap((item) => (item.kind === 'task' ? [item.showSource] : []))
    expect(showSource).toEqual([true, false, false, false])
  })

  it('marks the last task of each group', () => {
    const { items } = flattenTaskGroups(groups)

    const ends = items.flatMap((item) => (item.kind === 'task' ? [item.groupEnd] : []))
    expect(ends).toEqual([true, false, false, true])
  })

  it('indexes headers and tasks', () => {
    const { items, headerIndexes, indexByTaskKey } = flattenTaskGroups(groups)

    expect(headerIndexes).toEqual([0, 2])
    expect(indexByTaskKey.get(getTaskKey(loose))).toBe(6)
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length)
  })
})
