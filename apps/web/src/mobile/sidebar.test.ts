import { describe, expect, it } from 'vitest'
import { selectSidebarRow } from '@/mobile/sidebar.ts'

const TODAY = '2026-11-13'

describe('selectSidebarRow', () => {
  const pinned = new Set(['reflect-v2.md', 'daily/2026-11-13.md'])

  it('selects the pinned note on screen over its tab', () => {
    expect(selectSidebarRow({ kind: 'note', path: 'reflect-v2.md' }, 'all', pinned, TODAY)).toBe(
      'pinned:reflect-v2.md',
    )
  })

  it("selects today's daily note when it is pinned", () => {
    expect(selectSidebarRow({ kind: 'today' }, 'daily', pinned, TODAY)).toBe(
      'pinned:daily/2026-11-13.md',
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
