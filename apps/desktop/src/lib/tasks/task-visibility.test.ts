import { describe, expect, it } from 'vitest'
import type { TaskFilters } from '@/lib/tasks/task-filters.ts'
import { makeOpenTask as task } from '@/lib/tasks/open-task-fixture.ts'
import { composeVisibleTaskGroups, visibleGroups } from '@/lib/tasks/task-visibility.ts'

const TODAY = '2026-06-14'

const ALL_ON: TaskFilters = {
  pinned: true,
  current: true,
  overdue: true,
  upcoming: true,
  other: true,
  archived: false,
}

describe('composeVisibleTaskGroups', () => {
  it('groups open tasks into desktop’s buckets', () => {
    const groups = composeVisibleTaskGroups({
      tasks: [
        task({ displayText: 'today', dueDate: TODAY, astPath: [0] }),
        task({ displayText: 'late', dueDate: '2026-06-01', astPath: [10] }),
        task({ displayText: 'later', dueDate: '2026-07-01', astPath: [20] }),
        task({ displayText: 'undated', astPath: [30] }),
      ],
      filters: ALL_ON,
      needle: '',
      today: TODAY,
    })
    expect(groups.map((group) => group.kind)).toEqual(['current', 'overdue', 'upcoming', 'note'])
  })

  it('drops the buckets the filters turn off, honoring pinned vs other notes', () => {
    const groups = composeVisibleTaskGroups({
      tasks: [
        task({ displayText: 'late', dueDate: '2026-06-01' }),
        task({
          displayText: 'pinned note',
          notePath: 'notes/p.md',
          noteTitle: 'P',
          isPinned: true,
        }),
        task({ displayText: 'plain note', notePath: 'notes/q.md', noteTitle: 'Q' }),
      ],
      filters: { ...ALL_ON, overdue: false, other: false },
      needle: '',
      today: TODAY,
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'note', label: 'P' })
  })

  it('filters by the search needle across open and struck rows', () => {
    const groups = composeVisibleTaskGroups({
      tasks: [
        task({ displayText: 'buy milk', astPath: [0] }),
        task({ displayText: 'call mum', astPath: [10] }),
      ],
      filters: ALL_ON,
      needle: 'milk',
      today: TODAY,
    })
    const rows = groups.flatMap((group) => group.tasks)
    expect(rows.map((row) => row.displayText)).toEqual(['buy milk'])
  })

  it('filters by breadcrumb context', () => {
    const groups = composeVisibleTaskGroups({
      tasks: [
        task({ displayText: 'ship', astPath: [0], breadcrumbs: ['StartupToolbox', 'Reflections'] }),
        task({ displayText: 'buy milk', astPath: [10], breadcrumbs: ['Personal'] }),
      ],
      filters: ALL_ON,
      needle: 'startup',
      today: TODAY,
    })
    const rows = groups.flatMap((group) => group.tasks)
    expect(rows.map((row) => row.displayText)).toEqual(['ship'])
  })

  it('filters by source-note title', () => {
    const groups = composeVisibleTaskGroups({
      tasks: [
        task({ displayText: 'ship it', astPath: [0], noteTitle: 'Desktop launch' }),
        task({ displayText: 'buy milk', astPath: [10], noteTitle: 'Home' }),
      ],
      filters: ALL_ON,
      needle: 'desktop',
      today: TODAY,
    })
    const rows = groups.flatMap((group) => group.tasks)
    expect(rows.map((row) => row.displayText)).toEqual(['ship it'])
  })
})

describe('visibleGroups', () => {
  it('keeps every group with every filter on', () => {
    const groups = composeVisibleTaskGroups({
      tasks: [task({ displayText: 'a', dueDate: TODAY })],
      filters: ALL_ON,
      needle: '',
      today: TODAY,
    })
    expect(visibleGroups(groups, ALL_ON)).toEqual(groups)
  })
})
