import { type OpenTask } from '@reflect/core'
import { describe, expect, it } from 'vitest'
import {
  asCompleted,
  asOpen,
  taskRawWithContent,
  withCheckedMarker,
  withEditedTask,
  withoutTasks,
} from './task-cache'

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

const a = task({ markerOffset: 1, text: 'a' })
const b = task({ markerOffset: 2, text: 'b' })
const c = task({ markerOffset: 3, text: 'c' })

describe('withoutTasks', () => {
  it('drops every matching row and keeps the rest', () => {
    expect(withoutTasks([a, b, c], [a, c])).toEqual([b])
  })

  it('leaves an undefined (not-loaded) list untouched', () => {
    expect(withoutTasks(undefined, [a])).toBeUndefined()
  })
})

describe('withCheckedMarker', () => {
  it('flips the marker in raw to match the new checked state', () => {
    expect(withCheckedMarker(a, true)).toEqual({ ...a, checked: true, raw: '[x] a' })
    expect(withCheckedMarker({ ...a, checked: true, raw: '[x] a' }, false)).toEqual({
      ...a,
      checked: false,
      raw: '[ ] a',
    })
  })
})

describe('asCompleted', () => {
  it('prepends the tasks as checked (raw flipped to [x]), de-duping any already present', () => {
    const existingChecked = withCheckedMarker(b, true)
    const result = asCompleted([existingChecked], [a, b])
    expect(result).toEqual([withCheckedMarker(a, true), withCheckedMarker(b, true)])
  })

  it('is a no-op when the completed list is not loaded', () => {
    expect(asCompleted(undefined, [a])).toBeUndefined()
  })
})

describe('asOpen', () => {
  it('appends the tasks as unchecked, de-duping any already present', () => {
    const checked = withCheckedMarker(a, true)
    const result = asOpen([b, checked], [checked])
    expect(result).toEqual([b, a])
  })

  it('materializes an undefined open list with the reopened rows', () => {
    expect(asOpen(undefined, [withCheckedMarker(a, true)])).toEqual([a])
  })
})

describe('taskRawWithContent', () => {
  it('keeps an open marker', () => {
    expect(taskRawWithContent(task({ raw: '[ ] old' }), 'buy oat milk')).toBe('[ ] buy oat milk')
  })

  it('keeps a checked marker', () => {
    expect(taskRawWithContent(task({ checked: true, raw: '[x] old' }), 'really done')).toBe(
      '[x] really done',
    )
  })

  it('preserves the indexed line’s exact marker casing (GitHub `[X]`)', () => {
    expect(taskRawWithContent(task({ checked: true, raw: '[X] old' }), 'edited')).toBe('[X] edited')
  })

  it('clears to a bare marker when content is empty', () => {
    expect(taskRawWithContent(task({ raw: '[ ] old' }), '')).toBe('[ ]')
  })
})

describe('withEditedTask', () => {
  it('rewrites the matching row’s text and raw, leaving others', () => {
    expect(withEditedTask([a, b], b, 'edited')).toEqual([a, { ...b, raw: '[ ] edited', text: 'edited' }])
  })

  it('stores plain text (markdown stripped) while raw keeps the markup', () => {
    const [edited] = withEditedTask([a], a, 'see [[Foo]] now') ?? []
    expect(edited?.raw).toBe('[ ] see [[Foo]] now')
    // `text` drives search + the row label, so it must be the plain rendering.
    expect(edited?.text).not.toContain('[[')
    expect(edited?.text).toContain('Foo')
  })

  it('leaves an undefined list untouched', () => {
    expect(withEditedTask(undefined, a, 'x')).toBeUndefined()
  })
})
