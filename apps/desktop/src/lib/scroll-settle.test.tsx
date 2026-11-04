import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { mouse } from 'vitest-browser-commands/playwright'
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

    await userEvent.wheel(element, { delta: { x: -1 } })

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(3))
    expect(element.scrollLeft).toBe(0)
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

    await userEvent.wheel(element, { delta: { x: 50 } })

    await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
    expect(element.scrollLeft).toBe(50)
    expect(watch.isUserScroll()).toBe(true)
  })

  it('does not count a keyboard scroll as a user scroll', async () => {
    // Vertical, because WebKit has no keyboard scroll on the x axis.
    const element = mountScroller()
    element.style.cssText = 'width: 100px; height: 100px; overflow-y: auto'
    element.innerHTML = '<div style="height: 1000px"></div>'
    element.tabIndex = 0
    const onSettle = vi.fn()
    const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

    element.focus()
    await userEvent.keyboard('{PageDown}')

    // WebKit reports a `scrollend` after each step of a keyboard scroll, so
    // there can be more than one report.
    await vi.waitFor(() => expect(onSettle).toHaveBeenCalled())
    expect(element.scrollTop).toBeGreaterThan(0)
    expect(watch.isUserScroll()).toBe(false)
  })

  describe('mouse drag', () => {
    // The drag axis comes from `scroll-snap-type`, set by a class as in the app.
    // The 150px range is short enough that one drag across the element passes
    // half of it.
    function mountSnapScroller(): HTMLElement {
      const style = document.createElement('style')
      style.textContent = '.snap-x { scroll-snap-type: x mandatory }'
      const element = mountScroller()
      element.className = 'snap-x'
      // Snap targets at both ends of the range, as in a drawer.
      element.innerHTML = `
        <div style="position: relative; width: 250px; height: 10px">
          <i style="position: absolute; left: 0; width: 1px; scroll-snap-align: start"></i>
          <i style="position: absolute; left: 150px; width: 1px; scroll-snap-align: start"></i>
        </div>`
      document.head.append(style)
      listeners.controller.signal.addEventListener('abort', () => style.remove())
      return element
    }

    // Moves the real mouse to `x` px from the left edge of `element`.
    async function mouseTo(element: Element, x: number): Promise<void> {
      const box = element.getBoundingClientRect()
      await mouse.move(box.left + x, box.top + 5, { steps: 5 })
    }

    it('scrolls with the mouse, then settles at the nearer end as a user scroll', async () => {
      const element = mountSnapScroller()
      const onSettle = vi.fn()
      const onClick = vi.fn()
      element.addEventListener('click', onClick)
      const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

      await mouseTo(element, 95)
      await mouse.down()
      await mouseTo(element, 45)
      expect(element.scrollLeft).toBe(50)
      expect(element.style.scrollSnapType).toBe('none')
      expect(watch.isTouching()).toBe(true)
      // Past half of the range.
      await mouseTo(element, 5)
      await mouse.up()

      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
      expect(element.style.scrollSnapType).toBe('')
      expect(element.scrollLeft).toBe(150)
      expect(watch.isUserScroll()).toBe(true)
      expect(watch.isTouching()).toBe(false)
      expect(onClick).not.toHaveBeenCalled()
    })

    it('leaves a click under the drag distance alone', async () => {
      const element = mountSnapScroller()
      const onSettle = vi.fn()
      const onClick = vi.fn((event: MouseEvent) => event.defaultPrevented)
      element.addEventListener('click', onClick)
      watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

      await mouseTo(element, 50)
      await mouse.down()
      await mouseTo(element, 48)
      await mouse.up()

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
      await mouseTo(element, 10)
      await mouse.down()
      await mouseTo(element, 60)
      await mouse.up()
      await vi.waitFor(() => expect(watch.isTouching()).toBe(false))
      await scrollElement({ element, left: 150 })

      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
      expect(watch.isUserScroll()).toBe(false)
    })

    it('stops following the mouse when the watch aborts mid-drag', async () => {
      const element = mountSnapScroller()
      watchScrollSettle({ element, onSettle: vi.fn(), signal: listeners.controller.signal })

      await mouseTo(element, 95)
      await mouse.down()
      await mouseTo(element, 45)
      listeners.controller.abort()
      const left = element.scrollLeft
      await mouseTo(element, 5)
      await mouse.up()

      expect(element.scrollLeft).toBe(left)
      expect(element.style.scrollSnapType).toBe('')
    })

    it('lets a new press take over from a release scroll', async () => {
      const element = mountSnapScroller()
      const onSettle = vi.fn()
      const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

      await mouseTo(element, 95)
      await mouse.down()
      await mouseTo(element, 45)
      await mouse.up()
      // A second press during the release scroll.
      await mouse.down()
      await mouseTo(element, 5)
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(watch.isTouching()).toBe(true)
      expect(onSettle).not.toHaveBeenCalled()
      await mouse.up()
      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
      expect(watch.isUserScroll()).toBe(true)
    })

    it('ends a drag on `pointercancel`', async () => {
      const element = mountSnapScroller()
      const onSettle = vi.fn()
      const watch = watchScrollSettle({ element, onSettle, signal: listeners.controller.signal })

      await mouseTo(element, 95)
      await mouse.down()
      await mouseTo(element, 45)
      // A real mouse cannot cancel its pointer.
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'mouse' }))

      await vi.waitFor(() => expect(onSettle).toHaveBeenCalledOnce())
      expect(watch.isTouching()).toBe(false)
      expect(element.style.scrollSnapType).toBe('')
      await mouse.up()
    })

    it('stops following the mouse once the button is up', async () => {
      const element = mountSnapScroller()
      watchScrollSettle({ element, onSettle: vi.fn(), signal: listeners.controller.signal })

      await mouseTo(element, 95)
      await mouse.down()
      await mouseTo(element, 45)
      await mouse.up()
      const scrollTo = vi.spyOn(element, 'scrollTo')
      await mouseTo(element, 5)

      expect(scrollTo).not.toHaveBeenCalled()
    })

    it('starts a drag only on the drag handle', async () => {
      const element = mountSnapScroller()
      const handle = document.createElement('div')
      handle.style.cssText = 'width: 20px; height: 10px; margin-left: 80px'
      element.firstElementChild!.append(handle)
      watchScrollSettle({
        element,
        onSettle: vi.fn(),
        signal: listeners.controller.signal,
        dragHandle: handle,
      })

      await mouseTo(element, 50)
      await mouse.down()
      await mouseTo(element, 5)
      await mouse.up()
      expect(element.scrollLeft).toBe(0)

      await mouseTo(element, 90)
      await mouse.down()
      await mouseTo(element, 40)

      expect(element.scrollLeft).toBe(50)
      await mouse.up()
    })

    it('leaves the press to a control, so it still gets `mousedown`', async () => {
      const element = mountSnapScroller()
      const control = document.createElement('button')
      control.style.cssText = 'display: block; width: 100px; height: 10px; padding: 0; border: 0'
      element.firstElementChild!.append(control)
      const onMouseDown = vi.fn()
      control.addEventListener('mousedown', onMouseDown)
      watchScrollSettle({ element, onSettle: vi.fn(), signal: listeners.controller.signal })

      await mouseTo(element, 50)
      await mouse.down()
      await mouse.up()

      expect(onMouseDown).toHaveBeenCalledOnce()
    })

    it('starts no drag on a text field', async () => {
      const element = mountSnapScroller()
      const field = document.createElement('input')
      field.style.cssText = 'width: 100px; height: 10px; padding: 0; border: 0'
      element.firstElementChild!.append(field)
      watchScrollSettle({ element, onSettle: vi.fn(), signal: listeners.controller.signal })

      await mouseTo(element, 95)
      await mouse.down()
      await mouseTo(element, 45)
      await mouse.up()

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
