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
   * True while a finger is down on the element.
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
  let touching = false
  // A finger is down, or lifted after it moved the element, and that scroll has not settled.
  let fingerScroll = false
  let scrolledSinceTouch = false
  let touchLeft = 0
  let touchTop = 0
  let wheelAt = -Infinity
  let scrollAt = -Infinity
  let userScroll = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    clearTimeout(timer)
    if (!pending || touching) {
      return
    }
    pending = false
    fingerScroll = false
    onSettle()
  }
  const settleOrWait = (): void => {
    if (isSettled?.() ?? false) {
      flush()
      return
    }
    clearTimeout(timer)
    timer = setTimeout(flush, SETTLE_IDLE_MS)
  }

  element.addEventListener(
    'touchstart',
    () => {
      touching = true
      fingerScroll = true
      scrolledSinceTouch = false
      touchLeft = element.scrollLeft
      touchTop = element.scrollTop
    },
    { passive: true, signal },
  )
  const release = (event: TouchEvent): void => {
    touching = event.touches.length > 0
    if (touching) {
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
    },
    { passive: true, signal },
  )
  element.addEventListener(
    'scroll',
    () => {
      const now = performance.now()
      // A snap animation can pass the settled position and keep moving inside
      // it (to 0 after 1). Those last frames belong to the scroll that was
      // already reported, so they get no new report and keep its user flag.
      const tail =
        !pending && !touching && now - scrollAt < SETTLE_IDLE_MS && (isSettled?.() ?? false)
      scrollAt = now
      if (tail) {
        return
      }
      scrolledSinceTouch = true
      if (fingerScroll || now - wheelAt < SETTLE_IDLE_MS) {
        userScroll = true
      } else if (!pending) {
        // A new scroll that no finger or wheel started.
        userScroll = false
      }
      pending = true
      if (touching) {
        // The finger decides; `touchend` checks again.
        clearTimeout(timer)
        return
      }
      settleOrWait()
    },
    { passive: true, signal },
  )
  element.addEventListener('scrollend', flush, { signal })
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })

  return {
    isTouching: () => touching,
    isUserScroll: () => userScroll,
  }
}
