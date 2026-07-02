import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WeekStartDay } from '@reflect/core'
import { createWeekWindow, weekAtIndex, weekIndexOf, weekStartOf } from './calendar'
import { shouldRecenterWeeks, useWeekStrip } from './use-week-strip'

/**
 * The strip's Embla wiring — window rebuilds landing on the anchor, the
 * browse-vs-follow echo guard, and the week-start realignment — driven through
 * a fake Embla API: jsdom can't host the carousel's pointer gestures, so the
 * fake exposes the settled-swipe events the real one would fire.
 */

const embla = vi.hoisted(() => {
  const handlers = new Map<string, Set<(api: unknown) => void>>()
  let selected = 0

  const api = {
    selectedScrollSnap: (): number => selected,
    on: (event: string, handler: (api: unknown) => void) => {
      let registered = handlers.get(event)
      if (!registered) {
        registered = new Set()
        handlers.set(event, registered)
      }
      registered.add(handler)
      return api
    },
    off: (event: string, handler: (api: unknown) => void) => {
      handlers.get(event)?.delete(handler)
      return api
    },
    scrollTo: vi.fn((index: number) => {
      selected = index
    }),
    reInit: vi.fn((options?: { startIndex?: number }) => {
      if (options?.startIndex !== undefined) {
        selected = options.startIndex
      }
    }),
  }

  function emit(event: string): void {
    for (const handler of [...(handlers.get(event) ?? [])]) {
      handler(api)
    }
  }

  return {
    api,
    /** Land on `index` and fire select + settle, as a finished swipe would. */
    settleAt(index: number): void {
      selected = index
      emit('select')
      emit('settle')
    },
    reset(): void {
      handlers.clear()
      selected = 0
      api.scrollTo.mockClear()
      api.reInit.mockClear()
    },
  }
})

vi.mock('embla-carousel-react', () => ({
  default: () => [() => {}, embla.api],
}))

afterEach(() => {
  cleanup()
  embla.reset()
})

/** 2026-06-12 is a Friday; its Monday-start week (2026-06-08) anchors the window. */
const DATE = '2026-06-12'
const WEEK_START: WeekStartDay = 'monday'
const initialWindow = createWeekWindow(DATE, WEEK_START)

function mountStrip(date: string = DATE, weekStart: WeekStartDay = WEEK_START) {
  return renderHook(
    ({ date: currentDate, weekStart: currentWeekStart }) =>
      useWeekStrip(currentDate, currentWeekStart),
    { initialProps: { date, weekStart } },
  )
}

describe('useWeekStrip', () => {
  it('rebuilds the window when a swipe settles near an edge and reinits onto the anchor', () => {
    const { result } = mountStrip()

    act(() => embla.settleAt(1))

    const browsedWeek = weekAtIndex(initialWindow, 1)
    const rebuilt = createWeekWindow(browsedWeek, WEEK_START)
    expect(result.current.weekWindow).toEqual(rebuilt)
    expect(embla.api.reInit).toHaveBeenCalledWith({ startIndex: rebuilt.anchorIndex })
    // The browsed week became the rebuilt window's anchor — still on screen.
    expect(result.current.displayedWeekStart).toBe(browsedWeek)
    expect(embla.api.scrollTo).not.toHaveBeenCalled()
  })

  it('leaves a mid-window settle alone', () => {
    const { result } = mountStrip()

    act(() => embla.settleAt(28))

    expect(result.current.weekWindow).toEqual(initialWindow)
    expect(result.current.displayedWeekStart).toBe(weekAtIndex(initialWindow, 28))
    expect(embla.api.reInit).not.toHaveBeenCalled()
  })

  it('follows an in-window date change without snapping back while browsing', () => {
    const { result, rerender } = mountStrip()

    // Browse two weeks ahead of the selection: the echo guard must keep the
    // re-render from scrolling the strip back to the (unchanged) date's week.
    act(() => embla.settleAt(28))
    expect(embla.api.scrollTo).not.toHaveBeenCalled()

    // A real date change is followed with a plain scroll — no rebuild.
    rerender({ date: '2026-06-19', weekStart: WEEK_START })
    expect(embla.api.scrollTo).toHaveBeenCalledWith(27)
    expect(result.current.displayedWeekStart).toBe(weekAtIndex(initialWindow, 27))
    expect(result.current.weekWindow).toEqual(initialWindow)
    expect(embla.api.reInit).not.toHaveBeenCalled()
  })

  it('showWeekOf scrolls to an in-window target', () => {
    const { result } = mountStrip()

    act(() => result.current.showWeekOf('2026-06-19'))

    expect(embla.api.scrollTo).toHaveBeenCalledWith(27)
    expect(result.current.displayedWeekStart).toBe(weekAtIndex(initialWindow, 27))
    expect(result.current.weekWindow).toEqual(initialWindow)
  })

  it('showWeekOf rebuilds the window around an out-of-window target', () => {
    const { result } = mountStrip()
    const target = '2027-06-12'
    expect(weekIndexOf(initialWindow, target, WEEK_START)).toBe(-1)

    act(() => result.current.showWeekOf(target))

    const rebuilt = createWeekWindow(target, WEEK_START)
    expect(result.current.weekWindow).toEqual(rebuilt)
    expect(embla.api.reInit).toHaveBeenCalledWith({ startIndex: rebuilt.anchorIndex })
    expect(result.current.displayedWeekStart).toBe(weekStartOf(target, WEEK_START))
    expect(embla.api.scrollTo).not.toHaveBeenCalled()
  })

  it('rebuilds around a far date change that falls outside the window', () => {
    const { result, rerender } = mountStrip()

    rerender({ date: '2027-06-12', weekStart: WEEK_START })

    const rebuilt = createWeekWindow('2027-06-12', WEEK_START)
    expect(result.current.weekWindow).toEqual(rebuilt)
    expect(embla.api.reInit).toHaveBeenCalledWith({ startIndex: rebuilt.anchorIndex })
    expect(result.current.displayedWeekStart).toBe(weekStartOf('2027-06-12', WEEK_START))
  })

  it('rebuilds when the week-start setting re-aligns the weeks', () => {
    const { result, rerender } = mountStrip()
    // The old window's Monday-aligned weeks no longer contain any
    // Sunday-start week — the misalignment signal a rebuild answers.
    expect(weekIndexOf(initialWindow, DATE, 'sunday')).toBe(-1)

    rerender({ date: DATE, weekStart: 'sunday' })

    const rebuilt = createWeekWindow(DATE, 'sunday')
    expect(result.current.weekWindow).toEqual(rebuilt)
    expect(embla.api.reInit).toHaveBeenCalledWith({ startIndex: rebuilt.anchorIndex })
    expect(result.current.displayedWeekStart).toBe(weekStartOf(DATE, 'sunday'))
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
