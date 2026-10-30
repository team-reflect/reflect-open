import { page } from 'vitest/browser'
import { expect } from 'vitest'
import { scrollElement } from '@/test-utils/scroll.ts'

/**
 * Swipes the open drawer down to its closed snap point with a finger, then
 * waits until the drawer leaves the document.
 */
export async function swipeDrawerClosed(): Promise<void> {
  const scroller = document.querySelector<HTMLElement>('.scroll-drawer')
  if (scroller === null) {
    throw new Error('No drawer is open.')
  }
  await scrollElement({ element: scroller, top: 0, touch: true })
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
}
