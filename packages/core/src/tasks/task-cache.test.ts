import { describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../markdown/index.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { makeOpenTask as task } from '../testing/tasks.ts'
import {
  asCompleted,
  asOpen,
  withChecked,
  withEditedTask,
  withoutTasks,
  withRelocatedTasks,
} from './task-cache.ts'

const ctx = { logger: createTestLoggerService() }

const a = task({ astPath: [1], text: 'a' })
const b = task({ astPath: [2], text: 'b' })
const c = task({ astPath: [3], text: 'c' })

function snapshot(
  astPath: number[],
  markdown: string,
  checked = false,
  breadcrumbs: string[] = [],
): TaskSnapshot {
  return { astPath, markdown, breadcrumbs, checked }
}

describe('withoutTasks', () => {
  it('drops every matching row and keeps the rest', () => {
    expect(withoutTasks([a, b, c], [a, c])).toEqual([b])
  })

  it('leaves an undefined (not-loaded) list untouched', () => {
    expect(withoutTasks(undefined, [a])).toBeUndefined()
  })
})

describe('withRelocatedTasks', () => {
  it('moves and removes same-note rows while preserving unrelated rows', () => {
    const moved = task({ notePath: 'a.md', astPath: [0, 2], markdown: 'moved' })
    const removed = task({ notePath: 'a.md', astPath: [0, 4], markdown: 'removed' })
    const unrelated = task({ notePath: 'b.md', astPath: [0, 2], markdown: 'other' })

    expect(
      withRelocatedTasks(ctx, [moved, removed, unrelated], 'a.md', [
        { from: snapshot([0, 2], 'moved'), to: snapshot([0, 3], 'moved') },
        { from: snapshot([0, 4], 'removed'), to: null },
      ]),
    ).toEqual([{ ...moved, astPath: [0, 3] }, unrelated])
  })

  it('returns the same list when every matched task is unchanged', () => {
    const rows = [task({ notePath: 'a.md', astPath: [2], markdown: 'same' })]
    expect(
      withRelocatedTasks(ctx, rows, 'a.md', [
        { from: snapshot([2], 'same'), to: snapshot([2], 'same') },
      ]),
    ).toBe(rows)
  })

  it('refreshes text and due date when the persisted Markdown changed', () => {
    const rows = [task({ notePath: 'a.md', astPath: [2], markdown: 'old' })]
    expect(
      withRelocatedTasks(ctx, rows, 'a.md', [
        { from: snapshot([2], 'old'), to: snapshot([2], 'edited [[2026-07-01]]', true) },
      ]),
    ).toEqual([
      {
        ...rows[0],
        markdown: 'edited [[2026-07-01]]',
        text: 'edited 2026-07-01',
        checked: true,
        dueDate: '2026-07-01',
      },
    ])
  })

  it('follows a row whose indexed path is stale by its content', () => {
    // Indexed before a paragraph was added above: `a` is now at [1], where `b` was.
    const rows = [
      task({ notePath: 'a.md', astPath: [0], markdown: 'a' }),
      task({ notePath: 'a.md', astPath: [1], markdown: 'b' }),
    ]
    expect(
      withRelocatedTasks(ctx, rows, 'a.md', [
        { from: snapshot([1], 'a'), to: snapshot([1], 'a', true) },
        { from: snapshot([2], 'b'), to: snapshot([2], 'b') },
      ]),
    ).toEqual([
      { ...rows[0], astPath: [1], checked: true },
      { ...rows[1], astPath: [2] },
    ])
  })

  it('renders the breadcrumbs the write left the task under', () => {
    const rows = [task({ notePath: 'a.md', astPath: [0, 1], markdown: 'x', breadcrumbs: ['Old'] })]
    expect(
      withRelocatedTasks(ctx, rows, 'a.md', [
        { from: snapshot([0, 1], 'x', false, ['Old']), to: snapshot([1], 'x', false, ['[[New]]']) },
      ]),
    ).toEqual([{ ...rows[0], astPath: [1], breadcrumbs: ['New'] }])
  })

  it('leaves rows the write did not know about alone', () => {
    const rows = [task({ notePath: 'a.md', astPath: [9], markdown: 'new' })]
    expect(
      withRelocatedTasks(ctx, rows, 'a.md', [{ from: snapshot([0], 'other'), to: null }]),
    ).toBe(rows)
    expect(withRelocatedTasks(ctx, rows, 'a.md', [])).toBe(rows)
    expect(
      withRelocatedTasks(ctx, undefined, 'a.md', [{ from: snapshot([9], 'new'), to: null }]),
    ).toBeUndefined()
  })
})

describe('withChecked', () => {
  it('sets the checked state, returning the same row when it already matches', () => {
    expect(withChecked(a, true)).toEqual({ ...a, checked: true })
    expect(withChecked(a, false)).toBe(a)
  })
})

describe('asCompleted', () => {
  it('prepends the tasks as checked, de-duping any already present', () => {
    const existingChecked = withChecked(b, true)
    const result = asCompleted([existingChecked], [a, b])
    expect(result).toEqual([withChecked(a, true), withChecked(b, true)])
  })

  it('is a no-op when the completed list is not loaded', () => {
    expect(asCompleted(undefined, [a])).toBeUndefined()
  })
})

describe('asOpen', () => {
  it('appends the tasks as unchecked, de-duping any already present', () => {
    const checked = withChecked(a, true)
    const result = asOpen([b, checked], [checked])
    expect(result).toEqual([b, a])
  })

  it('materializes an undefined open list with the reopened rows', () => {
    expect(asOpen(undefined, [withChecked(a, true)])).toEqual([a])
  })
})

describe('withEditedTask', () => {
  it('rewrites the matching row’s Markdown and text, leaving others', () => {
    expect(withEditedTask([a, b], b, 'edited')).toEqual([
      a,
      { ...b, markdown: 'edited', text: 'edited' },
    ])
  })

  it('stores plain text (markdown stripped) while markdown keeps the markup', () => {
    const [edited] = withEditedTask([a], a, 'see [[Foo]] now') ?? []
    expect(edited?.markdown).toBe('see [[Foo]] now')
    // `text` drives search + the row label, so it must be the plain rendering.
    expect(edited?.text).toBe('see Foo now')
  })

  it('keeps the row’s due date until the reindex re-derives it', () => {
    const [edited] = withEditedTask([a], a, 'ship [[2026-07-01]]') ?? []
    expect(edited?.dueDate).toBeNull()
  })

  it('leaves an undefined list untouched', () => {
    expect(withEditedTask(undefined, a, 'x')).toBeUndefined()
  })
})
