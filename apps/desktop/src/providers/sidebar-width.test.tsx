import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@reflect/core'
import { activeSidebarWidthDrags } from '@/hooks/use-sidebar-resize.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { SidebarWidthEffect } from './sidebar-width.tsx'

const WIDTHS = { sidebarWidth: 260, contextSidebarWidth: 320 }

async function render(settings: Partial<Settings> = WIDTHS) {
  return await renderInApp(<SidebarWidthEffect />, { settings })
}

function rootVariable(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

afterEach(async () => {
  document.documentElement.style.removeProperty('--sidebar-width')
  document.documentElement.style.removeProperty('--context-sidebar-width')
  activeSidebarWidthDrags.clear()
  await page.viewport(900, 600)
})

describe('SidebarWidthEffect', () => {
  it('mirrors the live settings onto the document root', async () => {
    await page.viewport(1600, 600)
    const { core } = await render()
    expect(rootVariable('--sidebar-width')).toBe('260px')
    expect(rootVariable('--context-sidebar-width')).toBe('320px')

    core.settings.update({ sidebarWidth: 340, contextSidebarWidth: 400 })

    await vi.waitFor(() => expect(rootVariable('--sidebar-width')).toBe('340px'))
    expect(rootVariable('--context-sidebar-width')).toBe('400px')
  })

  it('scales the rails to the viewport and restores them when it widens', async () => {
    await page.viewport(1600, 600)
    await render({ sidebarWidth: 480, contextSidebarWidth: 480 })
    expect(rootVariable('--sidebar-width')).toBe('480px')
    expect(rootVariable('--context-sidebar-width')).toBe('480px')

    // 1024px leaves a 664px rail budget after the note pane's 360px reserve:
    // both preferences scale down proportionally (480/960 of 664 each)...
    await page.viewport(1024, 600)
    await vi.waitFor(() => expect(rootVariable('--sidebar-width')).toBe('332px'))
    expect(rootVariable('--context-sidebar-width')).toBe('332px')

    // ...and come back in full when the window has room again.
    await page.viewport(1600, 600)
    await vi.waitFor(() => expect(rootVariable('--sidebar-width')).toBe('480px'))
    expect(rootVariable('--context-sidebar-width')).toBe('480px')
  })

  it('leaves a variable with a live drag alone when settings hydrate', async () => {
    await page.viewport(1600, 600)
    const { core } = await render()
    expect(rootVariable('--sidebar-width')).toBe('260px')

    // A drag is in flight on the workspace rail when the async settings load
    // lands: the dragged variable must not be yanked, the other still updates.
    activeSidebarWidthDrags.add('--sidebar-width')
    document.documentElement.style.setProperty('--sidebar-width', '345px')
    core.settings.update({ sidebarWidth: 300, contextSidebarWidth: 400 })

    await vi.waitFor(() => expect(rootVariable('--context-sidebar-width')).toBe('400px'))
    expect(rootVariable('--sidebar-width')).toBe('345px')
  })

  it('removes the overrides on unmount so the token defaults apply', async () => {
    const view = await render()
    expect(rootVariable('--sidebar-width')).toBe('260px')

    await view.unmount()

    expect(rootVariable('--sidebar-width')).toBe('')
    expect(rootVariable('--context-sidebar-width')).toBe('')
  })
})
