/**
 * Quiet time (ms) after the last scroll event before a scroll counts as settled.
 */
const SETTLE_IDLE_MS = 120

export interface ScrollSettleOptions {
  /**
   * Whether the element already rests where no further scroll can follow, for
   * example a pager at its first page. When this returns true on a `scroll` or
   * `touchend` with no finger down, the report runs at once instead of after
   * the quiet time.
   */
  isSettled?: (() => boolean) | undefined
}

export interface ScrollSettleWatch {
  /**
   * True while a finger that landed on the element is down.
   */
  isTouching: () => boolean
  /**
   * True when the current or last scroll began from a touch or a wheel. False
   * for scrolls that code, focus, or the keyboard started.
   */
  isUserScroll: () => boolean
}

/**
 * Calls `onSettle` each time `element` stops scrolling with no finger down:
 * after a swipe, its momentum, and its snap, or after a scroll that code,
 * focus, or a re-snap started. `scrollend` reports early where the engine has
 * it; a quiet-time timer covers the engines without it.
 */
export function watchScrollSettle(
  element: HTMLElement,
  onSettle: () => void,
  signal: AbortSignal,
  options?: ScrollSettleOptions,
): ScrollSettleWatch {
  const isSettled = options?.isSettled
  // Fingers that landed on the element and have not lifted.
  const fingers = new Set<number>()
  // A finger is down, or lifted after it moved the element, and that scroll has not settled.
  let fingerScroll = false
  let scrolledSinceTouch = false
  let touchLeft = 0
  let touchTop = 0
  let wheelAt = -Infinity
  let userScroll = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // A scroll was reported early because the element was settled. A snap
  // animation can still move inside the settled range (to 0 after 1); those
  // frames belong to the reported scroll.
  let snapTail = false
  let snapTailTimer: ReturnType<typeof setTimeout> | undefined

  const isTouching = (): boolean => fingers.size > 0
  const endSnapTail = (): void => {
    snapTail = false
    clearTimeout(snapTailTimer)
  }
  const extendSnapTail = (): void => {
    snapTail = true
    clearTimeout(snapTailTimer)
    snapTailTimer = setTimeout(endSnapTail, SETTLE_IDLE_MS)
  }
  const flush = (): void => {
    clearTimeout(timer)
    if (!pending || isTouching()) {
      return
    }
    pending = false
    fingerScroll = false
    onSettle()
  }
  const settleOrWait = (): void => {
    if (isSettled?.() ?? false) {
      flush()
      extendSnapTail()
      return
    }
    clearTimeout(timer)
    timer = setTimeout(flush, SETTLE_IDLE_MS)
  }

  element.addEventListener(
    'touchstart',
    (event: TouchEvent) => {
      for (const touch of event.changedTouches) {
        fingers.add(touch.identifier)
      }
      endSnapTail()
      fingerScroll = true
      scrolledSinceTouch = false
      touchLeft = element.scrollLeft
      touchTop = element.scrollTop
    },
    { passive: true, signal },
  )
  const release = (event: TouchEvent): void => {
    for (const touch of event.changedTouches) {
      fingers.delete(touch.identifier)
    }
    if (isTouching()) {
      return
    }
    // A tap moved nothing. Without this, a focus scroll right after the tap
    // would count as the finger's.
    const moved =
      scrolledSinceTouch || element.scrollLeft !== touchLeft || element.scrollTop !== touchTop
    if (!moved) {
      fingerScroll = false
    }
    if (pending) {
      settleOrWait()
    }
  }
  element.addEventListener('touchend', release, { passive: true, signal })
  element.addEventListener('touchcancel', release, { passive: true, signal })
  element.addEventListener(
    'wheel',
    () => {
      wheelAt = performance.now()
      endSnapTail()
    },
    { passive: true, signal },
  )
  element.addEventListener(
    'scroll',
    () => {
      if (snapTail) {
        if (isSettled?.() ?? false) {
          // No new report, and the reported scroll keeps its user flag.
          extendSnapTail()
          return
        }
        endSnapTail()
      }
      scrolledSinceTouch = true
      if (fingerScroll || performance.now() - wheelAt < SETTLE_IDLE_MS) {
        userScroll = true
      } else if (!pending) {
        // A new scroll that no finger or wheel started.
        userScroll = false
      }
      pending = true
      if (isTouching()) {
        // The finger decides; `touchend` checks again.
        clearTimeout(timer)
        return
      }
      settleOrWait()
    },
    { passive: true, signal },
  )
  element.addEventListener('scrollend', flush, { signal })
  signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      clearTimeout(snapTailTimer)
    },
    { once: true },
  )

  return {
    isTouching,
    isUserScroll: () => userScroll,
  }
}
