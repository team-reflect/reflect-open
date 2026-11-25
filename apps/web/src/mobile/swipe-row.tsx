import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { watchScrollSettle, type ScrollSettleWatch } from '@/lib/scroll-settle.ts'
import { cn } from '@/lib/utils.ts'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion.ts'
import './swipe-row.css'

interface SwipeRowProps {
  revealed: boolean
  onReveal: () => void
  onClose: () => void
  /**
   * Fires on every primary pointer down, before any scroll starts, so a tap
   * triggers it too.
   */
  onBeginInteraction: () => void
  /**
   * The trailing action buttons. They stay inert until the row is revealed.
   */
  actions: ReactNode
  /**
   * Classes for the scroller, e.g. a fixed height.
   */
  className?: string | undefined
  /**
   * Classes for the opaque surface that covers the actions.
   */
  surfaceClassName: string
  children: ReactNode
}

/**
 * An iOS-style swipe-action row on native horizontal scrolling. The row
 * surface and a trailing anchor are the two snap positions (closed, open), and
 * the actions stay pinned under the surface with `position: sticky`. The
 * browser runs the drag, the release decision, and the snap; the row reports
 * where it settled and scrolls itself when `revealed` changes.
 */
export function SwipeRow({
  revealed,
  onReveal,
  onClose,
  onBeginInteraction,
  actions,
  className,
  surfaceClassName,
  children,
}: SwipeRowProps): ReactElement {
  const reducedMotion = usePrefersReducedMotion()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const watchRef = useRef<ScrollSettleWatch | null>(null)
  const positionedRef = useRef(false)
  // Where the row was when a finger held back a placement, or `null`.
  const heldAtRef = useRef<number | null>(null)
  // Bumped when a still finger lifts, so the placement below runs again.
  const [lifts, setLifts] = useState(0)

  const reportSettled = useEffectEvent((scroller: HTMLElement) => {
    const open = scroller.scrollLeft >= getOpenLeft(scroller) / 2
    if (open && !revealed) {
      onReveal()
    } else if (!open && revealed) {
      onClose()
    }
  })

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) {
      return
    }
    const controller = new AbortController()
    // Ends the swipe styles once the row rests closed.
    const deactivateIfClosed = (): void => {
      if (Math.round(scroller.scrollLeft) === 0) {
        delete scroller.dataset.active
      }
    }
    watchRef.current = watchScrollSettle({
      element: scroller,
      onSettle: () => {
        deactivateIfClosed()
        reportSettled(scroller)
      },
      signal: controller.signal,
    })
    // A finger that lifts without moving the row leaves no settle report, so
    // the placement it held back runs again. These listeners run after the
    // watch's own, so `isTouching` is already up to date.
    const placeHeld = (): void => {
      deactivateIfClosed()
      if (heldAtRef.current === scroller.scrollLeft) {
        setLifts((count) => count + 1)
      }
    }
    scroller.addEventListener('touchend', placeHeld, { passive: true, signal: controller.signal })
    scroller.addEventListener('touchcancel', placeHeld, {
      passive: true,
      signal: controller.signal,
    })
    return () => {
      controller.abort()
      watchRef.current = null
    }
  }, [])

  // A finger on the row owns its position; the settle report reconciles later.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) {
      return
    }
    if (watchRef.current?.isTouching() === true) {
      heldAtRef.current = scroller.scrollLeft
      return
    }
    heldAtRef.current = null
    // An open row keeps the swipe styles, also when the row remounts open.
    if (revealed) {
      scroller.dataset.active = ''
    }
    const first = !positionedRef.current
    positionedRef.current = true
    const left = revealed ? getOpenLeft(scroller) : 0
    if (Math.round(scroller.scrollLeft) === left) {
      return
    }
    // The first placement runs before paint, so a remounted open row never animates in.
    scroller.scrollTo({ left, behavior: first || reducedMotion ? 'instant' : 'smooth' })
  }, [revealed, reducedMotion, lifts])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.isPrimary) {
        // Turns on the swipe styles in `swipe-row.css`.
        event.currentTarget.dataset.active = ''
        onBeginInteraction()
      }
    },
    [onBeginInteraction],
  )

  return (
    <div
      ref={scrollerRef}
      data-slot="swipe-row"
      // Marks a horizontal scroller.
      data-scroll-x=""
      onPointerDown={onPointerDown}
      className={cn('swipe-row pager-x flex overflow-x-auto', className)}
    >
      <div
        // `will-change-transform` gives the surface its own compositing layer, so
        // WebKit keeps it above the sticky actions inside a stacking context
        // (iOS 26 misorders them under virtua's `contain: layout` items).
        className={cn(
          'swipe-row-surface relative z-10 w-full flex-none snap-start will-change-transform',
          surfaceClassName,
        )}
      >
        {children}
      </div>
      <div
        className="sticky right-0 flex flex-none gap-2 px-2"
        aria-hidden={!revealed || undefined}
        inert={!revealed}
      >
        {actions}
      </div>
      <span
        // The open snap point: `snap-end` stops the row at the open position.
        // 1px wide because WebKit ignores zero-width snap areas; `-ml-px` cancels
        // the extra pixel. See also https://github.com/team-reflect/reflect-open/pull/1926
        aria-hidden
        className="-ml-px w-px flex-none snap-end"
      ></span>
    </div>
  )
}

/**
 * The scroll position of the open row: the actions are as wide as their content.
 */
function getOpenLeft(scroller: HTMLElement): number {
  return scroller.scrollWidth - scroller.clientWidth
}
