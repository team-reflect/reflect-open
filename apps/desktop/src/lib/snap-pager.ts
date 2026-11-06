import { nearestIndex, pageOf, pageWidth, restOn } from '@/lib/scroll-pager.ts'
import { watchScrollSettle } from '@/lib/scroll-settle.ts'
import {
  describeNode,
  installSwipeLog,
  swipeLog,
  swipeLogState,
  warnIfPullbackDuringTouch,
} from '@/lib/swipe-log.ts'

export interface SnapPagerOptions {
  /**
   * The horizontal scroller. Each child is one page as wide as the scroller.
   */
  element: HTMLElement
  /**
   * The page to rest on when the pager attaches.
   */
  index: number
  count: () => number
  prefersReducedMotion: () => boolean
  /**
   * Where a mouse drag may start, or `null` for no mouse drag. Defaults to
   * `element`.
   */
  dragHandle?: HTMLElement | null | undefined
  /**
   * The shown page changed. A user scroll shows the nearest page
   * (`byUser` is true), and `show` or `restOn` shows its target at once.
   */
  onIndex: (index: number, byUser: boolean) => void
  /**
   * A user scroll came to rest on page `index`.
   */
  onUserSettle: (index: number) => void
  signal: AbortSignal
}

export interface SnapPager {
  /**
   * The shown page.
   */
  index: () => number
  /**
   * Scrolls to page `index`, smoothly unless reduced motion is on.
   */
  show: (index: number) => void
  /**
   * Moves onto page `index` at once.
   */
  restOn: (index: number) => void
}

/**
 * Owns the shown page of a snapping horizontal scroller. It pulls a scroll
 * that neither a user nor `show` started back to the shown page, stays on the
 * shown page after a resize, and reports the page a user scroll comes to rest
 * on. A scroll that comes to rest on the page `show` targets counts as
 * `show`'s, even when a finger or wheel moved the scroller on the way.
 */
export function attachSnapPager({
  element,
  index: initialIndex,
  count,
  prefersReducedMotion,
  dragHandle,
  onIndex,
  onUserSettle,
  signal,
}: SnapPagerOptions): SnapPager {
  // The day carousel sits in `main`; the week strip sits in `header`.
  const tag = element.closest('header') ? 'strip' : 'days'
  if (tag === 'days') {
    installSwipeLog(element)
  }
  const log = (kind: string, data: Record<string, unknown> = {}): void => {
    swipeLog(`${tag}:${kind}`, data)
  }
  let index = initialIndex
  // A user scroll has moved the scroller and has not settled.
  let userScrolling = false
  // The page a running `show` scroll moves to.
  let expected: number | undefined

  const setIndex = (next: number, byUser: boolean): void => {
    if (next !== index) {
      log('setIndex', { from: index, to: next, byUser })
      index = next
      onIndex(next, byUser)
    }
  }

  const show = (next: number): void => {
    setIndex(next, false)
    userScrolling = false
    const left = next * pageWidth(element)
    log('show', { next, left, sl: element.scrollLeft })
    if (Math.abs(element.scrollLeft - left) < 1) {
      return
    }
    expected = next
    element.scrollTo({ left, behavior: prefersReducedMotion() ? 'instant' : 'smooth' })
  }

  const watch = watchScrollSettle({
    element,
    signal,
    dragHandle,
    onSettle: () => {
      userScrolling = false
      const nearest = nearestIndex(element, count())
      const target = expected
      expected = undefined
      const user = watch.isUserScroll()
      log('settle', { nearest, target, index, user, sl: element.scrollLeft })
      if (nearest === undefined) {
        return
      }
      if (nearest === target || !user) {
        restOn(element, index, `${tag}:settle-keep`)
        return
      }
      // WebKit can come to rest between snap points.
      restOn(element, nearest, `${tag}:settle-user`)
      setIndex(nearest, true)
      onUserSettle(nearest)
    },
  })

  // After the watch, whose own listener decides whether this scroll is the user's.
  element.addEventListener(
    'scroll',
    () => {
      const flags = watch.flags()
      if (!watch.isUserScroll()) {
        if (expected === undefined) {
          const off = element.scrollLeft - index * pageWidth(element)
          log('PULLBACK', {
            index,
            sl: element.scrollLeft,
            off,
            skip: swipeLogState.noPullback,
            ...flags,
          })
          if (Math.abs(off) >= 1) {
            warnIfPullbackDuringTouch(flags.fingers as number)
          }
          if (!swipeLogState.noPullback) {
            restOn(element, index, `${tag}:scroll-pullback`)
          }
        } else {
          log('scroll-expected', { expected, sl: element.scrollLeft })
        }
        return
      }
      userScrolling = true
      const nearest = nearestIndex(element, count())
      if (nearest !== undefined) {
        setIndex(nearest, true)
      }
    },
    { passive: true, signal },
  )

  // A focused element on another page (keyboard Tab) shows that page.
  element.addEventListener(
    'focusin',
    (event) => {
      const target = event.target
      const page = target instanceof Element ? pageOf(element, target, count()) : undefined
      log('focusin', { target: describeNode(target), page, index, userScrolling })
      if (userScrolling) {
        return
      }
      if (page !== undefined && page !== index) {
        show(page)
      }
    },
    { signal },
  )

  // A rotation or split view changes the page width. Stay on the same page,
  // unless a finger or its momentum owns the position (the settle aligns it).
  const resize = new ResizeObserver(() => {
    const acts = !watch.isTouching() && !userScrolling
    log('resize', { width: pageWidth(element), acts, userScrolling, ...watch.flags() })
    if (acts) {
      restOn(element, index, `${tag}:resize`)
    }
  })
  resize.observe(element)
  signal.addEventListener('abort', () => resize.disconnect(), { once: true })

  log('attach', { index: initialIndex, count: count(), width: pageWidth(element) })
  restOn(element, index, `${tag}:attach`)

  return {
    index: () => index,
    show,
    restOn: (next) => {
      log('restOn-api', { next, index, expected, userScrolling })
      setIndex(next, false)
      userScrolling = false
      expected = undefined
      restOn(element, next, `${tag}:api`)
    },
  }
}
