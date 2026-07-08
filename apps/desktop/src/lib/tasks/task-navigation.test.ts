import { describe, expect, it } from 'vitest'
import { type OpenTask } from '@reflect/core'
import { insertTargetForTask, previousTaskKey } from './task-navigation'
import { taskKey } from './task-identity'

function task(over: Partial<OpenTask> = {}): OpenTask {
  return {
    notePath: 'notes/n.md',
    markerOffset: 2,
    raw: '[ ] x',
    checked: false,
    text: 'x',
    breadcrumbs: [],
    noteTitle: 'N',
    dueDate: null,
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...over,
  }
}

describe('previousTaskKey', () => {
  const a = task({ notePath: 'a.md', markerOffset: 1 })
  const b = task({ notePath: 'b.md', markerOffset: 1 })
  const c = task({ notePath: 'c.md', markerOffset: 1 })
  const ordered = [a, b, c]

  it('selects the row above a middle row', () => {
    expect(previousTaskKey(ordered, b)).toBe(taskKey(a))
  })

  it('selects the next row when deleting the first (it becomes the new first)', () => {
    expect(previousTaskKey(ordered, a)).toBe(taskKey(b))
  })

  it('returns null for the only row', () => {
    expect(previousTaskKey([a], a)).toBeNull()
  })

  it('returns null when the row is not in the order', () => {
    expect(previousTaskKey(ordered, task({ notePath: 'z.md', markerOffset: 9 }))).toBeNull()
  })
})

describe('insertTargetForTask', () => {
  it('carries the task’s note context, dropping the marker fields', () => {
    const t = task({
      notePath: 'notes/p.md',
      noteTitle: 'P',
      dailyDate: '2026-06-15',
      isPinned: true,
      pinnedOrder: 4,
    })
    expect(insertTargetForTask(t)).toEqual({
      notePath: 'notes/p.md',
      noteTitle: 'P',
      dailyDate: '2026-06-15',
      isPinned: true,
      pinnedOrder: 4,
    })
  })
})
