import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchScrollSettle } from '@/lib/scroll-settle.ts'
import { scrollElement, touch } from '@/test-utils/scroll.ts'

/**
 * Settle reports for a native scroller: one report per scroll, never while a
 * finger is down, at once where the caller can tell the scroll is over, and a
 * record of whether a finger or a wheel started the scroll.
 */

const listeners = { controller: new AbortController() }

function mountScroller(): HTMLElement {
  const element = document.createElement('div')
  element.style.cssText = 'width: 100px; height: 20px; overflow-x: auto'
  element.innerHTML = '<div style="width: 300px; height: 10px"></div>'
  document.body.append(element)
  return element
}

afterEach(() => {
  listeners.controller.abort()
  listeners.controller = new AbortController()
  document.body.replaceChildren()
})

describe('watchScrollSettle', () => {
  it('reports once after a scroll that no finger started', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle(element, onSettle, listeners.controller.signal)

    element.scrollLeft = 50

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    expect(watch.isUserScroll()).toBe(false)
  })

  it('waits for the finger to lift, then reports a user scroll', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle(element, onSettle, listeners.controller.signal)

    await touch(element, 'start')
    await scrollElement(element, { left: 50 })
    expect(watch.isTouching()).toBe(true)
    expect(onSettle).not.toHaveBeenCalled()

    await touch(element, 'end')

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    expect(watch.isUserScroll()).toBe(true)
  })

  it('reports on touchend with no scroll after it once the element is settled', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    watchScrollSettle(element, onSettle, listeners.controller.signal, {
      isSettled: () => element.scrollLeft <= 1,
    })

    await touch(element, 'start')
    element.scrollLeft = 50
    await scrollElement(element, { left: 0 })
    // Longer than the quiet time, so only the touchend can report.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onSettle).not.toHaveBeenCalled()

    await touch(element, 'end')

    expect(onSettle).toHaveBeenCalledOnce()
  })

  it('reports a settled scroll at once, without the quiet time', () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    watchScrollSettle(element, onSettle, listeners.controller.signal, { isSettled: () => true })

    element.dispatchEvent(new Event('scroll'))

    expect(onSettle).toHaveBeenCalledOnce()
  })

  it('does not report again when a settled snap moves on inside the settled range', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle(element, onSettle, listeners.controller.signal, {
      isSettled: () => element.scrollLeft <= 1,
    })

    await touch(element, 'start')
    element.scrollLeft = 50
    await touch(element, 'end')
    await scrollElement(element, { left: 1 })
    expect(onSettle).toHaveBeenCalledOnce()

    await scrollElement(element, { left: 0 })

    expect(onSettle).toHaveBeenCalledOnce()
    expect(watch.isUserScroll()).toBe(true)
  })

  it('does not count a scroll right after a tap as the finger’s', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle(element, onSettle, listeners.controller.signal)

    // A tap that focuses a field, then the focus scroll.
    await touch(element, 'start')
    await touch(element, 'end')
    await scrollElement(element, { left: 50 })

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    expect(watch.isUserScroll()).toBe(false)
  })

  it('counts a wheel scroll as a user scroll', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle(element, onSettle, listeners.controller.signal)

    element.dispatchEvent(new WheelEvent('wheel', { deltaX: 50 }))
    await scrollElement(element, { left: 50 })

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    expect(watch.isUserScroll()).toBe(true)
  })

  it('stops reporting after abort', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    watchScrollSettle(element, onSettle, listeners.controller.signal)
    listeners.controller.abort()

    element.scrollLeft = 50

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onSettle).not.toHaveBeenCalled()
  })
})
