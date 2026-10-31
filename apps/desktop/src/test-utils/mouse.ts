import { expect } from 'vitest'
import { mouse } from 'vitest-browser-commands/playwright'
import { page, type Locator } from 'vitest/browser'

export interface HoverOptions {
  /**
   * A point relative to the top-left corner of the element. Defaults to the
   * center of the element.
   */
  position?: { x: number; y: number }
}

/**
 * Hovers an element. More reliable than `locator.hover()` because it sends
 * multiple mouse move events. Returns the final mouse position.
 */
export async function hover(
  locator: Locator,
  options?: HoverOptions,
): Promise<{ x: number; y: number }> {
  await expect.element(locator).toBeVisible()
  const box = locator.element().getBoundingClientRect()
  const x = box.x + (options?.position?.x ?? Math.floor(box.width / 2))
  const y = box.y + (options?.position?.y ?? Math.floor(box.height / 2))
  await mouse.move(x, y, { steps: 3 })
  return { x, y }
}

/** Parks the mouse at the top-left corner of the page. */
export async function unhover(): Promise<void> {
  await hover(page.locate('body'), { position: { x: 0, y: 0 } })
}
