import { useCallback, useState, type ReactElement } from 'react'
import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
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
    const title = page.getByRole('heading', { name: 'Test drawer' }).element()
    const top = title.getBoundingClientRect().top
    const mouse = (type: string, target: EventTarget, clientY: number): void => {
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', clientY }),
      )
    }
    mouse('pointerdown', title, top)
    mouse('pointermove', window, top + 10)
    mouse('pointermove', window, innerHeight)
    mouse('pointerup', window, innerHeight)

    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on a tap above the sheet', async () => {
    await renderInApp(<Harness />)
    await openScroller()
    await userEvent.click(page.getByRole('dialog'), { position: { x: 20, y: 20 } })

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('stays open at the new open snap point when the sheet grows', async () => {
    const view = await renderInApp(<Harness rows={1} />)
    const scroller = await openScroller()
    await view.rerender(<Harness rows={8} />)

    await vi.waitFor(() => expect(scroller.scrollTop).toBe(openTop(scroller)))
  })
})
