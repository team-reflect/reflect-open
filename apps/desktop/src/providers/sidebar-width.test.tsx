import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeSidebarWidthDrags } from '@/hooks/use-sidebar-resize'
import { SidebarWidthEffect } from './sidebar-width'

const settingsState = vi.hoisted(() => ({ sidebarWidth: 260, contextSidebarWidth: 320 }))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: settingsState }),
}))

function rootVariable(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

afterEach(async () => {
  document.documentElement.style.removeProperty('--sidebar-width')
  document.documentElement.style.removeProperty('--context-sidebar-width')
  settingsState.sidebarWidth = 260
  settingsState.contextSidebarWidth = 320
  activeSidebarWidthDrags.clear()
  await page.viewport(900, 600)
})

describe('SidebarWidthEffect', () => {
  it('mirrors the live settings onto the document root', async () => {
    await page.viewport(1600, 600)
    const view = await render(<SidebarWidthEffect />)
    expect(rootVariable('--sidebar-width')).toBe('260px')
    expect(rootVariable('--context-sidebar-width')).toBe('320px')

    settingsState.sidebarWidth = 340
    settingsState.contextSidebarWidth = 400
    await view.rerender(<SidebarWidthEffect />)

    expect(rootVariable('--sidebar-width')).toBe('340px')
    expect(rootVariable('--context-sidebar-width')).toBe('400px')
  })

  it('scales the rails to the viewport and restores them when it widens', async () => {
    await page.viewport(1600, 600)
    settingsState.sidebarWidth = 480
    settingsState.contextSidebarWidth = 480
    await render(<SidebarWidthEffect />)
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
    const view = await render(<SidebarWidthEffect />)
    expect(rootVariable('--sidebar-width')).toBe('260px')

    // A drag is in flight on the workspace rail when the async settings load
    // lands: the dragged variable must not be yanked, the other still updates.
    activeSidebarWidthDrags.add('--sidebar-width')
    document.documentElement.style.setProperty('--sidebar-width', '345px')
    settingsState.sidebarWidth = 300
    settingsState.contextSidebarWidth = 400
    await view.rerender(<SidebarWidthEffect />)

    expect(rootVariable('--context-sidebar-width')).toBe('400px')
    expect(rootVariable('--sidebar-width')).toBe('345px')
  })

  it('removes the overrides on unmount so the token defaults apply', async () => {
    const view = await render(<SidebarWidthEffect />)
    expect(rootVariable('--sidebar-width')).toBe('260px')

    await view.unmount()

    expect(rootVariable('--sidebar-width')).toBe('')
    expect(rootVariable('--context-sidebar-width')).toBe('')
  })
})
