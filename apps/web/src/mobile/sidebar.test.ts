import { describe, expect, it } from 'vitest'
import { findPinnedMove, selectSidebarRow } from '@/mobile/sidebar.ts'

const TODAY = '2026-11-13'

describe('selectSidebarRow', () => {
  const pinned = new Set(['reflect-v2.md', 'daily/2026-11-13.md'])

  it('selects the pinned note on screen over its tab', () => {
    expect(selectSidebarRow({ kind: 'note', path: 'reflect-v2.md' }, 'all', pinned, TODAY)).toBe(
      'pinned:reflect-v2.md',
    )
  })

  it('selects Chat, or else the tab under the screen', () => {
    expect(selectSidebarRow({ kind: 'chat' }, 'all', pinned, TODAY)).toBe('chat')
    expect(selectSidebarRow({ kind: 'note', path: 'other.md' }, 'tasks', pinned, TODAY)).toBe(
      'tasks',
    )
    expect(selectSidebarRow({ kind: 'settings' }, 'daily', pinned, TODAY)).toBe('daily')
  })
})

describe('findPinnedMove', () => {
  it('finds a move down and a move up', () => {
    expect(findPinnedMove(['a', 'b', 'c', 'd'], ['b', 'c', 'a', 'd'])).toEqual({
      active: 'a',
      over: 'c',
    })
    expect(findPinnedMove(['a', 'b', 'c', 'd'], ['a', 'd', 'b', 'c'])).toEqual({
      active: 'd',
      over: 'b',
    })
  })

  it('finds no move in the same order', () => {
    expect(findPinnedMove(['a', 'b'], ['a', 'b'])).toBeNull()
  })
})
