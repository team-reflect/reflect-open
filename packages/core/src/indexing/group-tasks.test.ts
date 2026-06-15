import { describe, expect, it } from 'vitest'
import { groupTasks } from './group-tasks'
import type { OpenTask } from './queries'

const TODAY = '2026-06-14'

/** An open-task row with sensible defaults; override only what a case needs. */
function task(overrides: Partial<OpenTask> = {}): OpenTask {
  return {
    notePath: 'notes/n.md',
    markerOffset: 0,
    raw: '[ ] do it',
    text: 'do it',
    noteTitle: 'N',
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...overrides,
  }
}

describe('groupTasks', () => {
  it('buckets daily-note tasks by date relative to today, in display order', () => {
    const groups = groupTasks(
      [
        task({ notePath: 'daily/2026-06-14.md', dailyDate: TODAY, text: 'today' }),
        task({ notePath: 'daily/2026-06-10.md', dailyDate: '2026-06-10', text: 'past' }),
        task({ notePath: 'daily/2026-06-20.md', dailyDate: '2026-06-20', text: 'future' }),
      ],
      TODAY,
    )
    expect(groups.map((group) => group.kind)).toEqual(['current', 'overdue', 'upcoming'])
    expect(groups.map((group) => group.label)).toEqual(['Current', 'Overdue', 'Upcoming'])
    expect(groups.map((group) => group.tasks.map((entry) => entry.text))).toEqual([
      ['today'],
      ['past'],
      ['future'],
    ])
  })

  it('omits empty buckets', () => {
    const groups = groupTasks([task({ dailyDate: TODAY })], TODAY)
    expect(groups.map((group) => group.kind)).toEqual(['current'])
  })

  it('orders overdue oldest-first, then by document position', () => {
    const groups = groupTasks(
      [
        task({ dailyDate: '2026-06-12', markerOffset: 40, text: 'b' }),
        task({ dailyDate: '2026-06-10', markerOffset: 5, text: 'a' }),
        task({ dailyDate: '2026-06-12', markerOffset: 10, text: 'c' }),
      ],
      TODAY,
    )
    expect(groups[0].kind).toBe('overdue')
    expect(groups[0].tasks.map((entry) => entry.text)).toEqual(['a', 'c', 'b'])
  })

  it('groups dateless tasks under their note and keeps document order within', () => {
    const groups = groupTasks(
      [
        task({ notePath: 'notes/p.md', noteTitle: 'Project', markerOffset: 30, text: 'second' }),
        task({ notePath: 'notes/p.md', noteTitle: 'Project', markerOffset: 10, text: 'first' }),
      ],
      TODAY,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'note', label: 'Project', notePath: 'notes/p.md' })
    expect(groups[0].tasks.map((entry) => entry.text)).toEqual(['first', 'second'])
  })

  it('orders note groups pinned-first, then most-recently edited', () => {
    const groups = groupTasks(
      [
        task({ notePath: 'notes/old.md', noteTitle: 'Old', updatedAt: 100 }),
        task({ notePath: 'notes/new.md', noteTitle: 'New', updatedAt: 200 }),
        task({ notePath: 'notes/pin2.md', noteTitle: 'Pin2', isPinned: true, pinnedOrder: 2 }),
        task({ notePath: 'notes/pin1.md', noteTitle: 'Pin1', isPinned: true, pinnedOrder: 1 }),
        task({ notePath: 'notes/pinbare.md', noteTitle: 'PinBare', isPinned: true, pinnedOrder: null }),
      ],
      TODAY,
    )
    expect(groups.map((group) => group.label)).toEqual(['Pin1', 'Pin2', 'PinBare', 'New', 'Old'])
  })

  it('places date buckets before note groups', () => {
    const groups = groupTasks(
      [
        task({ notePath: 'notes/p.md', noteTitle: 'Project' }),
        task({ notePath: 'daily/2026-06-14.md', dailyDate: TODAY }),
      ],
      TODAY,
    )
    expect(groups.map((group) => group.kind)).toEqual(['current', 'note'])
  })

  it('is independent of input order', () => {
    const rows = [
      task({ notePath: 'daily/2026-06-20.md', dailyDate: '2026-06-20', text: 'future' }),
      task({ notePath: 'notes/p.md', noteTitle: 'Project', text: 'note' }),
      task({ notePath: 'daily/2026-06-10.md', dailyDate: '2026-06-10', text: 'past' }),
    ]
    const forward = groupTasks(rows, TODAY).map((group) => group.kind)
    const reversed = groupTasks([...rows].reverse(), TODAY).map((group) => group.kind)
    expect(forward).toEqual(reversed)
    expect(forward).toEqual(['overdue', 'upcoming', 'note'])
  })
})
