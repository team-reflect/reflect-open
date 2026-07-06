import { useCallback, useEffect, useRef, useState } from 'react'

export interface DailyArrivalsOptions {
  /** The router's navigation counter — bumped on every `navigate`. */
  arrivalSeq: number
  /** Whether the latest navigation asked the daily editor to focus. */
  arrivalFocusEditor: boolean
  /** The daily route's shown day (ISO date). */
  date: string
}

export interface DailyArrivals {
  /**
   * Bumped on an explicit re-arrival at the day already shown (the Daily tab
   * or title tapped while already there): the selected slide re-anchors to
   * the top and the strip re-centers.
   */
  resetSeq: number
  /** The day whose editor should focus with the caret at its end, if any. */
  focusDate: string | null
  /** Clear {@link focusDate} once the focus request has been applied. */
  consumeFocus: () => void
}

/**
 * Turns the router's arrival stream into the daily surface's two intents:
 * re-anchor (a date-preserving re-arrival) and focus (a capture arrival —
 * `navigate(..., { focusEditor: true })`, the Daily-tab double-tap). The
 * router bumps `arrivalSeq` for every navigate, but a swipe's own echo also
 * changes `date`, so only date-preserving arrivals re-anchor.
 *
 * The arrival that mounts the surface is special: it never re-anchors (there
 * is no previously-shown day), but its focus request still counts — the
 * double-tap's second navigate can land before the remounting surface (a tab
 * switch unmounts it) first commits, so waiting for a *change* against a
 * mount-seeded seq would silently swallow the capture gesture. The initial
 * state reads the mounting arrival instead.
 */
export function useDailyArrivals({
  arrivalSeq,
  arrivalFocusEditor,
  date,
}: DailyArrivalsOptions): DailyArrivals {
  const [resetSeq, setResetSeq] = useState(0)
  // The mounting arrival seeds the state directly — it never re-anchors
  // (there is no previously-shown day), but its focus request counts.
  const [focusDate, setFocusDate] = useState<string | null>(arrivalFocusEditor ? date : null)
  const lastArrival = useRef({ seq: arrivalSeq, date })
  useEffect(() => {
    const last = lastArrival.current
    lastArrival.current = { seq: arrivalSeq, date }
    if (arrivalSeq !== last.seq && arrivalFocusEditor) {
      setFocusDate(date)
    } else if (arrivalSeq !== last.seq) {
      setFocusDate(null)
    }
    if (arrivalSeq !== last.seq && date === last.date) {
      setResetSeq((seq) => seq + 1)
    }
  }, [arrivalSeq, arrivalFocusEditor, date])

  const consumeFocus = useCallback((): void => {
    setFocusDate(null)
  }, [])

  return { resetSeq, focusDate, consumeFocus }
}
