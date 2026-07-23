import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useTaskSelection } from './use-task-selection'

const KEYS = ['a', 'b', 'c', 'd']
const noMods = { metaKey: false, ctrlKey: false, shiftKey: false }

describe('useTaskSelection', () => {
  it('selects exclusively, toggles with ⌘, and ranges with shift', () => {
    const { result } = renderHook(() => useTaskSelection(KEYS))

    act(() => result.current.clickSelect('b', noMods))
    expect([...result.current.selected]).toEqual(['b'])

    // ⌘-click adds; a second ⌘-click on the same key removes it.
    act(() => result.current.clickSelect('d', { ...noMods, metaKey: true }))
    expect([...result.current.selected].sort()).toEqual(['b', 'd'])
    act(() => result.current.clickSelect('b', { ...noMods, metaKey: true }))
    expect([...result.current.selected]).toEqual(['d'])

    // Shift extends from the anchor (the last ⌘-click, 'b' removed → anchor 'b').
    act(() => result.current.clickSelect('a', noMods)) // anchor 'a'
    act(() => result.current.clickSelect('c', { ...noMods, shiftKey: true }))
    expect([...result.current.selected]).toEqual(['a', 'b', 'c'])
  })

  it('moves a single selection and extends a range with the arrows', () => {
    const { result } = renderHook(() => useTaskSelection(KEYS))

    act(() => result.current.clickSelect('b', noMods))
    act(() => result.current.move(1))
    expect([...result.current.selected]).toEqual(['c'])
    act(() => result.current.move(-1))
    expect([...result.current.selected]).toEqual(['b'])

    // Shift+arrow grows the range from the anchor ('b') without losing it.
    act(() => result.current.extend(1))
    expect([...result.current.selected]).toEqual(['b', 'c'])
    act(() => result.current.extend(1))
    expect([...result.current.selected]).toEqual(['b', 'c', 'd'])
    // Reversing past the anchor flips the range to the other side.
    act(() => result.current.extend(-1))
    expect([...result.current.selected]).toEqual(['b', 'c'])
  })

  it('clamps movement at the ends and selects all / clears', () => {
    const { result } = renderHook(() => useTaskSelection(KEYS))

    act(() => result.current.clickSelect('a', noMods))
    act(() => result.current.move(-1)) // already at the top
    expect([...result.current.selected]).toEqual(['a'])

    act(() => result.current.selectAll())
    expect([...result.current.selected]).toEqual(KEYS)
    expect(result.current.selectedCount).toBe(4)

    act(() => result.current.clear())
    expect(result.current.selectedCount).toBe(0)
    // With nothing selected, ↓ starts at the first row.
    act(() => result.current.move(1))
    expect([...result.current.selected]).toEqual(['a'])
  })

  it('tracks the active pivot (cursor, else anchor) for Return-to-add', () => {
    const { result, rerender } = renderHook(({ keys }) => useTaskSelection(keys), {
      initialProps: { keys: KEYS },
    })
    expect(result.current.activeKey()).toBeNull()

    act(() => result.current.clickSelect('b', noMods))
    expect(result.current.activeKey()).toBe('b')

    // A ⌘-click across notes moves the pivot to the row just touched, not render order.
    act(() => result.current.clickSelect('d', { ...noMods, metaKey: true }))
    expect(result.current.activeKey()).toBe('d')

    // Arrow movement carries the pivot; clearing drops it.
    act(() => result.current.move(-1))
    expect(result.current.activeKey()).toBe('c')
    act(() => result.current.clear())
    expect(result.current.activeKey()).toBeNull()

    // A pruned pivot (its row left the order) falls back to null.
    act(() => result.current.clickSelect('d', noMods))
    rerender({ keys: ['a', 'b'] })
    expect(result.current.activeKey()).toBeNull()
  })

  it('prunes keys that leave the visible order', () => {
    const { result, rerender } = renderHook(({ keys }) => useTaskSelection(keys), {
      initialProps: { keys: KEYS },
    })

    act(() => result.current.selectAll())
    expect(result.current.selectedCount).toBe(4)

    // 'b' and 'd' completed / filtered away — the selection drops them.
    rerender({ keys: ['a', 'c'] })
    expect([...result.current.selected]).toEqual(['a', 'c'])
    expect(result.current.isSoleSelected('a')).toBe(false)

    rerender({ keys: ['a'] })
    expect(result.current.isSoleSelected('a')).toBe(true)
  })
})
