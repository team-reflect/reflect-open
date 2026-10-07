import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { MONTH_TITLE_TRANSITION_MS, MonthTitle } from './month-title.tsx'

/**
 * The month header's ticker roll: later months roll up, earlier months roll
 * down, the outgoing label leaves on animationend (with a timer fallback),
 * and reduced motion swaps instantly. The browser context forces
 * prefers-reduced-motion (which also disables the CSS animations), so tests
 * drive `animationend` by hand.
 */
function stubMatchMedia(matches: boolean = false): void {
  const matchMediaMock: typeof window.matchMedia = (query: string) => ({
    matches: matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
  vi.stubGlobal('matchMedia', matchMediaMock)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MonthTitle', () => {
  it('renders the settled label alone', async () => {
    stubMatchMedia(false)
    const view = await render(<MonthTitle month="2026-06" />)
    const settled = view.container.querySelector('[data-slot="month-title"]')
    expect(settled?.textContent).toBe('June 2026')
    expect(view.container.textContent).toBe('June 2026')
  })

  it('rolls up to a later month and clears the outgoing label on animationend', async () => {
    stubMatchMedia(false)
    const view = await render(<MonthTitle month="2026-06" />)
    await view.rerender(<MonthTitle month="2026-07" />)

    const settled = view.container.querySelector('[data-slot="month-title"]')!
    expect(settled.textContent).toBe('July 2026')
    expect(settled.className).toContain('month-title-enter-up')
    const outgoing = view.container.querySelector('.month-title-exit-up')!
    expect(outgoing.textContent).toBe('June 2026')
    expect(outgoing.getAttribute('aria-hidden')).toBe('true')

    outgoing.dispatchEvent(new AnimationEvent('animationend'))
    await expect.poll(() => view.container.querySelector('.month-title-exit-up')).toBeNull()
    expect(settled.className).not.toContain('month-title-enter-up')
  })

  it('rolls down to an earlier month, across the year boundary', async () => {
    stubMatchMedia(false)
    const view = await render(<MonthTitle month="2027-01" />)
    await view.rerender(<MonthTitle month="2026-12" />)

    expect(view.container.querySelector('[data-slot="month-title"]')?.className).toContain(
      'month-title-enter-down',
    )
    expect(view.container.querySelector('.month-title-exit-down')?.textContent).toBe('January 2027')
  })

  it('removes the outgoing label by timer when animationend never fires', async () => {
    stubMatchMedia(false)
    const view = await render(<MonthTitle month="2026-06" />)
    await view.rerender(<MonthTitle month="2026-07" />)
    expect(view.container.querySelector('.month-title-exit-up')).toBeTruthy()

    await expect
      .poll(() => view.container.querySelector('.month-title-exit-up'), {
        timeout: MONTH_TITLE_TRANSITION_MS + 1000,
      })
      .toBeNull()
  })

  it('swaps instantly under reduced motion', async () => {
    stubMatchMedia(true)
    const view = await render(<MonthTitle month="2026-06" />)
    await view.rerender(<MonthTitle month="2026-07" />)

    expect(view.container.textContent).toBe('July 2026')
    expect(view.container.querySelector('.month-title-exit-up')).toBeNull()
    expect(view.container.querySelector('[data-slot="month-title"]')?.className).not.toContain(
      'month-title-enter-up',
    )
  })
})
