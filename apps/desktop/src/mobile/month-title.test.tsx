import { describe, expect, it } from 'vitest'
import { act } from '@/test-utils/act.ts'
import { emulateReducedMotion } from '@/test-utils/reduced-motion.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { MonthTitle } from './month-title.tsx'

/**
 * The month header's ticker roll: later months roll up, earlier months roll
 * down, the outgoing label leaves when its animation finishes, and reduced
 * motion swaps instantly. Each test sets `prefers-reduced-motion` for itself,
 * and tests finish the animations by hand.
 */

async function finishAnimations(element: Element): Promise<void> {
  await act(async () => {
    const animations = element.getAnimations()
    for (const animation of animations) {
      animation.finish()
    }
    await Promise.allSettled(animations.map((animation) => animation.finished))
  })
}

describe('MonthTitle', () => {
  it('renders the settled label alone', async () => {
    const view = await renderInApp(<MonthTitle month="2026-06" />)
    const settled = view.container.querySelector('[data-slot="month-title"]')
    expect(settled?.textContent).toBe('June 2026')
    expect(view.container.textContent).toBe('June 2026')
  })

  it('rolls up to a later month and clears the outgoing label when it finishes', async () => {
    await emulateReducedMotion(false)
    const view = await renderInApp(<MonthTitle month="2026-06" />)
    await view.rerender(<MonthTitle month="2026-07" />)

    const settled = view.container.querySelector('[data-slot="month-title"]')!
    expect(settled.textContent).toBe('July 2026')
    expect(settled.className).toContain('month-title-enter-up')
    const outgoing = view.container.querySelector('.month-title-exit-up')!
    expect(outgoing.textContent).toBe('June 2026')
    expect(outgoing.getAttribute('aria-hidden')).toBe('true')

    await finishAnimations(outgoing)
    await expect.poll(() => view.container.querySelector('.month-title-exit-up')).toBeNull()
    expect(settled.className).not.toContain('month-title-enter-up')
  })

  it('rolls down to an earlier month, across the year boundary', async () => {
    await emulateReducedMotion(false)
    const view = await renderInApp(<MonthTitle month="2027-01" />)
    await view.rerender(<MonthTitle month="2026-12" />)

    expect(view.container.querySelector('[data-slot="month-title"]')?.className).toContain(
      'month-title-enter-down',
    )
    expect(view.container.querySelector('.month-title-exit-down')?.textContent).toBe('January 2027')
  })

  it('removes the outgoing label when its animation runs to the end', async () => {
    await emulateReducedMotion(false)
    const view = await renderInApp(<MonthTitle month="2026-06" />)
    await view.rerender(<MonthTitle month="2026-07" />)
    expect(view.container.querySelector('.month-title-exit-up')).toBeTruthy()

    await expect
      .poll(() => view.container.querySelector('.month-title-exit-up'), { timeout: 2000 })
      .toBeNull()
  })

  it('swaps instantly under reduced motion', async () => {
    await emulateReducedMotion(true)
    const view = await renderInApp(<MonthTitle month="2026-06" />)
    await view.rerender(<MonthTitle month="2026-07" />)

    expect(view.container.textContent).toBe('July 2026')
    expect(view.container.querySelector('.month-title-exit-up')).toBeNull()
    expect(view.container.querySelector('[data-slot="month-title"]')?.className).not.toContain(
      'month-title-enter-up',
    )
  })
})
