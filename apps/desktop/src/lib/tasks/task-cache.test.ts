import { describe, expect, it } from 'vitest'
import { makeOpenTask as task } from './open-task-fixture'
import {
  asCompleted,
  asOpen,
  taskRawWithContent,
  withCheckedMarker,
  withEditedTask,
  withRelocatedTaskMarkers,
  withoutTasks,
} from './task-cache'

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

describe('withRelocatedTaskMarkers', () => {
  it('moves and removes same-note rows while preserving unrelated rows', () => {
    const moved = task({ notePath: 'a.md', markerOffset: 20, raw: '[ ] moved' })
    const removed = task({ notePath: 'a.md', markerOffset: 40, raw: '[ ] removed' })
    const unrelated = task({ notePath: 'b.md', markerOffset: 20, raw: '[ ] other' })

    expect(
      withRelocatedTaskMarkers([moved, removed, unrelated], 'a.md', [
        {
          from: 20,
          fromRaw: '[ ] moved',
          marker: { markerOffset: 36, raw: '[ ] moved' },
        },
        { from: 40, fromRaw: '[ ] removed', marker: null },
      ]),
    ).toEqual([{ ...moved, markerOffset: 36 }, unrelated])
  })

  it('returns the same list when every matched marker is unchanged', () => {
    const rows = [task({ notePath: 'a.md', markerOffset: 20, raw: '[ ] same' })]
    expect(
      withRelocatedTaskMarkers(rows, 'a.md', [
        {
          from: 20,
          fromRaw: '[ ] same',
          marker: { markerOffset: 20, raw: '[ ] same' },
        },
      ]),
    ).toBe(rows)
  })

  it('does not mistake an optimistically edited anchor for another source row', () => {
    const editedAnchor = task({
      notePath: 'a.md',
      markerOffset: 2,
      raw: '[ ] duplicate',
    })
    const rows = [editedAnchor]

    expect(
      withRelocatedTaskMarkers(rows, 'a.md', [
        {
          from: 2,
          fromRaw: '[ ] original',
          marker: { markerOffset: 2, raw: '[ ] duplicate' },
        },
        {
          from: 40,
          fromRaw: '[ ] duplicate',
          marker: { markerOffset: 56, raw: '[ ] duplicate' },
        },
      ]),
    ).toBe(rows)
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

  it('preserves a CRLF raw line’s carriage return', () => {
    expect(taskRawWithContent(task({ raw: '[ ] old\r' }), 'edited')).toBe('[ ] edited\r')
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
