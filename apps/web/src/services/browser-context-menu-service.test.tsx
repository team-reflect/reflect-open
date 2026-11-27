import { mouse } from 'vitest-browser-commands/playwright'
import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import type { ContextMenuItem } from '@reflect/app'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { createBrowserContextMenuService } from './browser-context-menu-service.tsx'

describe('createBrowserContextMenuService', () => {
  it('opens the menu at the right-click point and runs the picked action', async () => {
    const service = createBrowserContextMenuService()
    const onSelect = vi.fn()
    const items = Promise.withResolvers<ContextMenuItem[]>()
    await mouse.click(120, 80, { button: 'right' })

    const opened = service.open({ items: items.promise, onSelect })
    await mouse.click(300, 300, { button: 'right' })
    items.resolve([{ type: 'action', id: 'unpin', title: 'Unpin Note' }])
    await opened
    const item = page.getByRole('menuitem', { name: 'Unpin Note' })
    await expect.element(item).toBeVisible()
    await vi.waitFor(() => {
      const menu = page.getByRole('menu').element().getBoundingClientRect()
      expect([Math.round(menu.left), Math.round(menu.top)]).toEqual([120, 80])
    })

    await item.click()
    expect(onSelect).toHaveBeenCalledWith('unpin')
    await expectLocatorToHaveCount(page.getByRole('menu'), 0)
  })

  it('shows separators, disabled, checked and submenu items, navigable by keyboard', async () => {
    const service = createBrowserContextMenuService()
    const onSelect = vi.fn()
    await mouse.click(40, 40, { button: 'right' })

    await service.open({
      items: [
        { type: 'action', id: 'complete', title: 'Complete' },
        { type: 'separator' },
        { type: 'action', id: 'delete', title: 'Delete', disabled: true },
        {
          type: 'submenu',
          title: 'Schedule',
          items: [{ type: 'action', id: 'today', title: 'Today', checked: true }],
        },
      ],
      onSelect,
    })
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

    expect(onSelect.mock.calls).toEqual([['today']])
    await expectLocatorToHaveCount(page.getByRole('menu'), 0)
  })

  it('replaces the open menu when another row is right-clicked', async () => {
    const service = createBrowserContextMenuService()
    const rows = ['Row A', 'Row B'].map((name, index) => {
      const row = document.body.appendChild(document.createElement('button'))
      row.textContent = name
      row.style.cssText = `position: fixed; left: ${100 + index * 400}px; top: ${100 + index * 300}px`
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        void service.open({
          items: [{ type: 'action', id: name, title: `Open ${name}` }],
          onSelect: vi.fn(),
        })
      })
      return row
    })

    await page.getByRole('button', { name: 'Row A' }).click({ button: 'right' })
    await expect.element(page.getByRole('menuitem', { name: 'Open Row A' })).toBeVisible()
    const row = rows[1]?.getBoundingClientRect() ?? new DOMRect()
    const rowCenter = { x: row.left + row.width / 2, y: row.top + row.height / 2 }
    await mouse.click(rowCenter.x, rowCenter.y, { button: 'right' })

    await expect.element(page.getByRole('menuitem', { name: 'Open Row B' })).toBeVisible()
    await expectLocatorToHaveCount(page.getByRole('menuitem', { name: 'Open Row A' }), 0)
    await vi.waitFor(() => {
      const menu = page.getByRole('menu').element().getBoundingClientRect()
      expect(menu.left).toBeCloseTo(rowCenter.x, -1)
      expect(menu.top).toBeCloseTo(rowCenter.y, -1)
    })
    await userEvent.keyboard('{Escape}')
    await expectLocatorToHaveCount(page.getByRole('menu'), 0)
    for (const row of rows) row.remove()
  })

  it('keeps the browser menu closed on a right-click inside the menu or a submenu', async () => {
    const service = createBrowserContextMenuService()
    await mouse.click(40, 40, { button: 'right' })
    await service.open({
      items: [
        {
          type: 'submenu',
          title: 'Schedule',
          items: [{ type: 'action', id: 'today', title: 'Today' }],
        },
      ],
      onSelect: vi.fn(),
    })
    await page.getByRole('menuitem', { name: 'Schedule' }).click()
    const item = page.getByRole('menuitem', { name: 'Today' })
    await expect.element(item).toBeVisible()
    let defaultPrevented: boolean | undefined
    document.addEventListener(
      'contextmenu',
      (event) => (defaultPrevented = event.defaultPrevented),
      {
        once: true,
      },
    )

    await item.click({ button: 'right' })

    expect(defaultPrevented).toBe(true)
    await userEvent.keyboard('{Escape}')
    await expectLocatorToHaveCount(page.getByRole('menu'), 1)
    await userEvent.keyboard('{Escape}')
    await expectLocatorToHaveCount(page.getByRole('menu'), 0)
  })

  it('closes on Escape without running an action', async () => {
    const service = createBrowserContextMenuService()
    const onSelect = vi.fn()
    await mouse.click(40, 40, { button: 'right' })

    await service.open({ items: [{ type: 'action', id: 'unpin', title: 'Unpin Note' }], onSelect })
    await expect.element(page.getByRole('menu')).toBeVisible()
    await userEvent.keyboard('{Escape}')

    await expectLocatorToHaveCount(page.getByRole('menu'), 0)
    expect(onSelect).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(document.querySelector('[data-base-ui-portal]')).toBeNull())
  })
})
