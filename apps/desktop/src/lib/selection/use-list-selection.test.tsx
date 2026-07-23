import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useListSelection } from './use-list-selection'

const KEYS = ['a', 'b', 'c', 'd']
const noMods = { metaKey: false, ctrlKey: false, shiftKey: false }

describe('useListSelection', () => {
  it('selects exclusively, toggles with ⌘, and ranges with shift', () => {
    const { result } = renderHook(() => useListSelection(KEYS))

    act(() => result.current.clickSelect('b', noMods))
    expect([...result.current.selected]).toEqual(['b'])

    act(() => result.current.clickSelect('d', { ...noMods, metaKey: true }))
    expect([...result.current.selected].sort()).toEqual(['b', 'd'])
    act(() => result.current.clickSelect('b', { ...noMods, metaKey: true }))
    expect([...result.current.selected]).toEqual(['d'])

    // Shift extends from the anchor (the last ⌘-click left it at 'b').
    act(() => result.current.clickSelect('a', noMods)) // anchor 'a'
    act(() => result.current.clickSelect('c', { ...noMods, shiftKey: true }))
    expect([...result.current.selected]).toEqual(['a', 'b', 'c'])
  })

  it('moves and extends with the arrows, clamping at the ends', () => {
    const { result } = renderHook(() => useListSelection(KEYS))

    act(() => result.current.clickSelect('b', noMods))
    act(() => result.current.move(1))
    expect([...result.current.selected]).toEqual(['c'])

    act(() => result.current.extend(1))
    expect([...result.current.selected]).toEqual(['c', 'd'])
    act(() => result.current.extend(1)) // already at the bottom
    expect([...result.current.selected]).toEqual(['c', 'd'])
  })

  it('selects all, clears, and tracks the active pivot', () => {
    const { result } = renderHook(() => useListSelection(KEYS))

    act(() => result.current.selectAll())
    expect(result.current.selectedCount).toBe(4)

    act(() => result.current.clear())
    expect(result.current.selectedCount).toBe(0)
    expect(result.current.activeKey()).toBeNull()

    act(() => result.current.clickSelect('c', noMods))
    expect(result.current.activeKey()).toBe('c')
  })

  it('programmatically selects visible keys in render order', () => {
    const { result } = renderHook(() => useListSelection(KEYS))

    act(() => result.current.select(['d', 'missing', 'b']))
    expect([...result.current.selected]).toEqual(['b', 'd'])
    expect(result.current.activeKey()).toBe('d')

    act(() => result.current.select([]))
    expect(result.current.selectedCount).toBe(0)
    expect(result.current.activeKey()).toBeNull()
  })

  it('prunes keys that leave the visible order', () => {
    const { result, rerender } = renderHook(({ keys }) => useListSelection(keys), {
      initialProps: { keys: KEYS },
    })

    act(() => result.current.selectAll())
    rerender({ keys: ['a', 'c'] })
    expect([...result.current.selected]).toEqual(['a', 'c'])

    rerender({ keys: ['a'] })
    expect(result.current.isSoleSelected('a')).toBe(true)
  })
})
