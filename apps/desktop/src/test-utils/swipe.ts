import { act } from 'react'

/** Dispatch one primary-touch pointer event on `node`. */
export function pointer(
  node: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
): void {
  act(() => {
    node.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        isPrimary: true,
        pointerId: 1,
        clientX,
        clientY,
      }),
    )
  })
}

/** One touch swipe: down, move, up, then the click a real touch adds. */
export function swipe(
  surface: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  pointer(surface, 'pointerdown', from.x, from.y)
  pointer(surface, 'pointermove', to.x, to.y)
  pointer(surface, 'pointerup', to.x, to.y)
  // A real touch sequence synthesizes a click after pointerup; dispatchEvent
  // does not, so mirror it to exercise the row's drag-click suppression.
  const touchSurface = surface as HTMLElement
  touchSurface.click()
}

/** The element's live compositor X translation. */
export function translateX(element: Element): number {
  return new DOMMatrixReadOnly(getComputedStyle(element).transform).m41
}
