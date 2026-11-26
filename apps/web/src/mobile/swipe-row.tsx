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
   * triggers it too, and on every horizontal wheel event.
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
  // Where the row was when a press held back a placement, or `null`.
  const heldAtRef = useRef<number | null>(null)
  // Bumped when a press ends without moving the row, so the placement reruns.
  const [lifts, setLifts] = useState(0)

  const beginInteraction = useEffectEvent(() => {
    onBeginInteraction()
  })

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
    // Any horizontal scroll (finger, trackpad, keyboard) turns on the swipe
    // styles in `swipe-row.css`.
    scroller.addEventListener(
      'scroll',
      () => {
        scroller.dataset.active = ''
      },
      { passive: true, signal: controller.signal },
    )
    // A horizontal trackpad swipe starts an interaction like a press does.
    scroller.addEventListener(
      'wheel',
      (event) => {
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          beginInteraction()
        }
      },
      { passive: true, signal: controller.signal },
    )
    // A row that rests where a press held back a placement runs that
    // placement again. Returns whether it did.
    const placeHeld = (): boolean => {
      if (heldAtRef.current !== scroller.scrollLeft) {
        return false
      }
      setLifts((count) => count + 1)
      return true
    }
    watchRef.current = watchScrollSettle({
      element: scroller,
      onSettle: () => {
        // Ends the swipe styles once the row rests closed.
        if (Math.round(scroller.scrollLeft) === 0) {
          delete scroller.dataset.active
        }
        // A settle report can still be waiting from a scroll before the press.
        // When the press did not move the row, the held placement wins.
        if (!placeHeld()) {
          reportSettled(scroller)
        }
      },
      // A press that ends without moving the row usually leaves no settle
      // report, so the placement it held back runs again.
      onPressEnd: placeHeld,
      signal: controller.signal,
    })
    return () => {
      controller.abort()
      watchRef.current = null
    }
  }, [])

  // A press on the row owns its position; the settle report reconciles later.
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
        className={cn(
          // The edge shadow lies past both side edges, so it shows only on a moved row.
          'swipe-row-surface relative z-10 w-full flex-none snap-start shadow-edge',
          surfaceClassName,
        )}
      >
        {children}
      </div>
      <div
        className="swipe-row-actions sticky right-0 flex flex-none gap-2 px-2"
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
