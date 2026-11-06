import { act } from '@/test-utils/act.ts'
import { useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { WeekStartDay } from '@reflect/core'
import { getUserWeekStart } from '@reflect/core'
import { createWeekWindow, weekAtIndex, weekIndexOf } from '@reflect/app'
import { createTestSystemPreferencesService } from '@reflect/app/testing'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { scrollElement, touch } from '@/test-utils/scroll.ts'
import { shouldRecenterWeeks, useWeekStrip, type WeekStrip } from './use-week-strip.ts'

/**
 * The strip's paging driven through a real native scroller: a finger scroll
 * stands in for a swipe, since nothing in the strip handles touches itself.
 */

/** 2026-06-12 is a Friday; its Monday-start week (2026-06-08) anchors the window. */
const DATE = '2026-06-12'
const WEEK_START: WeekStartDay = 'monday'
const WIDTH = 390
const initialWindow = createWeekWindow(DATE, WEEK_START)
const ANCHOR = initialWindow.anchorIndex

interface StripProps {
  date: string
  weekStart: WeekStartDay
  width: number
}

async function mountStrip(options?: { reducedMotion?: boolean }) {
  const strip: { current: WeekStrip | null } = { current: null }
  const update: { current: (props: Partial<StripProps>) => void } = { current: () => {} }
  function Harness(): ReactElement {
    const [props, setProps] = useState<StripProps>({
      date: DATE,
      weekStart: WEEK_START,
      width: WIDTH,
    })
    update.current = (next) => setProps((current) => ({ ...current, ...next }))
    const current = useWeekStrip(props.date, props.weekStart)
    strip.current = current
    return (
      <div
        ref={current.scrollerRef}
        style={{
          display: 'flex',
          width: props.width,
          overflowX: 'auto',
          scrollSnapType: 'x mandatory',
        }}
      >
        {Array.from({ length: current.weekWindow.count }, (_, index) => (
          <div
            key={weekAtIndex(current.weekWindow, index)}
            style={{
              width: '100%',
              height: 40,
              flexShrink: 0,
              scrollSnapAlign: 'start',
              scrollSnapStop: 'always',
            }}
          >
            <button type="button">day</button>
          </div>
        ))}
      </div>
    )
  }
  const screen = await renderInApp(<Harness />, {
    platform: MOBILE_PLATFORM,
    appServices: {
      systemPreferences: createTestSystemPreferencesService({
        reducedMotion: options?.reducedMotion ?? false,
      }),
    },
  })
  const scroller = screen.container.querySelector<HTMLElement>('div[style*="overflow"]')!
  await vi.waitFor(() => expect(scroller.scrollLeft).toBe(ANCHOR * WIDTH))
  return {
    scroller,
    strip: (): WeekStrip => strip.current!,
    update: async (props: Partial<StripProps>) => {
      await act(() => update.current(props))
    },
  }
}

describe('useWeekStrip', () => {
  it('rebuilds the window when a swipe settles near an edge and stays on the browsed week', async () => {
    const { scroller, strip } = await mountStrip()

    await scrollElement({ element: scroller, left: WIDTH, touch: true })

    const browsedWeek = weekAtIndex(initialWindow, 1)
    const rebuilt = createWeekWindow(browsedWeek, WEEK_START)
    await vi.waitFor(() => expect(strip().weekWindow).toEqual(rebuilt))
    expect(scroller.scrollLeft).toBe(rebuilt.anchorIndex * WIDTH)
    expect(strip().displayedWeekStart).toBe(browsedWeek)
  })

  it('leaves a mid-window settle alone', async () => {
    const { scroller, strip } = await mountStrip()

    await scrollElement({ element: scroller, left: (ANCHOR + 2) * WIDTH, touch: true })

    await vi.waitFor(() => {
      return expect(strip().displayedWeekStart).toBe(weekAtIndex(initialWindow, ANCHOR + 2))
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(strip().weekWindow).toEqual(initialWindow)
    expect(scroller.scrollLeft).toBe((ANCHOR + 2) * WIDTH)
  })

  it('shows the week nearest a finger scroll before the scroll settles', async () => {
    const { scroller, strip } = await mountStrip()

    await touch(scroller, 'start')
    await act(() => scroller.scrollTo({ left: (ANCHOR + 1) * WIDTH, behavior: 'instant' }))

    await vi.waitFor(() => {
      return expect(strip().displayedWeekStart).toBe(weekAtIndex(initialWindow, ANCHOR + 1))
    })
    await touch(scroller, 'end')
  })

  it('displays the week a scroll that no finger started settles on', async () => {
    const { scroller, strip } = await mountStrip()

    await scrollElement({ element: scroller, left: (ANCHOR + 3) * WIDTH })

    await vi.waitFor(() => {
      return expect(strip().displayedWeekStart).toBe(weekAtIndex(initialWindow, ANCHOR + 3))
    })
    expect(scroller.scrollLeft).toBe((ANCHOR + 3) * WIDTH)
  })

  it('shows the week of a day that keyboard focus moves to', async () => {
    const { scroller, strip } = await mountStrip()

    // The focus may come inside the quiet time of a program scroll that
    // landed on the page, such as the one that rests the strip on mount.
    scroller.dispatchEvent(new Event('scroll'))
    await act(() => {
      scroller.children[ANCHOR + 2]?.querySelector('button')?.focus()
    })

    expect(strip().displayedWeekStart).toBe(weekAtIndex(initialWindow, ANCHOR + 2))
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe((ANCHOR + 2) * WIDTH))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(scroller.scrollLeft).toBe((ANCHOR + 2) * WIDTH)
  })

  it('follows an in-window date change without snapping back while browsing', async () => {
    const { scroller, strip, update } = await mountStrip()

    // Browse two weeks ahead of the selection: a re-render must not scroll the
    // strip back to the (unchanged) date's week.
    await scrollElement({ element: scroller, left: (ANCHOR + 2) * WIDTH, touch: true })
    await update({ width: WIDTH })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(scroller.scrollLeft).toBe((ANCHOR + 2) * WIDTH)

    await update({ date: '2026-06-19' })
    expect(strip().displayedWeekStart).toBe(weekAtIndex(initialWindow, ANCHOR + 1))
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe((ANCHOR + 1) * WIDTH))
    expect(strip().weekWindow).toEqual(initialWindow)
  })

  it('jumps to a followed week at once when the user prefers reduced motion', async () => {
    const { scroller, update } = await mountStrip({ reducedMotion: true })

    await update({ date: '2026-06-19' })

    expect(scroller.scrollLeft).toBe((ANCHOR + 1) * WIDTH)
  })

  it('showWeekOf scrolls to an in-window target', async () => {
    const { scroller, strip } = await mountStrip()

    await act(() => strip().showWeekOf('2026-06-19'))

    expect(strip().displayedWeekStart).toBe(weekAtIndex(initialWindow, ANCHOR + 1))
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe((ANCHOR + 1) * WIDTH))
    expect(strip().weekWindow).toEqual(initialWindow)
  })

  it('showWeekOf rebuilds the window around an out-of-window target', async () => {
    const { scroller, strip } = await mountStrip()
    const target = '2027-06-12'
    expect(weekIndexOf(initialWindow, target, WEEK_START)).toBe(-1)

    await act(() => strip().showWeekOf(target))

    const rebuilt = createWeekWindow(target, WEEK_START)
    expect(strip().weekWindow).toEqual(rebuilt)
    expect(strip().displayedWeekStart).toBe(getUserWeekStart(target, WEEK_START))
    expect(scroller.scrollLeft).toBe(rebuilt.anchorIndex * WIDTH)
  })

  it('rebuilds around a far date change that falls outside the window', async () => {
    const { scroller, strip, update } = await mountStrip()

    await update({ date: '2027-06-12' })

    const rebuilt = createWeekWindow('2027-06-12', WEEK_START)
    expect(strip().weekWindow).toEqual(rebuilt)
    expect(strip().displayedWeekStart).toBe(getUserWeekStart('2027-06-12', WEEK_START))
    expect(scroller.scrollLeft).toBe(rebuilt.anchorIndex * WIDTH)
  })

  it('rebuilds when the week-start setting re-aligns the weeks', async () => {
    const { scroller, strip, update } = await mountStrip()
    // The old window's Monday-aligned weeks no longer contain any
    // Sunday-start week — the misalignment signal a rebuild answers.
    expect(weekIndexOf(initialWindow, DATE, 'sunday')).toBe(-1)

    await update({ weekStart: 'sunday' })

    const rebuilt = createWeekWindow(DATE, 'sunday')
    expect(strip().weekWindow).toEqual(rebuilt)
    expect(strip().displayedWeekStart).toBe(getUserWeekStart(DATE, 'sunday'))
    expect(scroller.scrollLeft).toBe(rebuilt.anchorIndex * WIDTH)
  })

  it('stays on the displayed week when the page width changes', async () => {
    const { scroller, update } = await mountStrip()
    // Without snapping, only the strip moves the scroller.
    scroller.style.scrollSnapType = 'none'

    await update({ width: 500 })

    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(ANCHOR * 500))
  })

  it('leaves the scroller to a finger that is down when the page width changes', async () => {
    const { scroller, update } = await mountStrip()
    scroller.style.scrollSnapType = 'none'

    await touch(scroller, 'start')
    await update({ width: 500 })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(scroller.scrollLeft).toBe(ANCHOR * WIDTH)
    await touch(scroller, 'end')
  })
})

describe('shouldRecenterWeeks', () => {
  // 9 week slides around the anchor; margin 2 → indices 0–1 and 7–8 trigger.
  const window = createWeekWindow('2026-06-12', 'monday', 4)

  it('leaves the middle of the window alone', () => {
    expect(shouldRecenterWeeks(window, 4, 2)).toBe(false)
    expect(shouldRecenterWeeks(window, 2, 2)).toBe(false)
    expect(shouldRecenterWeeks(window, 6, 2)).toBe(false)
  })

  it('re-centers within the margin of either edge', () => {
    expect(shouldRecenterWeeks(window, 1, 2)).toBe(true)
    expect(shouldRecenterWeeks(window, 0, 2)).toBe(true)
    expect(shouldRecenterWeeks(window, 7, 2)).toBe(true)
    expect(shouldRecenterWeeks(window, 8, 2)).toBe(true)
  })
})
