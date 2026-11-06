import { page, userEvent } from 'vitest/browser'
import { act } from '@/test-utils/act.ts'
import { useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createDayWindow, dateAtIndex } from '@reflect/app'
import { DayCarousel } from '@/mobile/day-carousel.tsx'
import '@/test-utils/locator.ts'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { scrollElement, touch } from '@/test-utils/scroll.ts'
import {
  CAROUSEL_RADIUS,
  reconcileCarousel,
  shouldRecenter,
  type ReconcileInput,
} from './use-day-carousel.ts'

/**
 * The carousel's follow-the-route decision as pure logic, plus the real
 * carousel driven through native scrolls: a finger scroll stands in for a
 * swipe, since nothing in the carousel handles touches itself.
 */

const base: ReconcileInput = {
  index: 10,
  windowStart: '2025-06-11',
  lastWindowStart: '2025-06-11',
  date: '2026-06-12',
  reported: '2026-06-01',
  forceScroll: false,
}

describe('reconcileCarousel', () => {
  it('scrolls for an ordinary in-window jump', () => {
    expect(reconcileCarousel(base)).toEqual({ action: 'scroll', index: 10 })
  })

  it('does nothing for the echo of our own swipe', () => {
    // The route just echoed back the day we reported — the carousel already
    // shows that slide, so re-scrolling would be a redundant jump.
    expect(
      reconcileCarousel({
        ...base,
        date: '2026-06-01',
        reported: '2026-06-01',
      }),
    ).toEqual({
      action: 'none',
    })
  })

  it('forces a same-date arrival to cancel an in-flight swipe', () => {
    expect(
      reconcileCarousel({
        ...base,
        date: '2026-06-01',
        reported: '2026-06-01',
        forceScroll: true,
      }),
    ).toEqual({ action: 'scroll', index: 10 })
  })

  it('does nothing when the date is outside the window (a re-anchor is pending)', () => {
    expect(reconcileCarousel({ ...base, index: -1 })).toEqual({
      action: 'none',
    })
  })

  it('reinitializes when the window was re-anchored', () => {
    expect(reconcileCarousel({ ...base, lastWindowStart: '2024-01-01' })).toEqual({
      action: 'reinit',
      index: 10,
    })
  })

  it('reinitializes after a re-anchor even when the date matches the last report', () => {
    // A far date link re-anchors *and* is later echoed back: the window change
    // must win over the echo guard, or the rebuilt slides never get shown.
    expect(
      reconcileCarousel({
        ...base,
        lastWindowStart: '2024-01-01',
        date: '2026-06-01',
        reported: '2026-06-01',
      }),
    ).toEqual({ action: 'reinit', index: 10 })
  })

  it('treats an outside date as a no-op even while the window is mid-re-anchor', () => {
    // `index === -1` is checked first: the window effect will rebuild before
    // this reconciliation matters, so there is nothing to scroll yet.
    expect(reconcileCarousel({ ...base, index: -1, lastWindowStart: '2024-01-01' })).toEqual({
      action: 'none',
    })
  })
})

describe('shouldRecenter', () => {
  // 21 slides around the anchor; margin 5 → indices 0–4 and 16–20 trigger.
  const window = createDayWindow('2026-06-12', { past: 10, future: 10 })

  it('leaves the middle of the window alone', () => {
    expect(shouldRecenter(window, 10, 5)).toBe(false)
    expect(shouldRecenter(window, 5, 5)).toBe(false)
    expect(shouldRecenter(window, 15, 5)).toBe(false)
  })

  it('re-centers within the margin of either edge', () => {
    expect(shouldRecenter(window, 4, 5)).toBe(true)
    expect(shouldRecenter(window, 0, 5)).toBe(true)
    expect(shouldRecenter(window, 16, 5)).toBe(true)
    expect(shouldRecenter(window, 20, 5)).toBe(true)
  })
})

describe('useDayCarousel', () => {
  /** The anchor day sits at {@link CAROUSEL_RADIUS}, the window's center. */
  const DATE = '2026-06-12'
  const CENTER = CAROUSEL_RADIUS
  const WIDTH = 390
  const initialWindow = createDayWindow(DATE, {
    past: CAROUSEL_RADIUS,
    future: CAROUSEL_RADIUS,
  })

  interface Route {
    date: string
    navigationKey: string
  }

  const routeTo = (date: string, seq: number): Route => ({ date, navigationKey: `${seq}:${date}` })

  async function mountCarousel() {
    const onSelect = vi.fn<(date: string) => void>()
    const onTarget = vi.fn<(date: string, navigationKey: string) => void>()
    const navigate: { current: (route: Route) => void } = { current: () => {} }
    const resize: { current: (width: number) => void } = { current: () => {} }
    let seq = 0
    // Stands in for the router: a settled day comes back as the new route.
    function Harness(): ReactElement {
      const [route, setRoute] = useState(() => routeTo(DATE, seq))
      const [width, setWidth] = useState(WIDTH)
      navigate.current = setRoute
      resize.current = setWidth
      return (
        <div style={{ display: 'flex', flexDirection: 'column', width, height: 600 }}>
          <DayCarousel
            date={route.date}
            navigationKey={route.navigationKey}
            today={DATE}
            scrollResetSeq={0}
            focusDate={null}
            onFocusConsumed={() => {}}
            onSelect={(day) => {
              onSelect(day)
              setRoute(routeTo(day, ++seq))
            }}
            onTarget={onTarget}
          />
        </div>
      )
    }
    const screen = await renderInApp(<Harness />, { platform: MOBILE_PLATFORM })
    const scroller = screen.container.querySelector<HTMLElement>('[data-scroll-x]')!
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(CENTER * WIDTH))
    return {
      ...screen,
      scroller,
      onSelect,
      onTarget,
      navigate: async (date: string) => {
        await act(() => navigate.current(routeTo(date, ++seq)))
      },
      resize: async (width: number) => {
        await act(() => resize.current(width))
      },
    }
  }

  const slide = (day: string): Element | null => {
    return page.locate(`[data-day="${CSS.escape(day)}"]`).query()
  }

  it('reports the landed day only when the swipe settles', async () => {
    const { scroller, onSelect } = await mountCarousel()

    await touch(scroller, 'start')
    await act(() => scroller.scrollTo({ left: (CENTER + 1) * WIDTH, behavior: 'instant' }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onSelect).not.toHaveBeenCalled()

    await touch(scroller, 'end')
    await act(() => scroller.dispatchEvent(new Event('scrollend')))
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith('2026-06-13'))
    expect(scroller.scrollLeft).toBe((CENTER + 1) * WIDTH)
  })

  it('mounts the next day and announces the target once a swipe passes half a page', async () => {
    const { scroller, onSelect, onTarget } = await mountCarousel()
    expect(slide('2026-06-14')).toBeNull()

    await touch(scroller, 'start')
    await act(() => scroller.scrollTo({ left: (CENTER + 0.6) * WIDTH, behavior: 'instant' }))

    await vi.waitFor(() => expect(slide('2026-06-14')).not.toBeNull())
    expect(onTarget).toHaveBeenCalledExactlyOnceWith('2026-06-13', `0:${DATE}`)
    expect(onSelect).not.toHaveBeenCalled()
    expect(slide('2026-06-11')).not.toBeNull()

    await act(() => scroller.scrollTo({ left: (CENTER + 1) * WIDTH, behavior: 'instant' }))
    await touch(scroller, 'end')
    await act(() => scroller.dispatchEvent(new Event('scrollend')))

    // The settle drops the slide that fell out of the range.
    await vi.waitFor(() => expect(slide('2026-06-11')).toBeNull())
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('2026-06-13')
    expect(slide('2026-06-14')).not.toBeNull()
  })

  it('does not remount a day when a swipe goes back and forth over the middle', async () => {
    const { scroller } = await mountCarousel()

    await touch(scroller, 'start')
    await act(() => scroller.scrollTo({ left: (CENTER + 0.6) * WIDTH, behavior: 'instant' }))
    await vi.waitFor(() => expect(slide('2026-06-14')).not.toBeNull())
    const next = slide('2026-06-14')

    for (const page of [0.4, 0.6, 0.4]) {
      await act(() => scroller.scrollTo({ left: (CENTER + page) * WIDTH, behavior: 'instant' }))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }

    expect(slide('2026-06-14')).toBe(next)
    await touch(scroller, 'end')
  })

  it('leaves the scroller alone when the settled swipe echoes back as the route', async () => {
    const { scroller, onSelect } = await mountCarousel()
    const scrollTo = vi.spyOn(scroller, 'scrollTo')

    await scrollElement({ element: scroller, left: (CENTER + 1) * WIDTH, touch: true })
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledOnce())

    // The test's own scroll is the only one.
    expect(scrollTo).toHaveBeenCalledOnce()
    expect(scroller.scrollLeft).toBe((CENTER + 1) * WIDTH)
  })

  it('jumps to an external in-window selection without reporting it back', async () => {
    const { scroller, onSelect, navigate } = await mountCarousel()

    await navigate('2026-06-20')

    expect(scroller.scrollLeft).toBe((CENTER + 8) * WIDTH)
    expect(slide('2026-06-20')).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('cancels a swipe in progress when Today re-arrives at the unchanged route date', async () => {
    const { scroller, onSelect, navigate } = await mountCarousel()

    await touch(scroller, 'start')
    await act(() => scroller.scrollTo({ left: (CENTER + 0.6) * WIDTH, behavior: 'instant' }))
    await vi.waitFor(() => expect(slide('2026-06-14')).not.toBeNull())

    await navigate(DATE)

    expect(scroller.scrollLeft).toBe(CENTER * WIDTH)
    expect(slide('2026-06-14')).toBeNull()
    await touch(scroller, 'end')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('re-centers the window when a swipe settles near an edge, keeping the slide', async () => {
    const { scroller, onSelect, navigate } = await mountCarousel()
    const nearStart = 29
    const landed = dateAtIndex(initialWindow, nearStart)
    // Within the window, so the jump does not re-anchor it.
    await navigate(dateAtIndex(initialWindow, nearStart + 1))
    const kept = slide(landed)
    expect(kept).not.toBeNull()

    await scrollElement({ element: scroller, left: nearStart * WIDTH, touch: true })

    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(CENTER * WIDTH))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(landed)
    expect(slide(landed)).toBe(kept)
    // On screen, over the cell the scroller rests on.
    expect(kept!.getBoundingClientRect().left).toBeCloseTo(scroller.getBoundingClientRect().left)
  })

  it('reports the day a scroll that no finger started settles on', async () => {
    const { scroller, onSelect } = await mountCarousel()

    await scrollElement({ element: scroller, left: (CENTER + 1) * WIDTH })

    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith('2026-06-13'))
    expect(scroller.scrollLeft).toBe((CENTER + 1) * WIDTH)
  })

  it('aligns a swipe that comes to rest between two days', async () => {
    const { scroller, onSelect } = await mountCarousel()
    // WebKit can rest off a snap point; without snapping, any engine can.
    scroller.style.scrollSnapType = 'none'

    await scrollElement({ element: scroller, left: (CENTER + 1) * WIDTH + 30, touch: true })

    await vi.waitFor(() => expect(scroller.scrollLeft).toBe((CENTER + 1) * WIDTH))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('2026-06-13')
  })

  it('lands a second swipe that starts before the first settles on a mounted slide', async () => {
    const { scroller, onSelect } = await mountCarousel()

    await touch(scroller, 'start')
    await act(() => scroller.scrollTo({ left: (CENTER + 1) * WIDTH, behavior: 'instant' }))
    await touch(scroller, 'end')
    // The second finger lands inside the quiet time, before any settle.
    await touch(scroller, 'start')
    await act(() => scroller.scrollTo({ left: (CENTER + 2) * WIDTH, behavior: 'instant' }))
    await vi.waitFor(() => expect(slide('2026-06-14')).not.toBeNull())
    await touch(scroller, 'end')
    await act(() => scroller.dispatchEvent(new Event('scrollend')))

    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith('2026-06-14'))
    expect(scroller.scrollLeft).toBe((CENTER + 2) * WIDTH)
  })

  it('stays on the same day when the page width changes', async () => {
    const { scroller, onSelect, resize } = await mountCarousel()
    // Without snapping, only the carousel moves the scroller.
    scroller.style.scrollSnapType = 'none'

    await resize(500)

    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(CENTER * 500))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('leaves the scroller to a finger that is down when the page width changes', async () => {
    const { scroller, resize } = await mountCarousel()
    scroller.style.scrollSnapType = 'none'

    await touch(scroller, 'start')
    await resize(500)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(scroller.scrollLeft).toBe(CENTER * WIDTH)
    await touch(scroller, 'end')
  })

  it('stops horizontal scrolling while the software keyboard is up', async () => {
    const { scroller, appServices } = await mountCarousel()
    expect(getComputedStyle(scroller).overflowX).toBe('auto')

    await act(() => appServices.keyboard.publish(300))

    expect(getComputedStyle(scroller).overflowX).toBe('hidden')
    expect(scroller.scrollLeft).toBe(CENTER * WIDTH)
  })

  it('stays on the selected day when its editor is tapped', async () => {
    const { scroller, onSelect } = await mountCarousel()
    const editor = await vi.waitFor(() => {
      const element = slide(DATE)?.querySelector<HTMLElement>('[contenteditable="true"]')
      expect(element).toBeTruthy()
      return element!
    })
    await touch(editor, 'start')
    await touch(editor, 'end')
    await act(() => editor.focus())

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(scroller.scrollLeft).toBe(CENTER * WIDTH)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('blurs an editor left focused on the day a swipe leaves', async () => {
    const { scroller, onSelect } = await mountCarousel()
    const editor = await vi.waitFor(() => {
      const element = slide(DATE)?.querySelector<HTMLElement>('[contenteditable="true"]')
      expect(element).toBeTruthy()
      return element!
    })
    await act(() => editor.focus({ preventScroll: true }))
    expect(slide(DATE)!.contains(document.activeElement)).toBe(true)

    await scrollElement({ element: scroller, left: (CENTER + 1) * WIDTH, touch: true })

    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledOnce())
    expect(slide(DATE)!.contains(document.activeElement)).toBe(false)
  })

  it('keeps Tab out of the days on either side of the selected day', async () => {
    await mountCarousel()
    const editor = await vi.waitFor(() => {
      const element = slide(DATE)?.querySelector<HTMLElement>('[contenteditable="true"]')
      expect(element).toBeTruthy()
      return element!
    })
    await act(() => editor.focus({ preventScroll: true }))

    await userEvent.tab()

    expect(slide('2026-06-11')!.contains(document.activeElement)).toBe(false)
    expect(slide('2026-06-13')!.contains(document.activeElement)).toBe(false)
  })

  it('lets focus into a day once a swipe settles on it', async () => {
    const { scroller, onSelect } = await mountCarousel()

    await scrollElement({ element: scroller, left: (CENTER + 1) * WIDTH, touch: true })
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledOnce())
    const editor = await vi.waitFor(() => {
      const element = slide('2026-06-13')?.querySelector<HTMLElement>('[contenteditable="true"]')
      expect(element).toBeTruthy()
      return element!
    })
    await act(() => editor.focus({ preventScroll: true }))

    expect(document.activeElement).toBe(editor)
    expect(slide(DATE)!.hasAttribute('inert')).toBe(true)
  })
})
