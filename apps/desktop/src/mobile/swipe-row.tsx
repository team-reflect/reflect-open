import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { watchScrollSettle, type ScrollSettleWatch } from '@/lib/scroll-settle.ts'
import { cn } from '@/lib/utils.ts'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion.ts'

interface SwipeRowProps {
  /**
   * Total width (px) of the trailing actions.
   */
  actionWidth: number
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
  actionWidth,
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

  const reportSettled = useEffectEvent((scroller: HTMLElement) => {
    const open = scroller.scrollLeft >= actionWidth / 2
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
    watchRef.current = watchScrollSettle({
      element: scroller,
      onSettle: () => reportSettled(scroller),
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
    if (scroller === null || watchRef.current?.isTouching() === true) {
      return
    }
    const first = !positionedRef.current
    positionedRef.current = true
    const left = revealed ? actionWidth : 0
    if (Math.round(scroller.scrollLeft) === left) {
      return
    }
    // The first placement runs before paint, so a remounted open row never animates in.
    scroller.scrollTo({ left, behavior: first || reducedMotion ? 'instant' : 'smooth' })
  }, [revealed, actionWidth, reducedMotion])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.isPrimary) {
        onBeginInteraction()
      }
    },
    [onBeginInteraction],
  )

  const actionsStyle = useMemo(() => ({ width: actionWidth }), [actionWidth])

  return (
    <div
      ref={scrollerRef}
      data-slot="swipe-row"
      // Marks a horizontal scroller, which keeps `touch-action: auto` inside a pager that pans with `pan-y`.
      data-scroll-x=""
      onPointerDown={onPointerDown}
      className={cn(
        'flex snap-x snap-mandatory scrollbar-none overflow-x-auto overflow-y-hidden overscroll-x-contain',
        className,
      )}
    >
      <div className={cn('relative z-10 w-full flex-none snap-start', surfaceClassName)}>
        {children}
      </div>
      <div
        className="sticky right-0 flex flex-none"
        style={actionsStyle}
        aria-hidden={!revealed || undefined}
        inert={!revealed}
      >
        {actions}
      </div>
      <span aria-hidden className="w-0 flex-none snap-end" />
    </div>
  )
}
