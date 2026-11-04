import { useCallback, useState, type ReactElement } from 'react'
import { page } from 'vitest/browser'
import { mouse } from 'vitest-browser-commands/playwright'
import { describe, expect, it, vi } from 'vitest'
import { act } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { scrollElement } from '@/test-utils/scroll.ts'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from './scroll-drawer.tsx'

/**
 * The native-scroll drawer: the scroller's position is the sheet position, a
 * user scroll that settles on the closed snap point closes it, and every other
 * close path runs Base UI's exit.
 */

function Harness({
  onOpenChange,
  keepOpen = false,
  rows = 3,
}: {
  onOpenChange?: ((open: boolean) => void) | undefined
  keepOpen?: boolean | undefined
  rows?: number | undefined
}): ReactElement {
  const [open, setOpen] = useState(true)
  const handleOpenChange = useCallback(
    (next: boolean) => {
      onOpenChange?.(next)
      if (!keepOpen) {
        setOpen(next)
      }
    },
    [onOpenChange, keepOpen],
  )
  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent>
        <DrawerTitle>Test drawer</DrawerTitle>
        <DrawerBody>
          <p className="select-text">Code ABCD-1234</p>
          {Array.from({ length: rows }, (_, index) => (
            <button key={index} type="button">
              Row {index}
            </button>
          ))}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}

async function openScroller(): Promise<HTMLElement> {
  await expect.element(page.getByRole('dialog', { name: 'Test drawer' })).toBeVisible()
  const scroller = document.querySelector<HTMLElement>('.scroll-drawer')
  if (scroller === null) {
    throw new Error('The drawer scroller is not mounted.')
  }
  return scroller
}

function openTop(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.clientHeight
}

describe('ScrollDrawer', () => {
  it('opens at the open snap point', async () => {
    await renderInApp(<Harness />)
    const scroller = await openScroller()
    expect(scroller.scrollTop).toBe(openTop(scroller))
  })

  it('closes when a swipe settles on the closed snap point', async () => {
    const onOpenChange = vi.fn()
    await renderInApp(<Harness onOpenChange={onOpenChange} />)
    await scrollElement({ element: await openScroller(), top: 0, touch: true })

    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('scrolls back open when the owner keeps it open', async () => {
    await renderInApp(<Harness keepOpen />)
    const scroller = await openScroller()
    await scrollElement({ element: scroller, top: 0, touch: true })

    await vi.waitFor(() => expect(scroller.scrollTop).toBe(openTop(scroller)))
    await expect.element(page.getByRole('dialog')).toBeVisible()
  })

  it('never closes for a scroll that no finger started', async () => {
    const onOpenChange = vi.fn()
    await renderInApp(<Harness onOpenChange={onOpenChange} />)
    const scroller = await openScroller()
    await scrollElement({ element: scroller, top: 0 })

    await vi.waitFor(() => expect(scroller.scrollTop).toBe(openTop(scroller)))
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('closes when a mouse drags the sheet down', async () => {
    const onOpenChange = vi.fn()
    await renderInApp(<Harness onOpenChange={onOpenChange} />)
    await openScroller()
    const title = page
      .getByRole('heading', { name: 'Test drawer' })
      .element()
      .getBoundingClientRect()

    await mouse.move(title.left + 20, title.top + 5)
    await mouse.down()
    await mouse.move(title.left + 20, innerHeight - 5, { steps: 10 })
    await mouse.up()

    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('lets a mouse select text in the body', async () => {
    await renderInApp(<Harness />)
    await openScroller()
    const text = page.getByText('Code ABCD-1234').element().getBoundingClientRect()
    const y = text.top + text.height / 2

    await mouse.move(text.left + 1, y)
    await mouse.down()
    await mouse.move(text.right - 1, y, { steps: 5 })
    await mouse.up()

    expect(window.getSelection()?.toString()).toContain('ABCD-1234')
    await expect.element(page.getByRole('dialog')).toBeVisible()
  })

  it('closes on a tap above the sheet', async () => {
    await renderInApp(<Harness />)
    await openScroller()

    // Clicks the element at the point, in place: a locator click is unreliable in WebKit CI.
    const dialog = page.getByRole('dialog').element().getBoundingClientRect()
    const target = document.elementFromPoint(dialog.left + 20, dialog.top + 20)
    if (!(target instanceof HTMLElement)) {
      throw new TypeError('Nothing to tap above the sheet.')
    }
    expect(target.classList.contains('scroll-drawer-spacer')).toBe(true)
    await act(() => {
      target.click()
    })

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('stays open at the new open snap point when the sheet grows', async () => {
    const view = await renderInApp(<Harness rows={1} />)
    const scroller = await openScroller()
    await view.rerender(<Harness rows={8} />)

    await vi.waitFor(() => expect(scroller.scrollTop).toBe(openTop(scroller)))
    // A detached scroller would also read 0 for both.
    expect(scroller.isConnected).toBe(true)
    await expect.element(page.getByRole('dialog')).toBeInTheDocument()
  })
})
