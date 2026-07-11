import { act, cleanup, render, waitFor } from '@testing-library/react'
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

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    value: width,
    configurable: true,
    writable: true,
  })
}

function resizeViewport(width: number): void {
  act(() => {
    setViewport(width)
    window.dispatchEvent(new Event('resize'))
  })
}

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--sidebar-width')
  document.documentElement.style.removeProperty('--context-sidebar-width')
  settingsState.sidebarWidth = 260
  settingsState.contextSidebarWidth = 320
  activeSidebarWidthDrags.clear()
  setViewport(1024)
})

describe('SidebarWidthEffect', () => {
  it('mirrors the live settings onto the document root', async () => {
    setViewport(1600)
    const view = render(<SidebarWidthEffect />)
    await waitFor(() => expect(rootVariable('--sidebar-width')).toBe('260px'))
    expect(rootVariable('--context-sidebar-width')).toBe('320px')

    settingsState.sidebarWidth = 340
    settingsState.contextSidebarWidth = 400
    view.rerender(<SidebarWidthEffect />)

    await waitFor(() => expect(rootVariable('--sidebar-width')).toBe('340px'))
    expect(rootVariable('--context-sidebar-width')).toBe('400px')
  })

  it('scales the rails to the viewport and restores them when it widens', async () => {
    setViewport(1600)
    settingsState.sidebarWidth = 480
    settingsState.contextSidebarWidth = 480
    render(<SidebarWidthEffect />)
    await waitFor(() => expect(rootVariable('--sidebar-width')).toBe('480px'))
    expect(rootVariable('--context-sidebar-width')).toBe('480px')

    // 1024px leaves a 664px rail budget after the note pane's 360px reserve:
    // both preferences scale down proportionally (480/960 of 664 each)...
    resizeViewport(1024)
    await waitFor(() => expect(rootVariable('--sidebar-width')).toBe('332px'))
    expect(rootVariable('--context-sidebar-width')).toBe('332px')

    // ...and come back in full when the window has room again.
    resizeViewport(1600)
    await waitFor(() => expect(rootVariable('--sidebar-width')).toBe('480px'))
    expect(rootVariable('--context-sidebar-width')).toBe('480px')
  })

  it('leaves a variable with a live drag alone when settings hydrate', async () => {
    setViewport(1600)
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
