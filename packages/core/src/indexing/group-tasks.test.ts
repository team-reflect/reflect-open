import { describe, expect, it } from 'vitest'
import {
  groupTaskContexts,
  groupTasks,
  taskDateBucket,
  visibleTaskBreadcrumbs,
} from './group-tasks.ts'
import type { Task } from '../tasks/task-store.ts'

const TODAY = '2026-06-14'
const PAST = '2026-06-10'
const FUTURE = '2026-06-20'

/** An open-task row with sensible defaults; override only what a case needs. */
function task(overrides: Partial<Task> = {}): Task {
  return {
    key: `notes/n.md#${JSON.stringify(overrides.astPath ?? [0])}`,
    text: 'do it',
    notePath: 'notes/n.md',
    astPath: [0],
    checked: false,
    displayText: 'do it',
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

describe('visibleTaskBreadcrumbs', () => {
  it('trims empty breadcrumb entries', () => {
    expect(visibleTaskBreadcrumbs(['', ' Project ', '  '])).toEqual(['Project'])
  })

  it('hides common single task headings', () => {
    for (const heading of ['Task', 'Tasks:', 'todo', 'TODOs', 'To Do', "To Do's: "]) {
      expect(visibleTaskBreadcrumbs([heading])).toEqual([])
    }
  })

  it('keeps multi-part breadcrumbs even when one part is common', () => {
    expect(visibleTaskBreadcrumbs(['Tasks', 'Project'])).toEqual(['Tasks', 'Project'])
  })
})

describe('groupTaskContexts', () => {
  it('groups only consecutive tasks with the same breadcrumbs', () => {
    const tasks = [
      task({ astPath: [1], breadcrumbs: ['Project', 'Phase one'] }),
      task({ astPath: [2], breadcrumbs: ['Project', 'Phase one'] }),
      task({ astPath: [3], breadcrumbs: ['Project', 'Phase two'] }),
      task({ astPath: [4], breadcrumbs: ['Project', 'Phase one'] }),
    ]

    const contexts = groupTaskContexts(tasks)
    expect(contexts.map((context) => context.tasks.map((entry) => entry.astPath![0]))).toEqual([
      [1, 2],
      [3],
      [4],
    ])
    expect(contexts.map((context) => context.breadcrumbs)).toEqual([
      ['Project', 'Phase one'],
      ['Project', 'Phase two'],
      ['Project', 'Phase one'],
    ])
  })

  it('labels each context with its visible breadcrumbs', () => {
    const contexts = groupTaskContexts([
      task({ astPath: [1], breadcrumbs: [' Project '] }),
      task({ astPath: [2], breadcrumbs: ['Tasks:'] }),
    ])
    expect(contexts.map((context) => context.visibleBreadcrumbs)).toEqual([['Project'], []])
  })

  it('returns no contexts for no tasks', () => {
    expect(groupTaskContexts([])).toEqual([])
  })
})

describe('taskDateBucket', () => {
  it('classifies one task by the same rules as the grouping', () => {
    // Undated → grouped under its note.
    expect(taskDateBucket(task(), TODAY)).toBe('note')
    // A bare daily-note task (no due date) is Current even when the day is past.
    expect(taskDateBucket(task({ dailyDate: PAST }), TODAY)).toBe('current')
    expect(taskDateBucket(task({ dailyDate: TODAY }), TODAY)).toBe('current')
    expect(taskDateBucket(task({ dailyDate: FUTURE }), TODAY)).toBe('upcoming')
    // Overdue keys off an explicit past due date alone.
    expect(taskDateBucket(task({ dueDate: PAST }), TODAY)).toBe('overdue')
    expect(taskDateBucket(task({ dueDate: FUTURE }), TODAY)).toBe('upcoming')
    // An explicit due date overrides the note's daily date, both directions.
    expect(taskDateBucket(task({ dueDate: FUTURE, dailyDate: PAST }), TODAY)).toBe('upcoming')
  })
})

describe('groupTasks', () => {
  it('treats a bare task in a past daily note as Current, not Overdue (V1 asymmetry)', () => {
    const groups = groupTasks(
      [
        task({ notePath: 'daily/2026-06-10.md', dailyDate: PAST, displayText: 'past' }),
        task({ notePath: 'daily/2026-06-14.md', dailyDate: TODAY, displayText: 'today' }),
        task({ notePath: 'daily/2026-06-20.md', dailyDate: FUTURE, displayText: 'future' }),
      ],
      TODAY,
    )
    // No Overdue bucket: a daily-note task with no explicit due date is current.
    expect(groups.map((group) => group.kind)).toEqual(['current', 'upcoming'])
    expect(groups[0]!.tasks.map((entry) => entry.displayText)).toEqual(['past', 'today'])
    expect(groups[1]!.tasks.map((entry) => entry.displayText)).toEqual(['future'])
  })

  it('marks a task with an explicit past due date as Overdue', () => {
    const groups = groupTasks(
      [task({ notePath: 'notes/p.md', noteTitle: 'P', dueDate: PAST, displayText: 'late' })],
      TODAY,
    )
    expect(groups.map((group) => group.kind)).toEqual(['overdue'])
    expect(groups[0]!.tasks.map((entry) => entry.displayText)).toEqual(['late'])
  })

  it('lets the explicit due date override the note daily date, both directions', () => {
    const groups = groupTasks(
      [
        // future due date inside a PAST daily note → Upcoming
        task({
          notePath: 'daily/2026-06-10.md',
          dailyDate: PAST,
          dueDate: FUTURE,
          displayText: 'pushed-out',
        }),
        // past due date inside a FUTURE daily note → Overdue
        task({
          notePath: 'daily/2026-06-20.md',
          dailyDate: FUTURE,
          dueDate: PAST,
          displayText: 'pulled-in',
        }),
      ],
      TODAY,
    )
    const byKind = Object.fromEntries(
      groups.map((group) => [group.kind, group.tasks.map((entry) => entry.displayText)]),
    )
    expect(byKind['overdue']).toEqual(['pulled-in'])
    expect(byKind['upcoming']).toEqual(['pushed-out'])
    expect(byKind['current']).toBeUndefined()
  })

  it('puts a due-dated task from a regular note into a date bucket, not a note group', () => {
    const groups = groupTasks(
      [task({ notePath: 'notes/p.md', noteTitle: 'P', dueDate: FUTURE, displayText: 'scheduled' })],
      TODAY,
    )
    expect(groups.map((group) => group.kind)).toEqual(['upcoming'])
  })

  it('labels a note group with the display form of a `//` title', () => {
    const groups = groupTasks(
      [task({ notePath: 'notes/tim.md', noteTitle: 'Tim MacCaw // Dad', displayText: 'call' })],
      TODAY,
    )
    expect(groups.map((group) => group.label)).toEqual(['Tim MacCaw'])
  })

  it('groups an undated task (no due date, regular note) under its note', () => {
    const groups = groupTasks(
      [
        task({
          notePath: 'notes/p.md',
          noteTitle: 'Project',
          astPath: [30],
          displayText: 'second',
        }),
        task({ notePath: 'notes/p.md', noteTitle: 'Project', astPath: [10], displayText: 'first' }),
      ],
      TODAY,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'note', label: 'Project', notePath: 'notes/p.md' })
    expect(groups[0]!.tasks.map((entry) => entry.displayText)).toEqual(['first', 'second'])
  })

  it('orders the display Current → Overdue → Upcoming → note groups', () => {
    const groups = groupTasks(
      [
        task({ notePath: 'notes/p.md', noteTitle: 'P', displayText: 'undated' }),
        task({ notePath: 'daily/2026-06-14.md', dailyDate: TODAY, displayText: 'cur' }),
        task({ notePath: 'notes/d.md', dueDate: PAST, displayText: 'over' }),
        task({ notePath: 'daily/2026-06-20.md', dailyDate: FUTURE, displayText: 'up' }),
      ],
      TODAY,
    )
    expect(groups.map((group) => group.kind)).toEqual(['current', 'overdue', 'upcoming', 'note'])
  })

  it('orders a date bucket by effective date, then document position', () => {
    const groups = groupTasks(
      [
        task({ notePath: 'notes/a.md', dueDate: '2026-06-08', astPath: [9], displayText: 'b' }),
        task({ notePath: 'notes/a.md', dueDate: '2026-06-05', astPath: [2], displayText: 'a' }),
        task({ notePath: 'notes/a.md', dueDate: '2026-06-08', astPath: [1], displayText: 'c' }),
      ],
      TODAY,
    )
    expect(groups[0]!.kind).toBe('overdue')
    expect(groups[0]!.tasks.map((entry) => entry.displayText)).toEqual(['a', 'c', 'b'])
  })

  it('orders note groups pinned-first, then most-recently edited', () => {
    const groups = groupTasks(
      [
        task({ notePath: 'notes/old.md', noteTitle: 'Old', updatedAt: 100 }),
        task({ notePath: 'notes/new.md', noteTitle: 'New', updatedAt: 200 }),
        task({ notePath: 'notes/pin2.md', noteTitle: 'Pin2', isPinned: true, pinnedOrder: 2 }),
        task({ notePath: 'notes/pin1.md', noteTitle: 'Pin1', isPinned: true, pinnedOrder: 1 }),
        task({
          notePath: 'notes/pinbare.md',
          noteTitle: 'PinBare',
          isPinned: true,
          pinnedOrder: null,
        }),
      ],
      TODAY,
    )
    expect(groups.map((group) => group.label)).toEqual(['Pin1', 'Pin2', 'PinBare', 'New', 'Old'])
  })

  it('is independent of input order', () => {
    const rows = [
      task({ notePath: 'notes/d1.md', dueDate: FUTURE, displayText: 'future' }),
      task({ notePath: 'notes/p.md', noteTitle: 'P', displayText: 'note' }),
      task({ notePath: 'notes/d2.md', dueDate: PAST, displayText: 'past' }),
    ]
    const forward = groupTasks(rows, TODAY).map((group) => group.kind)
    const reversed = groupTasks([...rows].reverse(), TODAY).map((group) => group.kind)
    expect(forward).toEqual(reversed)
    expect(forward).toEqual(['overdue', 'upcoming', 'note'])
  })
})
