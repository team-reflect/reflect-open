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
    const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

    element.scrollLeft = 50

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    expect(watch.isUserScroll()).toBe(false)
  })

  it('waits for the finger to lift, then reports a user scroll', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

    await touch(element, 'start')
    await scrollElement({ element, left: 50 })
    expect(watch.isTouching()).toBe(true)
    expect(onSettle).not.toHaveBeenCalled()

    await touch(element, 'end')

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    expect(watch.isUserScroll()).toBe(true)
  })

  it('reports on touchend with no scroll after it once the element is settled', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    watchScrollSettle({
      element,
      onSettle,
      signal: listeners.controller.signal,
      isSettled: () => element.scrollLeft <= 1,
    })

    await touch(element, 'start')
    element.scrollLeft = 50
    await scrollElement({ element, left: 0 })
    // Longer than the quiet time, so only the touchend can report.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onSettle).not.toHaveBeenCalled()

    await touch(element, 'end')

    expect(onSettle).toHaveBeenCalledOnce()
  })

  it('reports a settled scroll at once, without the quiet time', () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    watchScrollSettle({
      element,
      onSettle,
      signal: listeners.controller.signal,
      isSettled: () => true,
    })

    element.dispatchEvent(new Event('scroll'))

    expect(onSettle).toHaveBeenCalledOnce()
  })

  it('does not report again when a settled snap moves on inside the settled range', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle({
      element,
      onSettle,
      signal: listeners.controller.signal,
      isSettled: () => element.scrollLeft <= 1,
    })

    await touch(element, 'start')
    element.scrollLeft = 50
    await touch(element, 'end')
    await scrollElement({ element, left: 1 })
    expect(onSettle).toHaveBeenCalledOnce()

    await scrollElement({ element, left: 0 })

    expect(onSettle).toHaveBeenCalledOnce()
    expect(watch.isUserScroll()).toBe(true)
  })

  it('reports a wheel scroll that comes right after an early report', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle({
      element,
      onSettle,
      signal: listeners.controller.signal,
      isSettled: () => element.scrollLeft <= 1,
    })
    element.scrollLeft = 50
    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    await scrollElement({ element, left: 1 })
    expect(onSettle).toHaveBeenCalledTimes(2)

    element.dispatchEvent(new WheelEvent('wheel', { deltaX: -1 }))
    await scrollElement({ element, left: 0 })

    expect(onSettle).toHaveBeenCalledTimes(3)
    expect(watch.isUserScroll()).toBe(true)
  })

  it('reports a scroll inside the settled range once the quiet time has passed', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle({
      element,
      onSettle,
      signal: listeners.controller.signal,
      isSettled: () => element.scrollLeft <= 1,
    })
    await scrollElement({ element, left: 1, touch: true })
    expect(onSettle).toHaveBeenCalledOnce()

    await new Promise((resolve) => setTimeout(resolve, 200))
    await scrollElement({ element, left: 0 })

    expect(onSettle).toHaveBeenCalledTimes(2)
    expect(watch.isUserScroll()).toBe(false)
  })

  it('does not count a scroll right after a tap as the finger’s', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

    // A tap that focuses a field, then the focus scroll.
    await touch(element, 'start')
    await touch(element, 'end')
    await scrollElement({ element, left: 50 })

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    expect(watch.isUserScroll()).toBe(false)
  })

  it('counts a wheel scroll as a user scroll', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

    element.dispatchEvent(new WheelEvent('wheel', { deltaX: 50 }))
    await scrollElement({ element, left: 50 })

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    expect(watch.isUserScroll()).toBe(true)
  })

  describe('mouse drag', () => {
    // The drag axis comes from `scroll-snap-type`, set by a class as in the app.
    function mountSnapScroller(): HTMLElement {
      const style = document.createElement('style')
      style.textContent = '.snap-x { scroll-snap-type: x mandatory }'
      const element = mountScroller()
      element.className = 'snap-x'
      document.head.append(style)
      listeners.controller.signal.addEventListener('abort', () => style.remove())
      return element
    }

    function mouse(type: string, target: EventTarget, clientX: number): void {
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', clientX }),
      )
    }

    it('scrolls with the mouse, then settles at the nearer end as a user scroll', async () => {
      const element = mountSnapScroller()
      const onSettle = vi.fn()
      const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

      mouse('pointerdown', element, 200)
      mouse('pointermove', window, 150)
      await vi.waitFor(() => expect(element.scrollLeft).toBe(50))
      expect(element.style.scrollSnapType).toBe('none')
      expect(watch.isTouching()).toBe(true)
      // Past half of the 200px range.
      mouse('pointermove', window, 80)
      mouse('pointerup', window, 80)
      const onClick = vi.fn()
      element.addEventListener('click', onClick)
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      element.dispatchEvent(click)

      expect(click.defaultPrevented).toBe(true)
      expect(onClick).not.toHaveBeenCalled()
      expect(element.style.scrollSnapType).toBe('')
      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
      expect(element.scrollLeft).toBe(200)
      expect(watch.isUserScroll()).toBe(true)
      expect(watch.isTouching()).toBe(false)
    })

    it('leaves a click under the drag distance alone', async () => {
      const element = mountSnapScroller()
      const onSettle = vi.fn()
      watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })
      const onClick = vi.fn((event: MouseEvent) => event.defaultPrevented)

      mouse('pointerdown', element, 200)
      mouse('pointermove', window, 198)
      mouse('pointerup', window, 198)
      element.addEventListener('click', onClick)
      element.click()

      expect(element.scrollLeft).toBe(0)
      expect(onClick).toHaveReturnedWith(false)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(onSettle).not.toHaveBeenCalled()
    })

    it('does not count a later scroll as the user’s after a drag that moved nothing', async () => {
      const element = mountSnapScroller()
      const onSettle = vi.fn()
      const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

      // Already at the start: dragging right cannot scroll.
      mouse('pointerdown', element, 100)
      mouse('pointermove', window, 150)
      mouse('pointerup', window, 150)
      await vi.waitFor(() => expect(watch.isTouching()).toBe(false))
      await scrollElement({ element, left: 50 })

      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
      expect(watch.isUserScroll()).toBe(false)
    })

    it('stops following the mouse when the watch aborts mid-drag', () => {
      const element = mountSnapScroller()
      watchScrollSettle({ element, onSettle: vi.fn(), signal: listeners.controller.signal })

      mouse('pointerdown', element, 200)
      mouse('pointermove', window, 150)
      listeners.controller.abort()
      const left = element.scrollLeft
      mouse('pointermove', window, 50)

      expect(element.scrollLeft).toBe(left)
      expect(element.style.scrollSnapType).toBe('')
    })

    it('lets a new press take over from a release scroll', async () => {
      const element = mountSnapScroller()
      const onSettle = vi.fn()
      const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

      mouse('pointerdown', element, 200)
      mouse('pointermove', window, 150)
      mouse('pointerup', window, 150)
      // A second press during the release scroll.
      mouse('pointerdown', element, 150)
      mouse('pointermove', window, 100)
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(watch.isTouching()).toBe(true)
      expect(onSettle).not.toHaveBeenCalled()
      mouse('pointerup', window, 100)
      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
      expect(watch.isUserScroll()).toBe(true)
    })

    it('starts a drag only on the drag handle', () => {
      const element = mountSnapScroller()
      const handle = document.createElement('div')
      element.firstElementChild!.append(handle)
      watchScrollSettle({
        element,
        onSettle: vi.fn(),
        signal: listeners.controller.signal,
        dragHandle: handle,
      })

      mouse('pointerdown', element, 200)
      mouse('pointermove', window, 150)
      mouse('pointerup', window, 150)
      expect(element.scrollLeft).toBe(0)

      mouse('pointerdown', handle, 200)
      mouse('pointermove', window, 150)

      expect(element.scrollLeft).toBe(50)
    })

    it('starts no drag on a text field', () => {
      const element = mountSnapScroller()
      const field = document.createElement('input')
      element.firstElementChild!.append(field)
      watchScrollSettle({ element, onSettle: vi.fn(), signal: listeners.controller.signal })

      mouse('pointerdown', field, 200)
      mouse('pointermove', window, 100)

      expect(element.scrollLeft).toBe(0)
    })
  })

  it('stops reporting after abort', async () => {
    const element = mountScroller()
    const onSettle = vi.fn()
    watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })
    listeners.controller.abort()

    element.scrollLeft = 50

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onSettle).not.toHaveBeenCalled()
  })
})
