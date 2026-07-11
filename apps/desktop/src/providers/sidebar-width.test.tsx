import { cleanup, render, waitFor } from '@testing-library/react'
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

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--sidebar-width')
  document.documentElement.style.removeProperty('--context-sidebar-width')
  settingsState.sidebarWidth = 260
  settingsState.contextSidebarWidth = 320
  activeSidebarWidthDrags.clear()
})

describe('SidebarWidthEffect', () => {
  it('mirrors the live settings onto the document root', async () => {
    const view = render(<SidebarWidthEffect />)
    await waitFor(() => expect(rootVariable('--sidebar-width')).toBe('260px'))
    expect(rootVariable('--context-sidebar-width')).toBe('320px')

    settingsState.sidebarWidth = 340
    settingsState.contextSidebarWidth = 400
    view.rerender(<SidebarWidthEffect />)

    await waitFor(() => expect(rootVariable('--sidebar-width')).toBe('340px'))
    expect(rootVariable('--context-sidebar-width')).toBe('400px')
  })

  it('leaves a variable with a live drag alone when settings hydrate', async () => {
    const view = render(<SidebarWidthEffect />)
    await waitFor(() => expect(rootVariable('--sidebar-width')).toBe('260px'))

    // A drag is in flight on the workspace rail when the async settings load
    // lands: the dragged variable must not be yanked, the other still updates.
    activeSidebarWidthDrags.add('--sidebar-width')
    document.documentElement.style.setProperty('--sidebar-width', '345px')
    settingsState.sidebarWidth = 300
    settingsState.contextSidebarWidth = 400
    view.rerender(<SidebarWidthEffect />)

    await waitFor(() => expect(rootVariable('--context-sidebar-width')).toBe('400px'))
    expect(rootVariable('--sidebar-width')).toBe('345px')
  })

  it('removes the overrides on unmount so the token defaults apply', async () => {
    const view = render(<SidebarWidthEffect />)
    await waitFor(() => expect(rootVariable('--sidebar-width')).toBe('260px'))

    view.unmount()

    expect(rootVariable('--sidebar-width')).toBe('')
    expect(rootVariable('--context-sidebar-width')).toBe('')
  })
})
