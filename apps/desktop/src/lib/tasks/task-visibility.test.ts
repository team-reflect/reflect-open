import { describe, expect, it } from 'vitest'
import type { OpenTask } from '@reflect/core'
import type { TaskFilters } from '@/lib/tasks/task-filters'
import { composeVisibleTaskGroups, visibleGroups } from '@/lib/tasks/task-visibility'

const TODAY = '2026-06-14'

const ALL_ON: TaskFilters = {
  pinned: true,
  current: true,
  overdue: true,
  upcoming: true,
  other: true,
  archived: false,
}

function task(overrides: Partial<OpenTask> = {}): OpenTask {
  const text = overrides.text ?? 'do it'
  return {
    notePath: 'notes/n.md',
    markerOffset: 2,
    raw: `[ ] ${text}`,
    checked: false,
    text,
    breadcrumbs: [],
    noteTitle: 'N',
    dueDate: null,
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...overrides,
  }
}

describe('composeVisibleTaskGroups', () => {
  it('returns nothing while the open list is still loading', () => {
    const groups = composeVisibleTaskGroups({
      open: undefined,
      completed: undefined,
      recentlyCompleted: [task()],
      filters: ALL_ON,
      needle: '',
      today: TODAY,
    })
    expect(groups).toEqual([])
  })

  it('groups open tasks into desktop’s buckets', () => {
    const groups = composeVisibleTaskGroups({
      open: [
        task({ text: 'today', dueDate: TODAY, markerOffset: 0 }),
        task({ text: 'late', dueDate: '2026-06-01', markerOffset: 10 }),
        task({ text: 'later', dueDate: '2026-07-01', markerOffset: 20 }),
        task({ text: 'undated', markerOffset: 30 }),
      ],
      completed: undefined,
      recentlyCompleted: [],
      filters: ALL_ON,
      needle: '',
      today: TODAY,
    })
    expect(groups.map((group) => group.kind)).toEqual(['current', 'overdue', 'upcoming', 'note'])
  })

  it('drops the buckets the filters turn off, honoring pinned vs other notes', () => {
    const groups = composeVisibleTaskGroups({
      open: [
        task({ text: 'late', dueDate: '2026-06-01' }),
        task({ text: 'pinned note', notePath: 'notes/p.md', noteTitle: 'P', isPinned: true }),
        task({ text: 'plain note', notePath: 'notes/q.md', noteTitle: 'Q' }),
      ],
      completed: undefined,
      recentlyCompleted: [],
      filters: { ...ALL_ON, overdue: false, other: false },
      needle: '',
      today: TODAY,
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'note', label: 'P' })
  })

  it('keeps this session’s completed tasks struck, replacing their open rows', () => {
    const done = task({ text: 'done', markerOffset: 0 })
    const groups = composeVisibleTaskGroups({
      // A refetch can briefly restore the completed row to the open cache; the
      // struck copy must win or React keys collide.
      open: [done, task({ text: 'still open', markerOffset: 10 })],
      completed: undefined,
      recentlyCompleted: [{ ...done, checked: true, raw: '[x] done' }],
      filters: ALL_ON,
      needle: '',
      today: TODAY,
    })
    const rows = groups.flatMap((group) => group.tasks)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.text === 'done')?.checked).toBe(true)
  })

  it('unions the completed history and the session set when archived is on', () => {
    const sessionDone = task({ text: 'just now', markerOffset: 0, checked: true })
    const historical = task({ text: 'long ago', markerOffset: 10, checked: true })
    const groups = composeVisibleTaskGroups({
      open: [],
      // The session row is also in the history — it must not list twice.
      completed: [historical, sessionDone],
      recentlyCompleted: [sessionDone],
      filters: { ...ALL_ON, archived: true },
      needle: '',
      today: TODAY,
    })
    const rows = groups.flatMap((group) => group.tasks)
    expect(rows.map((row) => row.text).sort()).toEqual(['just now', 'long ago'])
  })

  it('filters by the search needle across open and struck rows', () => {
    const groups = composeVisibleTaskGroups({
      open: [task({ text: 'buy milk', markerOffset: 0 }), task({ text: 'call mum', markerOffset: 10 })],
      completed: undefined,
      recentlyCompleted: [],
      filters: ALL_ON,
      needle: 'milk',
      today: TODAY,
    })
    const rows = groups.flatMap((group) => group.tasks)
    expect(rows.map((row) => row.text)).toEqual(['buy milk'])
  })

  it('filters by breadcrumb context', () => {
    const groups = composeVisibleTaskGroups({
      open: [
        task({ text: 'ship', markerOffset: 0, breadcrumbs: ['StartupToolbox', 'Reflections'] }),
        task({ text: 'buy milk', markerOffset: 10, breadcrumbs: ['Personal'] }),
      ],
      completed: undefined,
      recentlyCompleted: [],
      filters: ALL_ON,
      needle: 'startup',
      today: TODAY,
    })
    const rows = groups.flatMap((group) => group.tasks)
    expect(rows.map((row) => row.text)).toEqual(['ship'])
  })

  it('filters by source-note title', () => {
    const groups = composeVisibleTaskGroups({
      open: [
        task({ text: 'ship it', markerOffset: 0, noteTitle: 'Desktop launch' }),
        task({ text: 'buy milk', markerOffset: 10, noteTitle: 'Home' }),
      ],
      completed: undefined,
      recentlyCompleted: [],
      filters: ALL_ON,
      needle: 'desktop',
      today: TODAY,
    })
    const rows = groups.flatMap((group) => group.tasks)
    expect(rows.map((row) => row.text)).toEqual(['ship it'])
  })
})

describe('visibleGroups', () => {
  it('keeps every group with every filter on', () => {
    const groups = composeVisibleTaskGroups({
      open: [task({ text: 'a', dueDate: TODAY })],
      completed: undefined,
      recentlyCompleted: [],
      filters: ALL_ON,
      needle: '',
      today: TODAY,
    })
    expect(visibleGroups(groups, ALL_ON)).toEqual(groups)
  })
})
