import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type OpenTask } from '@reflect/core'
import {
  archiveRecentlyCompleted,
  forgetRecentlyCompleted,
  hasRecentlyCompleted,
  markRecentlyCompleted,
  reconcileRecentlyCompleted,
  resetRecentlyCompleted,
  useRecentlyCompleted,
} from './recently-completed'

function task(over: Partial<OpenTask> = {}): OpenTask {
  return {
    notePath: 'notes/n.md',
    markerOffset: 2,
    raw: '[ ] do it',
    checked: false,
    text: 'do it',
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

beforeEach(() => resetRecentlyCompleted())
afterEach(() => {
  cleanup()
  resetRecentlyCompleted()
})

describe('recently-completed', () => {
  it('keeps session completions showing, as checked', () => {
    const { result } = renderHook(() => useRecentlyCompleted('/g', undefined))
    expect(result.current).toEqual([])

    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', markerOffset: 2 })]))
    expect(result.current).toHaveLength(1)
    expect(result.current[0]!.checked).toBe(true)
    // The marker in raw is flipped to [x] to match disk — these rows outlive the
    // reindex, so a stale [ ] would later fail a reopen/edit/delete write-back.
    expect(result.current[0]!.raw).toBe('[x] do it')
  })

  it('dedupes by task key', () => {
    const { result } = renderHook(() => useRecentlyCompleted('/g', undefined))
    const taskRow = task({ notePath: 'a.md', markerOffset: 2 })
    act(() => markRecentlyCompleted('/g', [taskRow]))
    act(() => markRecentlyCompleted('/g', [taskRow]))
    expect(result.current).toHaveLength(1)
  })

  it('forgets dropped keys and clears on archive', () => {
    const { result } = renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() =>
      markRecentlyCompleted('/g', [
        task({ notePath: 'a.md', markerOffset: 2 }),
        task({ notePath: 'b.md', markerOffset: 2 }),
      ]),
    )
    act(() => forgetRecentlyCompleted('/g', ['a.md:2']))
    expect(result.current.map((row) => row.notePath)).toEqual(['b.md'])

    act(() => archiveRecentlyCompleted('/g'))
    expect(result.current).toEqual([])
  })

  it('drops a struck copy when the index reports the task open again with a newer updatedAt', () => {
    const { result } = renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', markerOffset: 2, updatedAt: 100 })]))
    expect(result.current).toHaveLength(1)

    // The source note was rewritten (checkbox flipped back to [ ]) and reindexed:
    // the live open row supersedes the session's struck shadow.
    act(() =>
      reconcileRecentlyCompleted('/g', [
        task({ notePath: 'a.md', markerOffset: 2, updatedAt: 200 }),
      ]),
    )
    expect(result.current).toEqual([])
  })

  it('keeps the struck copy when the open row is the pre-completion index state', () => {
    const { result } = renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', markerOffset: 2, updatedAt: 100 })]))

    // A refetch racing the completion's reindex restores the row unchanged
    // (same updatedAt) — the shadow must hold or the row flickers back open.
    act(() =>
      reconcileRecentlyCompleted('/g', [
        task({ notePath: 'a.md', markerOffset: 2, updatedAt: 100 }),
      ]),
    )
    expect(result.current).toHaveLength(1)
  })

  it('reconciles only the active graph root, and leaves unrelated struck tasks alone', () => {
    const { result } = renderHook(() => useRecentlyCompleted('/g', undefined))
    act(() =>
      markRecentlyCompleted('/g', [
        task({ notePath: 'a.md', markerOffset: 2, updatedAt: 100 }),
        task({ notePath: 'b.md', markerOffset: 2, updatedAt: 100 }),
      ]),
    )

    act(() =>
      reconcileRecentlyCompleted('/other', [
        task({ notePath: 'a.md', markerOffset: 2, updatedAt: 200 }),
      ]),
    )
    expect(result.current).toHaveLength(2)

    act(() =>
      reconcileRecentlyCompleted('/g', [
        task({ notePath: 'a.md', markerOffset: 2, updatedAt: 200 }),
      ]),
    )
    expect(result.current.map((row) => row.notePath)).toEqual(['b.md'])
  })

  it('useRecentlyCompleted reconciles against the open rows it is given', () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: readonly OpenTask[] | undefined }) => useRecentlyCompleted('/g', open),
      { initialProps: { open: undefined as readonly OpenTask[] | undefined } },
    )
    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', markerOffset: 2, updatedAt: 100 })]))
    expect(result.current).toHaveLength(1)

    // A fresh open read carrying the reopened row (newer updatedAt) sheds the
    // shadow from the view AND prunes the store, so the Archive count and
    // hasRecentlyCompleted agree with what renders.
    rerender({ open: [task({ notePath: 'a.md', markerOffset: 2, updatedAt: 200 })] })
    expect(result.current).toEqual([])
    expect(hasRecentlyCompleted('/g', 'a.md:2')).toBe(false)
  })

  it('excludes a reopened task during the render that sees it, before the store prune', () => {
    // Render-phase capture: each entry is what a render (not an effect) returned,
    // so a superseded shadow surviving into the first fresh-data render would
    // record a 1 here even though a later effect prunes it.
    const lengths: number[] = []
    const { rerender } = renderHook(
      ({ open }: { open: readonly OpenTask[] | undefined }) => {
        const rows = useRecentlyCompleted('/g', open)
        lengths.push(rows.length)
        return rows
      },
      { initialProps: { open: undefined as readonly OpenTask[] | undefined } },
    )
    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', markerOffset: 2, updatedAt: 100 })]))
    const renders = lengths.length

    rerender({ open: [task({ notePath: 'a.md', markerOffset: 2, updatedAt: 200 })] })
    expect(lengths.slice(renders)).not.toContain(1)
    expect(lengths.at(-1)).toBe(0)
  })

  it('is scoped to a graph root — switching graphs yields an empty set', () => {
    const { result, rerender } = renderHook(({ root }) => useRecentlyCompleted(root, undefined), {
      initialProps: { root: '/g' },
    })
    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', markerOffset: 2 })]))
    expect(result.current).toHaveLength(1)

    rerender({ root: '/other' })
    expect(result.current).toEqual([])

    // Completing in the other graph discards the first graph's set entirely.
    act(() => markRecentlyCompleted('/other', [task({ notePath: 'z.md', markerOffset: 2 })]))
    expect(result.current).toHaveLength(1)
    rerender({ root: '/g' })
    expect(result.current).toEqual([])
  })
})
