import { useEffect, useRef, type RefObject } from 'react'
import { requestSurfaceFocus } from '@/lib/request-surface-focus'

export interface ArrivalFocusOptions {
  /** The router's navigation counter — bumped on every `navigate`. */
  arrivalSeq: number
  /** Whether the latest navigation asked the destination to focus its input. */
  arrivalFocusEditor: boolean
  /** The element a focus arrival should focus. */
  target: RefObject<HTMLElement | null>
  /** Select existing text after focusing text controls. */
  selectText?: boolean
}

/**
 * Focus `target` on capture arrivals (`navigate(..., { focusEditor: true })`
 * — e.g. tab double-taps landing on search/composer inputs). Mirrors
 * `useDailyArrivals`' bookkeeping: each arrival is consumed once, and the
 * arrival that mounts the screen still counts — a double-tap's second
 * navigate can land before the remounting screen first commits, so waiting
 * for a seq *change* would silently swallow the gesture.
 */
export function useArrivalFocus({
  arrivalSeq,
  arrivalFocusEditor,
  target,
  selectText = false,
}: ArrivalFocusOptions): void {
  const seenSeq = useRef<number | null>(null)
  useEffect(() => {
    const newArrival = seenSeq.current !== arrivalSeq
    if (newArrival && arrivalFocusEditor) {
      return requestSurfaceFocus(target.current, {
        selectText,
        onFocused: () => {
          seenSeq.current = arrivalSeq
        },
      })
    }
    seenSeq.current = arrivalSeq
  }, [arrivalSeq, arrivalFocusEditor, selectText, target])
}
