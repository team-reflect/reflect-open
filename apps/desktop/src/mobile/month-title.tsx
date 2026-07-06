import { useEffect, useRef, useState, type ReactElement } from 'react'
import { monthLabel } from '@/lib/month-grid'
import { cn } from '@/lib/utils'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion'
import './month-title.css'

/** Mirrors the animation durations in month-title.css (the fallback timer). */
export const MONTH_TITLE_TRANSITION_MS = 320

interface OutgoingMonth {
  month: string
  /** `up` toward a later month, `down` toward an earlier one. */
  direction: 'up' | 'down'
}

interface MonthTitleProps {
  /** The `YYYY-MM` month to show. */
  month: string
}

/**
 * The calendar strip's month label, changed with a ticker roll instead of an
 * instant swap: moving to a later month the old label fades up and out while
 * the new one fades up in from beneath it; earlier months roll the other way.
 * Under reduced motion the label just swaps. The settled label carries
 * `data-slot="month-title"` so callers (and tests) can read it without
 * catching a mid-roll outgoing label.
 */
export function MonthTitle({ month }: MonthTitleProps): ReactElement {
  const reducedMotion = usePrefersReducedMotion()
  const [shown, setShown] = useState(month)
  const [outgoing, setOutgoing] = useState<OutgoingMonth | null>(null)
  // Adjust-on-render rather than an effect: the outgoing and incoming labels
  // must appear in the same paint or the roll flickers.
  if (shown !== month) {
    setShown(month)
    setOutgoing(
      reducedMotion ? null : { month: shown, direction: month > shown ? 'up' : 'down' },
    )
  }

  // The outgoing label leaves on `animationend` — a native listener, like
  // the navigation stack's (React's synthetic animation events misfire in
  // some WebKit/jsdom environments). The timer is the fallback for when the
  // animation never runs (the reduced-motion media block).
  const outgoingRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (!outgoing) {
      return
    }
    const element = outgoingRef.current
    const clear = (): void => setOutgoing(null)
    element?.addEventListener('animationend', clear)
    const timer = window.setTimeout(clear, MONTH_TITLE_TRANSITION_MS + 80)
    return () => {
      element?.removeEventListener('animationend', clear)
      window.clearTimeout(timer)
    }
  }, [outgoing])

  return (
    <span className="relative block h-[1.5em] min-w-0 overflow-hidden">
      <span
        key={shown}
        data-slot="month-title"
        className={cn(
          'block truncate leading-[1.5]',
          outgoing && (outgoing.direction === 'up' ? 'month-title-enter-up' : 'month-title-enter-down'),
        )}
      >
        {monthLabel(shown)}
      </span>
      {outgoing ? (
        <span
          ref={outgoingRef}
          aria-hidden
          className={cn(
            'absolute inset-x-0 top-0 block truncate leading-[1.5]',
            outgoing.direction === 'up' ? 'month-title-exit-up' : 'month-title-exit-down',
          )}
        >
          {monthLabel(outgoing.month)}
        </span>
      ) : null}
    </span>
  )
}
