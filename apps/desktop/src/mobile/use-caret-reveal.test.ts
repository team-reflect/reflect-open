import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVEAL_WINDOW_MS, useCaretReveal } from './use-caret-reveal'

/**
 * The end-of-note reveal in isolation (extracted from DaySlide). jsdom has no
 * layout, so the container is faked with a controllable scroll range and a
 * hand-fired ResizeObserver — the same harness as use-scroll-restore. The
 * contract under test: the double-tap's caret lands at the note's end before
 * the iOS keyboard reports its height, so the reveal must re-pin the
 * container to its end as it shrinks, then get out of the user's way.
 */

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  readonly observed: Element[] = []
  disconnected = false

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
  }

  takeRecords(): [] {
    return []
  }

  /** Simulate a resize notification (real observers go quiet once disconnected). */
  resize(): void {
    if (!this.disconnected) {
      this.callback([], this as unknown as ResizeObserver)
    }
  }
}

/** The single observer the active reveal created, or `undefined`. */
function observer(): FakeResizeObserver | undefined {
  return FakeResizeObserver.instances[0]
}

interface FakeScrollable {
  element: HTMLDivElement
  /** Change the scrollable range, as a keyboard raise (shrink) would. */
  setScrollRange: (options: { scrollHeight: number; maxScrollTop: number }) => void
}

function createScrollable(scrollHeight: number, maxScrollTop: number): FakeScrollable {
  const element = document.createElement('div')
  let height = scrollHeight
  let max = maxScrollTop
  let top = 0
  Object.defineProperty(element, 'scrollHeight', {
    get: () => height,
  })
  Object.defineProperty(element, 'scrollTop', {
    get: () => top,
    set: (value: number) => {
      top = Math.min(Math.max(value, 0), max)
    },
  })
  return {
    element,
    setScrollRange: (options) => {
      height = options.scrollHeight
      max = options.maxScrollTop
      top = Math.min(top, max)
    },
  }
}

function mountReveal(options: { scrollHeight: number; maxScrollTop: number }) {
  const scrollable = createScrollable(options.scrollHeight, options.maxScrollTop)
  const content = document.createElement('div')
  scrollable.element.appendChild(content)
  const containerRef = { current: scrollable.element }
  const contentRef = { current: content }
  const hook = renderHook(() => useCaretReveal({ containerRef, contentRef }))
  return { scrollable, content, hook }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useCaretReveal', () => {
  it('pins the container to its end immediately and re-pins as it shrinks', () => {
    const { scrollable, content, hook } = mountReveal({ scrollHeight: 900, maxScrollTop: 400 })

    hook.result.current.revealEnd()
    expect(scrollable.element.scrollTop).toBe(400)
    expect(observer()?.observed).toContain(scrollable.element)
    expect(observer()?.observed).toContain(content)

    // The keyboard raises: the shell (and the container) shrink by its
    // height, so the reachable range grows and the end drops out of view.
    scrollable.setScrollRange({ scrollHeight: 900, maxScrollTop: 716 })
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(716)
  })

  it('re-pins on late content growth (images sizing in)', () => {
    const { scrollable, hook } = mountReveal({ scrollHeight: 900, maxScrollTop: 400 })

    hook.result.current.revealEnd()
    scrollable.setScrollRange({ scrollHeight: 1300, maxScrollTop: 800 })
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(800)
  })

  it('ends the reveal at the deadline — later resizes leave the user alone', () => {
    const { scrollable, hook } = mountReveal({ scrollHeight: 900, maxScrollTop: 400 })

    hook.result.current.revealEnd()
    vi.advanceTimersByTime(REVEAL_WINDOW_MS)
    expect(observer()?.disconnected).toBe(true)

    scrollable.element.scrollTop = 100
    scrollable.setScrollRange({ scrollHeight: 900, maxScrollTop: 716 })
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(100)
  })

  it('hands control to the user on pointerdown', () => {
    const { scrollable, hook } = mountReveal({ scrollHeight: 900, maxScrollTop: 400 })

    hook.result.current.revealEnd()
    scrollable.element.dispatchEvent(new Event('pointerdown'))
    expect(observer()?.disconnected).toBe(true)

    scrollable.element.scrollTop = 100
    scrollable.setScrollRange({ scrollHeight: 900, maxScrollTop: 716 })
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(100)
  })

  it('restarts the window when called again, replacing the old reveal', () => {
    const { scrollable, hook } = mountReveal({ scrollHeight: 900, maxScrollTop: 400 })

    hook.result.current.revealEnd()
    const first = observer()
    hook.result.current.revealEnd()
    expect(first?.disconnected).toBe(true)
    expect(FakeResizeObserver.instances).toHaveLength(2)

    scrollable.setScrollRange({ scrollHeight: 900, maxScrollTop: 716 })
    FakeResizeObserver.instances[1]?.resize()
    expect(scrollable.element.scrollTop).toBe(716)
  })

  it('cancelReveal ends an active reveal without touching the scroll position', () => {
    const { scrollable, hook } = mountReveal({ scrollHeight: 900, maxScrollTop: 400 })

    hook.result.current.revealEnd()
    expect(scrollable.element.scrollTop).toBe(400)
    hook.result.current.cancelReveal()
    expect(observer()?.disconnected).toBe(true)
    expect(scrollable.element.scrollTop).toBe(400)

    // An explicit jump-to-top after the cancel must stick: no late re-pin
    // when the keyboard dismisses or content grows, and no live deadline.
    scrollable.element.scrollTop = 0
    scrollable.setScrollRange({ scrollHeight: 900, maxScrollTop: 716 })
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(0)
    vi.advanceTimersByTime(REVEAL_WINDOW_MS)
    expect(scrollable.element.scrollTop).toBe(0)
  })

  it('stops the reveal on unmount', () => {
    const { scrollable, hook } = mountReveal({ scrollHeight: 900, maxScrollTop: 400 })

    hook.result.current.revealEnd()
    hook.unmount()
    expect(observer()?.disconnected).toBe(true)

    scrollable.element.scrollTop = 100
    scrollable.setScrollRange({ scrollHeight: 900, maxScrollTop: 716 })
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(100)
  })
})
