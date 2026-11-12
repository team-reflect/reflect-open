import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { formatMonthLabel } from '@reflect/app'
import { cn } from '@/lib/utils.ts'
import './month-title.css'

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
  const [shown, setShown] = useState(month)
  const [outgoing, setOutgoing] = useState<OutgoingMonth | null>(null)
  // Adjust-on-render rather than an effect: the outgoing and incoming labels
  // must appear in the same paint or the roll flickers.
  if (shown !== month) {
    setShown(month)
    setOutgoing({ month: shown, direction: month > shown ? 'up' : 'down' })
  }

  // The outgoing label leaves when its CSS animations finish. Under reduced
  // motion it has none, so it leaves before the browser paints.
  const outgoingRef = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    const element = outgoingRef.current
    if (!outgoing || !element) {
      return
    }
    const animations = element.getAnimations()
    if (animations.length === 0) {
      setOutgoing(null)
      return
    }
    const controller = new AbortController()
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!controller.signal.aborted) {
        setOutgoing(null)
      }
    })
    return () => controller.abort()
  }, [outgoing])

  return (
    <span className="relative block h-[1.5em] min-w-0 overflow-hidden">
      <span
        key={shown}
        data-slot="month-title"
        className={cn(
          'block truncate leading-[1.5]',
          outgoing &&
            (outgoing.direction === 'up' ? 'month-title-enter-up' : 'month-title-enter-down'),
        )}
      >
        {formatMonthLabel(shown)}
      </span>
      {outgoing ? (
        <span
          // Keyed so back-to-back month changes in the same direction remount
          // the label — reusing the element would keep the same animation
          // class and never restart the exit roll.
          key={outgoing.month}
          ref={outgoingRef}
          aria-hidden
          className={cn(
            'absolute inset-x-0 top-0 block truncate leading-[1.5]',
            outgoing.direction === 'up' ? 'month-title-exit-up' : 'month-title-exit-down',
          )}
        >
          {formatMonthLabel(outgoing.month)}
        </span>
      ) : null}
    </span>
  )
}
