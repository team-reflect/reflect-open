import { cleanup, render } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Drawer, DrawerContent, DrawerTitle } from './drawer'

/**
 * The bottom sheet's keyboard contract: the popup is `position: fixed`, so the
 * mobile shell's shrunken height can't lift it above the software keyboard —
 * it must read `--keyboard-height` itself (the shell's rule for fixed
 * elements). Vaul repositioned above the keyboard on its own; the Base UI
 * rebuild left avoidance to us, and losing this offset put the task sheet's
 * add flow underneath the keyboard.
 */

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--keyboard-height')
})

async function mountOpenDrawer(): Promise<HTMLElement> {
  await render(
    <Drawer open onOpenChange={() => {}}>
      <DrawerContent aria-label="Sheet">
        <DrawerTitle>Sheet</DrawerTitle>
        <p>Sheet body</p>
      </DrawerContent>
    </Drawer>,
  )
  return await vi.waitFor(() => {
    const popup = document.querySelector<HTMLElement>('[data-slot="drawer-popup"]')
    if (popup === null) {
      throw new Error('drawer popup did not mount')
    }
    return popup
  })
}

describe('Drawer keyboard avoidance', () => {
  it('sits at the viewport bottom while no keyboard is up', async () => {
    const popup = await mountOpenDrawer()

    expect(getComputedStyle(popup).bottom).toBe('0px')
  })

  it('rides on the software keyboard’s top edge via --keyboard-height', async () => {
    document.documentElement.style.setProperty('--keyboard-height', '300px')
    const popup = await mountOpenDrawer()

    expect(getComputedStyle(popup).bottom).toBe('300px')
  })

  it('caps its height to what the keyboard leaves visible', async () => {
    document.documentElement.style.setProperty('--keyboard-height', '300px')
    const popup = await mountOpenDrawer()

    const maxHeight = Number.parseFloat(getComputedStyle(popup).maxHeight)
    const expected = Math.min(window.innerHeight * 0.85, window.innerHeight - 300)
    expect(maxHeight).toBeCloseTo(expected, 0)
  })
})
