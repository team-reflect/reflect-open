import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSidebarWidthDrags } from '@/hooks/use-sidebar-resize'
import { SidebarResizeHandle } from './sidebar-resize-handle'

const settingsState = vi.hoisted(() => ({
  settings: { sidebarWidth: 260, contextSidebarWidth: 320 },
  updateSettings: vi.fn(),
}))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => settingsState,
}))

function rootVariable(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

function firePointer(element: Element, type: string, init: PointerEventInit): void {
  element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }))
}

function fireKey(element: Element, key: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/**
 * Renders the handle inside a rail sized like the app's `<aside>`: the drag
 * rebases on the rail's rendered width, so the wrapper has to carry the
 * persisted setting.
 */
async function renderHandle(panel: 'workspace' | 'context'): Promise<HTMLElement> {
  const width =
    panel === 'workspace'
      ? settingsState.settings.sidebarWidth
      : settingsState.settings.contextSidebarWidth
  await render(
    <div style={{ position: 'relative', width: `${width}px` }}>
      <SidebarResizeHandle panel={panel} />
    </div>,
  )
  return page.getByRole('separator').element() as HTMLElement
}

/** Mocks the handle's aside as rendered at the given width. */
function mockRenderedRail(handle: HTMLElement, width: number): void {
  const aside = handle.parentElement
  if (aside === null) {
    throw new Error('handle parent missing')
  }
  vi.spyOn(aside, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, 800))
}

// The drag math budgets against the real viewport width, so every test runs on
// the desktop-sized window these assertions are written for.
beforeEach(async () => {
  await page.viewport(1024, 800)
})

afterEach(async () => {
  await page.viewport(900, 600)
  const style = document.documentElement.style
  for (const property of [
    '--sidebar-width',
    '--context-sidebar-width',
    'cursor',
    'user-select',
    '-webkit-user-select',
  ]) {
    style.removeProperty(property)
  }
  settingsState.settings = { sidebarWidth: 260, contextSidebarWidth: 320 }
  settingsState.updateSettings.mockReset()
  activeSidebarWidthDrags.clear()
})

describe('SidebarResizeHandle', () => {
  it('drags the workspace sidebar wider and commits once on release', async () => {
    const handle = await renderHandle('workspace')

    firePointer(handle, 'pointerdown', { pointerId: 7, button: 0, clientX: 300 })
    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 380 })
    expect(rootVariable('cursor')).toBe('col-resize')
    expect(rootVariable('--sidebar-width')).toBe('340px')
    // The width variable is written imperatively; the attribute follows the
    // re-render.
    await expect.poll(() => handle.getAttribute('aria-valuenow')).toBe('340')
    expect(settingsState.updateSettings).not.toHaveBeenCalled()

    firePointer(handle, 'pointerup', { pointerId: 7, clientX: 380 })
    expect(settingsState.updateSettings).toHaveBeenCalledTimes(1)
    expect(settingsState.updateSettings).toHaveBeenCalledWith({ sidebarWidth: 340 })
    expect(rootVariable('--sidebar-width')).toBe('340px')
    expect(rootVariable('cursor')).toBe('')
  })

  it('clamps a drag past the range to its bounds', async () => {
    const handle = await renderHandle('workspace')

    firePointer(handle, 'pointerdown', { pointerId: 7, button: 0, clientX: 300 })
    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 1200 })
    expect(rootVariable('--sidebar-width')).toBe('480px')

    firePointer(handle, 'pointermove', { pointerId: 7, clientX: -1200 })
    firePointer(handle, 'pointerup', { pointerId: 7, clientX: -1200 })
    expect(settingsState.updateSettings).toHaveBeenCalledWith({ sidebarWidth: 200 })
  })

  it('widens the context panel when dragged leftward', async () => {
    const handle = await renderHandle('context')

    firePointer(handle, 'pointerdown', { pointerId: 3, button: 0, clientX: 700 })
    firePointer(handle, 'pointermove', { pointerId: 3, clientX: 640 })
    expect(rootVariable('--context-sidebar-width')).toBe('380px')

    firePointer(handle, 'pointerup', { pointerId: 3, clientX: 640 })
    expect(settingsState.updateSettings).toHaveBeenCalledWith({ contextSidebarWidth: 380 })
  })

  it('ignores secondary-button presses and foreign pointer ids', async () => {
    const handle = await renderHandle('workspace')

    firePointer(handle, 'pointerdown', { pointerId: 7, button: 2, clientX: 300 })
    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 380 })
    expect(rootVariable('--sidebar-width')).toBe('')

    firePointer(handle, 'pointerdown', { pointerId: 7, button: 0, clientX: 300 })
    firePointer(handle, 'pointermove', { pointerId: 8, clientX: 380 })
    expect(rootVariable('--sidebar-width')).toBe('')
  })

  it('rebases the drag on the rendered width when the rail is capped narrower', async () => {
    const handle = await renderHandle('workspace')
    settingsState.settings.sidebarWidth = 480
    // A narrow window: the viewport renders the 480px setting at 400px.
    mockRenderedRail(handle, 400)

    firePointer(handle, 'pointerdown', { pointerId: 7, button: 0, clientX: 400 })
    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 420 })
    expect(rootVariable('--sidebar-width')).toBe('420px')

    firePointer(handle, 'pointerup', { pointerId: 7, clientX: 420 })
    expect(settingsState.updateSettings).toHaveBeenCalledWith({ sidebarWidth: 420 })
  })

  it('never clamps the first move below the rendered width', async () => {
    // A 700px viewport budgets only 340px for the rail, but proportional
    // flooring can render it at 400px: the cap must stop growth, not yank the
    // rail to 340px on the first activated move.
    await page.viewport(700, 800)
    const handle = await renderHandle('workspace')
    mockRenderedRail(handle, 400)

    firePointer(handle, 'pointerdown', { pointerId: 7, button: 0, clientX: 400 })
    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 450 })
    expect(rootVariable('--sidebar-width')).toBe('400px')

    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 340 })
    firePointer(handle, 'pointerup', { pointerId: 7, clientX: 340 })
    expect(settingsState.updateSettings).toHaveBeenCalledWith({ sidebarWidth: 340 })
  })

  it('keeps aria-valuenow in step with viewport scaling', async () => {
    settingsState.settings = { sidebarWidth: 480, contextSidebarWidth: 480 }
    const handle = await renderHandle('workspace')
    // At 1024px the 480px preferences scale to 332px each.
    expect(handle.getAttribute('aria-valuenow')).toBe('332')

    await page.viewport(1600, 800)
    await expect.poll(() => handle.getAttribute('aria-valuenow')).toBe('480')
  })

  it('a bare click commits nothing and never suppresses the width effect', async () => {
    const handle = await renderHandle('workspace')
    settingsState.settings.sidebarWidth = 480
    mockRenderedRail(handle, 400)

    // No movement past the activation threshold: this is a click, and it must
    // not persist the capped 400px over the stored 480px preference — nor
    // register a suppression that would block a mid-press settings hydration.
    firePointer(handle, 'pointerdown', { pointerId: 7, button: 0, clientX: 400 })
    expect(activeSidebarWidthDrags.size).toBe(0)
    expect(rootVariable('cursor')).toBe('')
    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 401 })
    firePointer(handle, 'pointerup', { pointerId: 7, clientX: 401 })

    expect(settingsState.updateSettings).not.toHaveBeenCalled()
    expect(rootVariable('--sidebar-width')).toBe('')
  })

  it('a drag that returns to its starting width commits nothing', async () => {
    const handle = await renderHandle('workspace')

    firePointer(handle, 'pointerdown', { pointerId: 7, button: 0, clientX: 300 })
    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 380 })
    expect(rootVariable('--sidebar-width')).toBe('340px')

    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 300 })
    firePointer(handle, 'pointerup', { pointerId: 7, clientX: 300 })

    expect(settingsState.updateSettings).not.toHaveBeenCalled()
    expect(rootVariable('--sidebar-width')).toBe('260px')
    expect(rootVariable('cursor')).toBe('')
  })

  it('steps the keyboard resize from the rendered width on a capped rail', async () => {
    const handle = await renderHandle('workspace')
    settingsState.settings.sidebarWidth = 480
    mockRenderedRail(handle, 400)

    fireKey(handle, 'ArrowRight')
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ sidebarWidth: 416 })
  })

  it('a keystroke into a wall commits nothing', async () => {
    settingsState.settings.sidebarWidth = 480
    const handle = await renderHandle('workspace')

    // Already at the range maximum: nothing moves, so nothing persists.
    fireKey(handle, 'ArrowRight')
    expect(settingsState.updateSettings).not.toHaveBeenCalled()
  })

  it('keeps the drag chrome while another rail still drags', async () => {
    await render(
      <>
        <SidebarResizeHandle panel="workspace" />
        <SidebarResizeHandle panel="context" />
      </>,
    )
    const [workspace, context] = page.getByRole('separator').elements()
    if (!workspace || !context) {
      throw new Error('handles missing')
    }

    firePointer(workspace, 'pointerdown', { pointerId: 1, button: 0, clientX: 300 })
    firePointer(workspace, 'pointermove', { pointerId: 1, clientX: 340 })
    firePointer(context, 'pointerdown', { pointerId: 2, button: 0, clientX: 700 })
    firePointer(context, 'pointermove', { pointerId: 2, clientX: 660 })
    firePointer(workspace, 'pointerup', { pointerId: 1, clientX: 340 })

    expect(rootVariable('cursor')).toBe('col-resize')

    firePointer(context, 'pointerup', { pointerId: 2, clientX: 660 })
    expect(rootVariable('cursor')).toBe('')
  })

  it('reverts an unmount-interrupted drag to the persisted width', async () => {
    const handle = await renderHandle('workspace')

    firePointer(handle, 'pointerdown', { pointerId: 7, button: 0, clientX: 300 })
    firePointer(handle, 'pointermove', { pointerId: 7, clientX: 380 })
    expect(rootVariable('--sidebar-width')).toBe('340px')

    await cleanup()

    expect(settingsState.updateSettings).not.toHaveBeenCalled()
    expect(rootVariable('--sidebar-width')).toBe('260px')
    expect(rootVariable('cursor')).toBe('')
  })

  it('resets to the default width on double-click', async () => {
    settingsState.settings.sidebarWidth = 333
    const handle = await renderHandle('workspace')

    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))

    expect(settingsState.updateSettings).toHaveBeenCalledWith({ sidebarWidth: 260 })
    expect(rootVariable('--sidebar-width')).toBe('260px')
  })

  it('moves the divider with arrow keys, following separator semantics', async () => {
    const workspaceHandle = await renderHandle('workspace')

    fireKey(workspaceHandle, 'ArrowRight')
    expect(settingsState.updateSettings).toHaveBeenCalledWith({ sidebarWidth: 276 })

    // The mocked provider never re-renders, so each keystroke steps from the
    // same 260px base.
    fireKey(workspaceHandle, 'ArrowLeft')
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ sidebarWidth: 244 })

    await cleanup()
    const contextHandle = await renderHandle('context')

    // For the right panel, moving the divider left widens it.
    fireKey(contextHandle, 'ArrowLeft')
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ contextSidebarWidth: 336 })
  })

  it('jumps to the rail minimum and maximum with Home and End', async () => {
    const workspaceHandle = await renderHandle('workspace')

    fireKey(workspaceHandle, 'Home')
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ sidebarWidth: 200 })

    fireKey(workspaceHandle, 'End')
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ sidebarWidth: 480 })

    await cleanup()
    const contextHandle = await renderHandle('context')

    // Home is the rail's minimum on both sides — value semantics, per the
    // WAI window-splitter pattern, not divider-position semantics.
    fireKey(contextHandle, 'Home')
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ contextSidebarWidth: 240 })

    fireKey(contextHandle, 'End')
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ contextSidebarWidth: 480 })
  })

  it('exposes the clamp range and controlled panel through the separator attributes', async () => {
    const handle = await renderHandle('workspace')

    expect(handle.getAttribute('aria-orientation')).toBe('vertical')
    expect(handle.getAttribute('aria-controls')).toBe('workspace-sidebar')
    expect(handle.getAttribute('aria-valuemin')).toBe('200')
    expect(handle.getAttribute('aria-valuemax')).toBe('480')
    expect(handle.getAttribute('aria-valuenow')).toBe('260')
  })
})
