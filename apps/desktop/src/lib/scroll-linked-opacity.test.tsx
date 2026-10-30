import { afterEach, describe, expect, it, vi } from 'vitest'
import { linkOpacityToScroll } from '@/lib/scroll-linked-opacity.ts'
import { scrollElement } from '@/test-utils/scroll.ts'

const listeners = { controller: new AbortController() }

function mount(axis: 'x' | 'y'): {
  scroller: HTMLElement
  content: HTMLElement
  target: HTMLElement
} {
  const scroller = document.createElement('div')
  scroller.style.cssText =
    axis === 'x' ? 'width: 100px; overflow-x: auto' : 'height: 100px; overflow-y: auto'
  const content = document.createElement('div')
  content.style.cssText = axis === 'x' ? 'width: 300px; height: 10px' : 'height: 300px'
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

describe('linkOpacityToScroll', () => {
  const native = typeof ScrollTimeline === 'function'

  it.skipIf(!native)('follows the scroll position between `from` and `to`', async () => {
    const { scroller, target } = mount('y')
    linkOpacityToScroll({
      target,
      scroller,
      axis: 'y',
      from: 0.2,
      to: 1,
      signal: listeners.controller.signal,
    })
    await vi.waitFor(() => expect(opacity(target)).toBeCloseTo(0.2, 2))

    // Halfway through the 200px range.
    await scrollElement(scroller, { top: 100 })

    await vi.waitFor(() => expect(opacity(target)).toBeCloseTo(0.6, 2))
  })

  it.skipIf(!native)('follows the horizontal scroll position on the x axis', async () => {
    const { scroller, target } = mount('x')
    linkOpacityToScroll({
      target,
      scroller,
      axis: 'x',
      from: 0,
      to: 1,
      signal: listeners.controller.signal,
    })
    await vi.waitFor(() => expect(opacity(target)).toBe(0))

    await scrollElement(scroller, { left: 50 })

    await vi.waitFor(() => expect(opacity(target)).toBeCloseTo(0.25, 2))
  })

  it.skipIf(!native)('follows a scroll range that grows with no scroll', async () => {
    const { scroller, content, target } = mount('y')
    linkOpacityToScroll({
      target,
      scroller,
      axis: 'y',
      from: 0,
      to: 1,
      signal: listeners.controller.signal,
    })
    await scrollElement(scroller, { top: 100 })
    await vi.waitFor(() => expect(opacity(target)).toBeCloseTo(0.5, 2))

    // The range becomes 400px; the position stays at 100px.
    content.style.height = '500px'

    await vi.waitFor(() => expect(opacity(target)).toBeCloseTo(0.25, 2))
  })

  it.skipIf(!native)('hands the opacity back to the stylesheet on abort', async () => {
    const { scroller, target } = mount('y')
    linkOpacityToScroll({
      target,
      scroller,
      axis: 'y',
      from: 0,
      to: 1,
      signal: listeners.controller.signal,
    })
    await vi.waitFor(() => expect(opacity(target)).toBe(0))

    listeners.controller.abort()

    await vi.waitFor(() => expect(opacity(target)).toBe(1))
  })

  it('does nothing when the signal has already aborted', () => {
    const { scroller, target } = mount('y')
    listeners.controller.abort()

    linkOpacityToScroll({
      target,
      scroller,
      axis: 'y',
      from: 0,
      to: 1,
      signal: listeners.controller.signal,
    })

    expect(target.getAnimations()).toHaveLength(0)
    expect(opacity(target)).toBe(1)
  })

  it('does nothing when the engine has no `ScrollTimeline`', () => {
    vi.stubGlobal('ScrollTimeline', undefined)
    const { scroller, target } = mount('y')

    linkOpacityToScroll({
      target,
      scroller,
      axis: 'y',
      from: 0,
      to: 1,
      signal: listeners.controller.signal,
    })

    expect(target.getAnimations()).toHaveLength(0)
    expect(opacity(target)).toBe(1)
  })
})
