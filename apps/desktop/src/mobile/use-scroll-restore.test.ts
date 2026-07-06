import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIEvent } from 'react'
import { RESTORE_DEADLINE_MS, useScrollRestore } from './use-scroll-restore'

/**
 * The remount scroll-restore loop in isolation (extracted from DaySlide).
 * jsdom has no layout, so both moving parts are faked and driven by hand: a
 * container whose `scrollTop` clamps to a controllable maximum (the real
 * reason a one-shot restore fails while content is still loading), and a
 * ResizeObserver the tests fire to simulate content growth. Both PR #475
 * review findings — a restore that never finishes, and a jump-to-top reset
 * racing an in-flight restore — live in this contract.
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

  /** Simulate a content-growth notification (real observers go quiet once disconnected). */
  resize(): void {
    if (!this.disconnected) {
      this.callback([], this as unknown as ResizeObserver)
    }
  }
}

/** The single observer the mounted restore created, or `undefined`. */
function observer(): FakeResizeObserver | undefined {
  return FakeResizeObserver.instances[0]
}

interface FakeScrollable {
  element: HTMLDivElement
  /** Raise (or lower) the reachable scroll range, as content growth would. */
  setMaxScrollTop: (value: number) => void
}

function createScrollable(maxScrollTop: number): FakeScrollable {
  const element = document.createElement('div')
  let max = maxScrollTop
  let top = 0
  Object.defineProperty(element, 'scrollTop', {
    get: () => top,
    set: (value: number) => {
      top = Math.min(Math.max(value, 0), max)
    },
  })
  return {
    element,
    setMaxScrollTop: (value: number) => {
      max = value
      top = Math.min(top, max)
    },
  }
}

function scrollEventOn(element: HTMLElement): UIEvent<HTMLElement> {
  return { currentTarget: element } as unknown as UIEvent<HTMLElement>
}

const KEY = '2026-06-12'

interface MountOptions {
  /** The remembered offset to restore; omitted = a fresh, never-scrolled day. */
  saved?: number
  /** The initially reachable scroll range (content still loading). */
  maxScrollTop?: number
}

function mountRestore(options: MountOptions = {}) {
  const memory = new Map<string, number>()
  if (options.saved !== undefined) {
    memory.set(KEY, options.saved)
  }
  const scrollable = createScrollable(options.maxScrollTop ?? 0)
  const content = document.createElement('div')
  scrollable.element.appendChild(content)
  const containerRef = { current: scrollable.element }
  const contentRef = { current: content }
  const hook = renderHook(() => useScrollRestore({ key: KEY, memory, containerRef, contentRef }))
  return { memory, scrollable, content, hook }
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

describe('useScrollRestore', () => {
  it('re-applies the saved offset as content grows until it is reachable', () => {
    const { memory, scrollable, content, hook } = mountRestore({ saved: 500, maxScrollTop: 100 })

    // The mount-time apply was clamped, so the restore stays armed: watching
    // the content, offset untouched in memory.
    expect(scrollable.element.scrollTop).toBe(100)
    expect(observer()?.observed).toContain(content)
    expect(observer()?.disconnected).toBe(false)

    scrollable.setMaxScrollTop(300)
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(300)
    expect(observer()?.disconnected).toBe(false)

    scrollable.setMaxScrollTop(1200)
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(500)
    expect(observer()?.disconnected).toBe(true)
    expect(memory.get(KEY)).toBe(500)

    // With the restore finished, ordinary scrolling records again.
    scrollable.element.scrollTop = 320
    hook.result.current.handleScroll(scrollEventOn(scrollable.element))
    expect(memory.get(KEY)).toBe(320)
  })

  it('does not let the restore’s clamped scrolls overwrite the saved offset', () => {
    const { memory, scrollable, hook } = mountRestore({ saved: 500, maxScrollTop: 100 })

    // The browser fires a scroll event for the clamped mount-time apply —
    // recording it would truncate the memory to 100 and the restore would
    // converge on the wrong offset.
    hook.result.current.handleScroll(scrollEventOn(scrollable.element))
    expect(memory.get(KEY)).toBe(500)
  })

  it('gives up at the deadline when the offset never becomes reachable', () => {
    const { memory, scrollable, hook } = mountRestore({ saved: 500, maxScrollTop: 100 })

    vi.advanceTimersByTime(RESTORE_DEADLINE_MS)
    expect(observer()?.disconnected).toBe(true)
    expect(scrollable.element.scrollTop).toBe(100)

    // The user's scrolling takes over — and late content growth must not
    // yank the container back to the stale offset.
    scrollable.element.scrollTop = 40
    hook.result.current.handleScroll(scrollEventOn(scrollable.element))
    expect(memory.get(KEY)).toBe(40)
    scrollable.setMaxScrollTop(1000)
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(40)
  })

  it('hands control to the user on pointerdown', () => {
    const { memory, scrollable, hook } = mountRestore({ saved: 500, maxScrollTop: 100 })

    scrollable.element.dispatchEvent(new Event('pointerdown'))
    expect(observer()?.disconnected).toBe(true)

    // The touch's drag records immediately, and the deadline timer is dead.
    scrollable.element.scrollTop = 40
    hook.result.current.handleScroll(scrollEventOn(scrollable.element))
    expect(memory.get(KEY)).toBe(40)
    vi.advanceTimersByTime(RESTORE_DEADLINE_MS)
    expect(scrollable.element.scrollTop).toBe(40)
  })

  it('resetToTop cancels an in-flight restore before jumping to the top', () => {
    const { memory, scrollable, hook } = mountRestore({ saved: 500, maxScrollTop: 100 })

    hook.result.current.resetToTop()
    expect(scrollable.element.scrollTop).toBe(0)
    expect(memory.has(KEY)).toBe(false)

    // The observer must already be dead: content growth after the reset would
    // otherwise re-apply the forgotten offset and undo the jump.
    scrollable.setMaxScrollTop(1000)
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(0)

    scrollable.element.scrollTop = 10
    hook.result.current.handleScroll(scrollEventOn(scrollable.element))
    expect(memory.get(KEY)).toBe(10)
  })

  it('cancelRestore ends the chase without touching the scroll or the memory', () => {
    const { memory, scrollable, hook } = mountRestore({ saved: 500, maxScrollTop: 100 })

    // An end-of-note focus arrival (the double-tap) pins the container to its
    // end; the chase must die in place — its next content-growth re-apply
    // would yank the caret back to the stale offset.
    hook.result.current.cancelRestore()
    expect(scrollable.element.scrollTop).toBe(100)
    expect(memory.get(KEY)).toBe(500)
    expect(observer()?.disconnected).toBe(true)

    scrollable.setMaxScrollTop(1000)
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(100)

    // Scrolling records normally afterwards (the reveal's pins included).
    scrollable.element.scrollTop = 900
    hook.result.current.handleScroll(scrollEventOn(scrollable.element))
    expect(memory.get(KEY)).toBe(900)
  })

  it('restores a reachable offset synchronously without arming the machinery', () => {
    const { scrollable } = mountRestore({ saved: 80, maxScrollTop: 100 })

    expect(scrollable.element.scrollTop).toBe(80)
    expect(FakeResizeObserver.instances).toHaveLength(0)
  })

  it('does nothing on a fresh mount with no saved offset', () => {
    const { memory, scrollable, hook } = mountRestore({ maxScrollTop: 100 })

    expect(scrollable.element.scrollTop).toBe(0)
    expect(FakeResizeObserver.instances).toHaveLength(0)

    scrollable.element.scrollTop = 25
    hook.result.current.handleScroll(scrollEventOn(scrollable.element))
    expect(memory.get(KEY)).toBe(25)
  })

  it('stops the restore on unmount', () => {
    const { scrollable, hook } = mountRestore({ saved: 500, maxScrollTop: 100 })

    hook.unmount()
    expect(observer()?.disconnected).toBe(true)
    scrollable.setMaxScrollTop(1000)
    observer()?.resize()
    expect(scrollable.element.scrollTop).toBe(100)
  })
})
