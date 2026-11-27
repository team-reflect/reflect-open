import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { createBrowserNativeMenuHost } from './browser-native-menu.tsx'

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

  it('replaces the open menu when another row is right-clicked', async () => {
    const host = createBrowserNativeMenuHost()
    const rows = ['Row A', 'Row B'].map((name, index) => {
      const row = document.body.appendChild(document.createElement('button'))
      row.textContent = name
      row.style.cssText = `position: fixed; left: ${100 + index * 400}px; top: ${100 + index * 300}px`
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        void host.popup([{ kind: 'command', id: name, text: `Open ${name}`, action: vi.fn() }])
      })
      return row
    })

    await page.getByRole('button', { name: 'Row A' }).click({ button: 'right' })
    await expect.element(page.getByRole('menuitem', { name: 'Open Row A' })).toBeVisible()
    await page.getByRole('button', { name: 'Row B' }).click({ button: 'right', force: true })

    await expect.element(page.getByRole('menuitem', { name: 'Open Row B' })).toBeVisible()
    await expectLocatorToHaveCount(page.getByRole('menuitem', { name: 'Open Row A' }), 0)
    const row = rows[1]?.getBoundingClientRect()
    await vi.waitFor(() => {
      const menu = page.getByRole('menu').element().getBoundingClientRect()
      expect(menu.left).toBeCloseTo((row?.left ?? 0) + (row?.width ?? 0) / 2, -1)
      expect(menu.top).toBeCloseTo((row?.top ?? 0) + (row?.height ?? 0) / 2, -1)
    })
    await userEvent.keyboard('{Escape}')
    await expectLocatorToHaveCount(page.getByRole('menu'), 0)
    for (const row of rows) row.remove()
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
