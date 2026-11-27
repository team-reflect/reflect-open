import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { createBrowserNativeMenuHost } from './browser-native-menu.ts'

async function rightClickAt(x: number, y: number): Promise<void> {
  const target = document.body.appendChild(document.createElement('div'))
  target.style.cssText = `position: fixed; left: ${x}px; top: ${y}px; width: 1px; height: 1px`
  await page.elementLocator(target).click({ button: 'right' })
  target.remove()
}

describe('createBrowserNativeMenuHost', () => {
  it('opens the menu at the right-click point and runs the picked action', async () => {
    const host = createBrowserNativeMenuHost()
    const action = vi.fn()
    await rightClickAt(120, 80)

    await host.popup([{ kind: 'command', id: 'unpin', text: 'Unpin Note', action }])
    const item = page.getByRole('menuitem', { name: 'Unpin Note' })
    await expect.element(item).toBeVisible()
    await vi.waitFor(() => {
      const menu = page.getByRole('menu').element().getBoundingClientRect()
      expect([Math.round(menu.left), Math.round(menu.top)]).toEqual([120, 80])
    })

    await item.click()
    expect(action).toHaveBeenCalledWith('unpin')
    await expectLocatorToHaveCount(page.getByRole('menu'), 0)
  })

  it('shows separators, disabled, checked and submenu items, navigable by keyboard', async () => {
    const host = createBrowserNativeMenuHost()
    const complete = vi.fn()
    const today = vi.fn()
    await rightClickAt(40, 40)

    await host.popup([
      { kind: 'command', id: 'complete', text: 'Complete', action: complete },
      { kind: 'predefined', item: 'Separator' },
      { kind: 'command', id: 'delete', text: 'Delete', enabled: false, action: vi.fn() },
      {
        kind: 'submenu',
        text: 'Schedule',
        items: [{ kind: 'command', id: 'today', text: 'Today', checked: true, action: today }],
      },
    ])
    await expect.element(page.getByRole('separator')).toBeInTheDocument()
    await expect
      .element(page.getByRole('menuitem', { name: 'Delete' }))
      .toHaveAttribute('aria-disabled', 'true')

    await expect.element(page.getByRole('menu')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    await expect.element(page.getByRole('menuitem', { name: 'Schedule' })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    const checked = page.getByRole('menuitemcheckbox', { name: 'Today' })
    await expect.element(checked).toHaveAttribute('aria-checked', 'true')
    await expect.element(checked).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    expect(today).toHaveBeenCalledWith('today')
    expect(complete).not.toHaveBeenCalled()
    await expectLocatorToHaveCount(page.getByRole('menu'), 0)
  })

  it('closes on Escape without running an action', async () => {
    const host = createBrowserNativeMenuHost()
    const action = vi.fn()
    await rightClickAt(40, 40)

    await host.popup([{ kind: 'command', id: 'unpin', text: 'Unpin Note', action }])
    await expect.element(page.getByRole('menu')).toBeVisible()
    await userEvent.keyboard('{Escape}')

    await expectLocatorToHaveCount(page.getByRole('menu'), 0)
    expect(action).not.toHaveBeenCalled()
  })
})
