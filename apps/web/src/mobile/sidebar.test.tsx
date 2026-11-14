import { describe, expect, it } from 'vitest'
import { createTestCoreServices } from '@reflect/core/testing'
import { selectSidebarRow, sidebarVisible, useSyncChatSection } from '@/mobile/sidebar.ts'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'

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

  it("selects Chat, or else the row of the entry's section", () => {
    expect(selectSidebarRow({ kind: 'chat' }, 'all', pinned, TODAY)).toBe('chat')
    expect(selectSidebarRow({ kind: 'note', path: 'other.md' }, 'tasks', pinned, TODAY)).toBe(
      'tasks',
    )
    expect(selectSidebarRow({ kind: 'settings', page: 'main' }, 'daily', pinned, TODAY)).toBe(
      'daily',
    )
    expect(selectSidebarRow({ kind: 'note', path: 'other.md' }, 'chat', pinned, TODAY)).toBe('chat')
  })
})

describe('useSyncChatSection', () => {
  it('puts Chat in its own section only while there is a sidebar', async () => {
    const view = await renderHookInApp(() => useSyncChatSection(), {
      core: createTestCoreServices({ database: createWasmTestDatabaseService() }),
    })
    const { navigation } = view.appServices
    navigation.navigate({ kind: 'chat' })
    expect(navigation.get().section).toBe('all')

    sidebarVisible.set(false)
    try {
      await view.rerender()
      navigation.navigate({ kind: 'tasks' })
      navigation.navigate({ kind: 'chat' })
      expect(navigation.get().section).toBe('chat')
    } finally {
      sidebarVisible.set(null)
    }
  })
})
