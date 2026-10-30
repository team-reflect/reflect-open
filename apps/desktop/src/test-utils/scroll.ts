import { act } from '@/test-utils/act.ts'

/**
 * Dispatches a `touchstart` or `touchend` on `element` for one finger
 * (identifier 0), the way it lands or lifts. It moves nothing.
 */
export function dispatchTouch(element: Element, phase: 'start' | 'end'): void {
  const event = new TouchEvent(`touch${phase}`, { bubbles: true })
  // WebKit has no `Touch` constructor, so plain objects stand in for the list.
  Object.defineProperty(event, 'changedTouches', { value: [{ identifier: 0, target: element }] })
  element.dispatchEvent(event)
}

/** `dispatchTouch` inside `act`. */
export async function touch(element: Element, phase: 'start' | 'end'): Promise<void> {
  await act(() => {
    dispatchTouch(element, phase)
  })
}

/**
 * Scrolls `element` to `position` the way a finished gesture leaves it: one
 * `scroll` event, then `scrollend`. With `touch`, a `touchstart` comes first
 * and a `touchend` lands before `scrollend`, so the scroll counts as a
 * finger's. When `element` is already at `position`, no `scroll` or
 * `scrollend` follows. It does not wait for any settle report; tests wait for
 * the effect they expect.
 */
export async function scrollElement(
  element: HTMLElement,
  position: { left?: number; top?: number },
  options?: { touch?: boolean | undefined },
): Promise<void> {
  const finger = options?.touch ?? false
  if (finger) {
    await touch(element, 'start')
  }
  let moved = false
  await act(async () => {
    const left = element.scrollLeft
    const top = element.scrollTop
    element.scrollTo({ ...position, behavior: 'instant' })
    moved = element.scrollLeft !== left || element.scrollTop !== top
    if (moved) {
      await new Promise<void>((resolve) => {
        element.addEventListener('scroll', () => resolve(), { once: true })
      })
    }
  })
  if (finger) {
    await touch(element, 'end')
  }
  if (moved) {
    await act(() => {
      element.dispatchEvent(new Event('scrollend'))
    })
  }
}
