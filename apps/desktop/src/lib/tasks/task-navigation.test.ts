import { describe, expect, it, vi } from 'vitest'
import { TaskStore, type Task } from '@reflect/core'
import { makeOpenTask } from './open-task-fixture.ts'
import { continueFrom, previousTaskKey } from './task-navigation.ts'

function task(over: Partial<Task> = {}): Task {
  return makeOpenTask({ displayText: 'x', ...over })
}

describe('previousTaskKey', () => {
  const a = task({ notePath: 'a.md', astPath: [1] })
  const b = task({ notePath: 'b.md', astPath: [1] })
  const c = task({ notePath: 'c.md', astPath: [1] })
  const ordered = [a, b, c]

  it('selects the row above a middle row', () => {
    expect(previousTaskKey(ordered, b)).toBe(a.key)
  })

  it('selects the next row when deleting the first (it becomes the new first)', () => {
    expect(previousTaskKey(ordered, a)).toBe(b.key)
  })

  it('returns null for the only row', () => {
    expect(previousTaskKey([a], a)).toBeNull()
  })

  it('returns null when the row is not in the order', () => {
    expect(previousTaskKey(ordered, task({ notePath: 'z.md', astPath: [9] }))).toBeNull()
  })
})

describe('continueFrom', () => {
  const TODAY = '2026-06-15'
  const store = () =>
    new TaskStore({ read: async () => null, write: vi.fn(), failure: vi.fn(), saved: vi.fn() })

  it('adds to today’s daily without a task, or from a Current task', () => {
    expect(continueFrom(store(), undefined, TODAY)).toMatchObject({
      notePath: 'daily/2026-06-15.md',
      dailyDate: TODAY,
    })
    const current = task({ notePath: 'notes/a.md', noteTitle: 'A', dueDate: TODAY })
    expect(continueFrom(store(), current, TODAY)).toMatchObject({ notePath: 'daily/2026-06-15.md' })
  })

  it('adds to the task’s own note when it is undated, and nowhere in the aggregate buckets', () => {
    const undated = task({ notePath: 'notes/p.md', noteTitle: 'P', isPinned: true, pinnedOrder: 4 })
    expect(continueFrom(store(), undated, TODAY)).toMatchObject({
      notePath: 'notes/p.md',
      noteTitle: 'P',
      isPinned: true,
      pinnedOrder: 4,
      breadcrumbs: [],
    })
    const overdue = task({ notePath: 'notes/p.md', dueDate: '2026-06-01' })
    expect(continueFrom(store(), overdue, TODAY)).toBeNull()
  })

  it('continues a task with breadcrumb context right below it, whatever its bucket', () => {
    const grouped = task({
      notePath: 'notes/a.md',
      noteTitle: 'A',
      breadcrumbs: ['Project', 'Phase one'],
      dueDate: '2026-06-01',
    })
    const created = continueFrom(store(), grouped, TODAY)
    expect(created).toMatchObject({
      notePath: 'notes/a.md',
      breadcrumbs: ['Project', 'Phase one'],
      astPath: [...grouped.astPath, Number.MAX_SAFE_INTEGER],
    })
  })
})
