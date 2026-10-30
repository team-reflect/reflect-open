import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkOpacityToScroll } from '@/lib/scroll-linked-opacity.ts'
import { scrollElement } from '@/test-utils/scroll.ts'

/**
 * Scroll-linked opacity on both paths: the engine's `ScrollTimeline` where it
 * exists, and the `scroll` listener that iOS 16 to 25 runs.
 */

const listeners = { controller: new AbortController() }

function mount(): { scroller: HTMLElement; content: HTMLElement; target: HTMLElement } {
  const scroller = document.createElement('div')
  scroller.style.cssText = 'height: 100px; overflow-y: auto'
  const content = document.createElement('div')
  content.style.height = '300px'
  scroller.append(content)
  // Outside the scroller.
  const target = document.createElement('div')
  document.body.append(target, scroller)
  return { scroller, content, target }
}

function opacity(element: HTMLElement): number {
  return Number(getComputedStyle(element).opacity)
}

afterEach(() => {
  listeners.controller.abort()
  listeners.controller = new AbortController()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe.each([
  { path: 'ScrollTimeline', available: typeof ScrollTimeline === 'function', stub: false },
  { path: 'scroll listener', available: true, stub: true },
])('linkOpacityToScroll ($path)', ({ available, stub }) => {
  beforeEach(() => {
    if (stub) {
      vi.stubGlobal('ScrollTimeline', undefined)
    }
  })

  it.skipIf(!available)('follows the scroll position between `from` and `to`', async () => {
    const { scroller, target } = mount()
    linkOpacityToScroll(
      target,
      scroller,
      { axis: 'y', from: 0.2, to: 1 },
      listeners.controller.signal,
    )
    await vi.waitFor(() => expect(opacity(target)).toBeCloseTo(0.2, 2))

    // Halfway through the 200px range.
    await scrollElement(scroller, { top: 100 })

    await vi.waitFor(() => expect(opacity(target)).toBeCloseTo(0.6, 2))
  })

  it.skipIf(!available)('follows a scroll range that grows with no scroll', async () => {
    const { scroller, content, target } = mount()
    linkOpacityToScroll(
      target,
      scroller,
      { axis: 'y', from: 0, to: 1 },
      listeners.controller.signal,
    )
    await scrollElement(scroller, { top: 100 })
    await vi.waitFor(() => expect(opacity(target)).toBeCloseTo(0.5, 2))

    // The range becomes 400px; the position stays at 100px.
    content.style.height = '500px'

    await vi.waitFor(() => expect(opacity(target)).toBeCloseTo(0.25, 2))
  })

  it.skipIf(!available)('hands the opacity back to the stylesheet on abort', async () => {
    const { scroller, target } = mount()
    linkOpacityToScroll(
      target,
      scroller,
      { axis: 'y', from: 0, to: 1 },
      listeners.controller.signal,
    )
    await vi.waitFor(() => expect(opacity(target)).toBe(0))

    listeners.controller.abort()

    await vi.waitFor(() => expect(opacity(target)).toBe(1))
  })
})
