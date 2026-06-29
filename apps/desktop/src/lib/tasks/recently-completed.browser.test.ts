import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { act } from '@/test-utils/act'
import { type OpenTask } from '@reflect/core'
import {
  archiveRecentlyCompleted,
  forgetRecentlyCompleted,
  markRecentlyCompleted,
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
afterEach(() => resetRecentlyCompleted())

describe('recently-completed', () => {
  it('keeps session completions showing, as checked', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g'))
    expect(result.current).toEqual([])

    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', markerOffset: 2 })]))
    expect(result.current).toHaveLength(1)
    expect(result.current[0]!.checked).toBe(true)
    // The marker in raw is flipped to [x] to match disk: these rows outlive the
    // reindex, so a stale [ ] would later fail a reopen/edit/delete write-back.
    expect(result.current[0]!.raw).toBe('[x] do it')
  })

  it('dedupes by task key', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g'))
    const t = task({ notePath: 'a.md', markerOffset: 2 })
    act(() => markRecentlyCompleted('/g', [t]))
    act(() => markRecentlyCompleted('/g', [t]))
    expect(result.current).toHaveLength(1)
  })

  it('forgets dropped keys and clears on archive', async () => {
    const { result } = await renderHook(() => useRecentlyCompleted('/g'))
    act(() =>
      markRecentlyCompleted('/g', [
        task({ notePath: 'a.md', markerOffset: 2 }),
        task({ notePath: 'b.md', markerOffset: 2 }),
      ]),
    )
    act(() => forgetRecentlyCompleted('/g', ['a.md:2']))
    expect(result.current.map((t) => t.notePath)).toEqual(['b.md'])

    act(() => archiveRecentlyCompleted('/g'))
    expect(result.current).toEqual([])
  })

  it('is scoped to a graph root: switching graphs yields an empty set', async () => {
    const { result, rerender } = await renderHook(({ root }: { root: string } = { root: '/g' }) => useRecentlyCompleted(root), {
      initialProps: { root: '/g' },
    })
    act(() => markRecentlyCompleted('/g', [task({ notePath: 'a.md', markerOffset: 2 })]))
    expect(result.current).toHaveLength(1)

    await rerender({ root: '/other' })
    expect(result.current).toEqual([])

    // Completing in the other graph discards the first graph's set entirely.
    act(() => markRecentlyCompleted('/other', [task({ notePath: 'z.md', markerOffset: 2 })]))
    expect(result.current).toHaveLength(1)
    await rerender({ root: '/g' })
    expect(result.current).toEqual([])
  })
})
