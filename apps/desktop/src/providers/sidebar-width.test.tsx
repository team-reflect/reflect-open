import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeListHeightDrags, activeSidebarWidthDrags } from '@/hooks/use-sidebar-resize'
import { SidebarWidthEffect } from './sidebar-width'

const settingsState = vi.hoisted(() => ({
  sidebarWidth: 260,
  contextSidebarWidth: 320,
  previewPanelWidth: 380,
  annotationListHeight: 180,
}))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: settingsState }),
}))

function rootVariable(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

afterEach(async () => {
  document.documentElement.style.removeProperty('--sidebar-width')
  document.documentElement.style.removeProperty('--context-sidebar-width')
  document.documentElement.style.removeProperty('--preview-panel-width')
  document.documentElement.style.removeProperty('--annotation-list-height')
  settingsState.sidebarWidth = 260
  settingsState.contextSidebarWidth = 320
  settingsState.previewPanelWidth = 380
  settingsState.annotationListHeight = 180
  activeSidebarWidthDrags.clear()
  activeListHeightDrags.clear()
  await page.viewport(900, 600)
})

describe('SidebarWidthEffect', () => {
  it('mirrors the live settings onto the document root', async () => {
    await page.viewport(1600, 600)
    const view = await render(<SidebarWidthEffect />)
    expect(rootVariable('--sidebar-width')).toBe('260px')
    expect(rootVariable('--context-sidebar-width')).toBe('320px')
    expect(rootVariable('--preview-panel-width')).toBe('380px')
    expect(rootVariable('--annotation-list-height')).toBe('180px')

    settingsState.sidebarWidth = 340
    settingsState.contextSidebarWidth = 400
    settingsState.previewPanelWidth = 500
    settingsState.annotationListHeight = 300
    await view.rerender(<SidebarWidthEffect />)

    expect(rootVariable('--sidebar-width')).toBe('340px')
    expect(rootVariable('--context-sidebar-width')).toBe('400px')
    expect(rootVariable('--preview-panel-width')).toBe('500px')
    expect(rootVariable('--annotation-list-height')).toBe('300px')
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
    // lands: the dragged variables must not be yanked, the other still updates.
    activeSidebarWidthDrags.add('--sidebar-width')
    activeSidebarWidthDrags.add('--preview-panel-width')
    activeListHeightDrags.add('--annotation-list-height')
    document.documentElement.style.setProperty('--sidebar-width', '345px')
    document.documentElement.style.setProperty('--preview-panel-width', '400px')
    document.documentElement.style.setProperty('--annotation-list-height', '240px')
    settingsState.sidebarWidth = 300
    settingsState.contextSidebarWidth = 400
    await view.rerender(<SidebarWidthEffect />)

    expect(rootVariable('--context-sidebar-width')).toBe('400px')
    expect(rootVariable('--sidebar-width')).toBe('345px')
    expect(rootVariable('--preview-panel-width')).toBe('400px')
    expect(rootVariable('--annotation-list-height')).toBe('240px')
  })

  it('removes the overrides on unmount so the token defaults apply', async () => {
    const view = await render(<SidebarWidthEffect />)
    expect(rootVariable('--sidebar-width')).toBe('260px')

    await view.unmount()

    expect(rootVariable('--sidebar-width')).toBe('')
    expect(rootVariable('--context-sidebar-width')).toBe('')
    expect(rootVariable('--preview-panel-width')).toBe('')
    expect(rootVariable('--annotation-list-height')).toBe('')
  })
})
