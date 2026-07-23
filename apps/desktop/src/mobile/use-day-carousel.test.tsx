import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDayWindow, dateAtIndex } from '@/lib/day-window'
import {
  CAROUSEL_RADIUS,
  reconcileCarousel,
  shouldRecenter,
  useDayCarousel,
  type ReconcileInput,
} from './use-day-carousel'

/**
 * The carousel's follow-the-route decision in isolation — Embla pointer
 * gestures can't be driven under jsdom, so the branchy reconciliation that the
 * integration test can only reach indirectly is pinned here as pure logic —
 * plus the hook's swipe wiring driven through a fake Embla API firing the
 * events a real gesture would.
 */
const embla = vi.hoisted(() => {
  const handlers = new Map<string, Set<(api: unknown) => void>>()
  let selected = 0
  const rootEl = document.createElement('div')

  const api = {
    selectedScrollSnap: (): number => selected,
    rootNode: (): HTMLElement => rootEl,
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
    scrollTo: vi.fn((index: number, jump?: boolean) => {
      const changed = selected !== index
      // Embla 8.6's instant path renders (and can emit `settle`) before it
      // updates the selected index and emits `select`. Model that re-entrancy:
      // a Today sync must ignore the old arrival's settle callback.
      if (changed && jump === true) {
        emit('settle')
      }
      selected = index
      if (changed) {
        emit('select')
      }
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
    /** Target `index` and fire select, as pointer-up does mid-animation. */
    selectAt(index: number): void {
      selected = index
      emit('select')
    },
    /** Land on `index` and fire select + settle, as a finished swipe would. */
    settleAt(index: number): void {
      selected = index
      emit('select')
      emit('settle')
    },
    /** Fire settle at the carousel's current target. */
    settle(): void {
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
    expect(reconcileCarousel({ ...base, date: '2026-06-01', reported: '2026-06-01' })).toEqual({
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
    expect(reconcileCarousel({ ...base, index: -1 })).toEqual({ action: 'none' })
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
  /** The anchor day sits at {@link CAROUSEL_RADIUS} — the window's center. */
  const DATE = '2026-06-12'
  const CENTER = CAROUSEL_RADIUS
  const NAVIGATION_KEY = `0:0:${DATE}`
  const initialWindow = createDayWindow(DATE, {
    past: CAROUSEL_RADIUS,
    future: CAROUSEL_RADIUS,
  })

  function mountCarousel() {
    const onSelect = vi.fn()
    const onTarget = vi.fn()
    const hook = renderHook(
      ({ date, navigationKey }) => useDayCarousel(date, navigationKey, onSelect, onTarget),
      {
        initialProps: { date: DATE, navigationKey: NAVIGATION_KEY },
      },
    )
    return { ...hook, onSelect, onTarget }
  }

  it('follows the swipe target at select, so the next neighbor mounts mid-animation', () => {
    const { result, onSelect } = mountCarousel()

    // Pointer-up: the target is known but the snap animation is still playing.
    act(() => embla.selectAt(CENTER + 1))

    expect(result.current.selectedIndex).toBe(CENTER + 1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('announces the target day at select, ahead of the settle-time report', () => {
    const { onTarget, onSelect } = mountCarousel()

    act(() => embla.selectAt(CENTER + 1))

    // The strip (and its month title) follow this while the snap animates;
    // the route only moves at settle.
    expect(onTarget).toHaveBeenCalledExactlyOnceWith('2026-06-13', NAVIGATION_KEY)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('reports the landed day only when the swipe settles', () => {
    const { result, onSelect } = mountCarousel()

    act(() => embla.settleAt(CENTER + 1))

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('2026-06-13')
    expect(result.current.selectedIndex).toBe(CENTER + 1)
  })

  it('leaves the carousel alone when the settled swipe echoes back as `date`', () => {
    const { rerender } = mountCarousel()
    act(() => embla.settleAt(CENTER + 1))

    rerender({ date: '2026-06-13', navigationKey: '1:1:2026-06-13' })

    expect(embla.api.scrollTo).not.toHaveBeenCalled()
    expect(embla.api.reInit).not.toHaveBeenCalled()
  })

  it('scrolls to an external in-window selection without reporting it back', () => {
    const { result, rerender, onSelect } = mountCarousel()

    rerender({ date: '2026-06-20', navigationKey: '1:1:2026-06-20' })

    expect(embla.api.scrollTo).toHaveBeenCalledExactlyOnceWith(CENTER + 8, true)
    expect(result.current.selectedIndex).toBe(CENTER + 8)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('cancels a pending swipe when Today re-arrives at the unchanged route date', () => {
    const { result, rerender, onSelect, onTarget } = mountCarousel()

    // Pointer-up has aimed away from Today, but the route is still Today until
    // Embla settles. This is the window in which the fading Today button can
    // be tapped.
    act(() => embla.selectAt(CENTER + 1))
    expect(result.current.selectedIndex).toBe(CENTER + 1)

    // The Today tap is a date-preserving router arrival. It must still issue
    // an instant horizontal sync, superseding the pending snap.
    rerender({ date: DATE, navigationKey: `0:1:${DATE}` })
    expect(embla.api.scrollTo).toHaveBeenCalledExactlyOnceWith(CENTER, true)
    expect(result.current.selectedIndex).toBe(CENTER)
    // The instant jump emitted stale settle/select events through the old
    // listener, but neither may publish another target or route selection.
    expect(onTarget).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()

    act(() => embla.settle())
    expect(onSelect).not.toHaveBeenCalled()
    expect(onTarget).toHaveBeenCalledTimes(1)
    expect(result.current.selectedIndex).toBe(CENTER)
  })

  it('re-centers the window when a swipe settles near an edge', () => {
    const { result, onSelect } = mountCarousel()
    const nearEnd = initialWindow.count - 10

    act(() => embla.settleAt(nearEnd))

    const landed = dateAtIndex(initialWindow, nearEnd)
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(landed)
    expect(result.current.dayWindow).toEqual(
      createDayWindow(landed, { past: CAROUSEL_RADIUS, future: CAROUSEL_RADIUS }),
    )
  })
})
