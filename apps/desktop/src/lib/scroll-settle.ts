/**
 * Quiet time (ms) after the last scroll event before a scroll counts as settled.
 */
const SETTLE_IDLE_MS = 120

/**
 * Mouse travel (px) before a press becomes a drag, so a click stays a click.
 */
const DRAG_THRESHOLD_PX = 4

/**
 * Press targets that keep their own meaning (focus, caret, text selection) and
 * start no mouse drag.
 */
const NO_DRAG_SELECTOR = 'input, textarea, select, [contenteditable]'

export interface ScrollSettleOptions {
  /**
   * The scroller to watch. Its `scroll-snap-type` axis is the mouse drag axis.
   */
  element: HTMLElement
  /**
   * Called each time the element settles.
   */
  onSettle: () => void
  /**
   * Stops the watch and any mouse drag in progress.
   */
  signal: AbortSignal
  /**
   * Whether the element already rests where no further scroll can follow, for
   * example a pager at its first page. When this returns true on a `scroll` or
   * `touchend` with no finger down, the report runs at once instead of after
   * the quiet time.
   */
  isSettled?: (() => boolean) | undefined
  /**
   * Where a mouse drag may start. Defaults to `element`.
   */
  dragHandle?: HTMLElement | undefined
}

export interface ScrollSettleWatch {
  /**
   * True while a finger that landed on the element is down, or a mouse drag
   * and its release scroll are running.
   */
  isTouching: () => boolean
  /**
   * True when the current or last scroll began from a touch, a mouse drag, or
   * a wheel. False for scrolls that code, focus, or the keyboard started.
   */
  isUserScroll: () => boolean
}

/**
 * Calls `onSettle` each time `element` stops scrolling with no finger down:
 * after a swipe, its momentum, and its snap, or after a scroll that code,
 * focus, or a re-snap started. `scrollend` reports early where the engine has
 * it; a quiet-time timer covers the engines without it.
 *
 * A mouse drag scrolls the element the way a finger does: snapping is off
 * from the first move until the release scroll stops, and on release the
 * element scrolls smoothly to the nearer end of its range. The drag and that
 * scroll count as one user scroll.
 */
export function watchScrollSettle({
  element,
  onSettle,
  signal,
  isSettled,
  dragHandle = element,
}: ScrollSettleOptions): ScrollSettleWatch {
  // Fingers that landed on the element and have not lifted.
  const fingers = new Set<number>()
  // A mouse drag or its release scroll is running.
  let mouseDragging = false
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
  // The current mouse press, from `pointerdown` until its release scroll stops.
  let press: AbortController | undefined

  const isTouching = (): boolean => fingers.size > 0 || mouseDragging
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
  dragHandle.addEventListener('pointerdown', (down) => dragWithMouse(down), { signal })
  signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      clearTimeout(snapTailTimer)
    },
    { once: true },
  )

  // One press, from `pointerdown` until the release scroll stops. Aborting
  // the press undoes everything it set.
  function dragWithMouse(down: PointerEvent): void {
    if (down.pointerType !== 'mouse' || down.button !== 0) {
      return
    }
    // A new press ends the last one first: the last press may still hold the
    // inline snap type the axis comes from. A release scroll it cuts short
    // still settles.
    press?.abort()
    if (pending) {
      settleOrWait()
    }
    const axis = snapAxis(element)
    if (!axis || (down.target instanceof Element && down.target.closest(NO_DRAG_SELECTOR))) {
      return
    }
    const x = axis === 'x'
    const position = (): number => (x ? element.scrollLeft : element.scrollTop)
    const pointer = (event: PointerEvent): number => (x ? event.clientX : event.clientY)
    const start = position()
    const origin = pointer(down)
    let dragging = false
    let quiet: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    press = controller
    const pressSignal = AbortSignal.any([signal, controller.signal])
    // Stops text selection and native drag and drop, and leaves the press
    // itself to the control under it: a `preventDefault` on `pointerdown`
    // would cancel its `mousedown`.
    for (const type of ['selectstart', 'dragstart']) {
      window.addEventListener(type, (event) => event.preventDefault(), {
        capture: true,
        signal: pressSignal,
      })
    }
    // The button is down: from `pointerdown` until `pointerup` or `pointercancel`.
    const released = new AbortController()
    const held = AbortSignal.any([pressSignal, released.signal])
    pressSignal.addEventListener(
      'abort',
      () => {
        clearTimeout(quiet)
        mouseDragging = false
        element.style.scrollSnapType = ''
      },
      { once: true },
    )
    const finish = (): void => {
      controller.abort()
      if (!pending) {
        // The drag moved nothing, for example at the end of the range.
        fingerScroll = false
      }
      flush()
    }

    // On the window, so the drag goes on when the mouse leaves the element.
    window.addEventListener(
      'pointermove',
      (move) => {
        const delta = pointer(move) - origin
        if (!dragging && Math.abs(delta) < DRAG_THRESHOLD_PX) {
          return
        }
        if (!dragging) {
          dragging = true
          mouseDragging = true
          fingerScroll = true
          endSnapTail()
          element.style.scrollSnapType = 'none'
        }
        element.scrollTo({ [x ? 'left' : 'top']: start - delta, behavior: 'instant' })
      },
      { signal: held },
    )
    // `pointercancel` ends the press like `pointerup`, so a lost pointer cannot
    // hold the element.
    const release = (): void => {
      released.abort()
      if (!dragging) {
        controller.abort()
        return
      }
      // Snap stays off until the release scroll stops. Turned back on here, it
      // would re-snap to the target the drag started from.
      suppressNextClick()
      const range = x
        ? element.scrollWidth - element.clientWidth
        : element.scrollHeight - element.clientHeight
      const end = position() < range / 2 ? 0 : range
      // The press lasts until the release scroll stops: on `scrollend` at
      // `end`, or after the quiet time. A late `scrollend` from the drag
      // itself does not end it, and an interrupted scroll cannot hold it.
      const wait = (): void => {
        clearTimeout(quiet)
        quiet = setTimeout(finish, SETTLE_IDLE_MS)
      }
      element.addEventListener('scroll', wait, { passive: true, signal: pressSignal })
      element.addEventListener(
        'scrollend',
        () => {
          if (Math.abs(position() - end) < 1) {
            finish()
          }
        },
        { signal: pressSignal },
      )
      wait()
      element.scrollTo({ [x ? 'left' : 'top']: end, behavior: 'smooth' })
    }
    window.addEventListener('pointerup', release, { signal: held })
    window.addEventListener('pointercancel', release, { signal: held })
  }

  return {
    isTouching,
    isUserScroll: () => userScroll,
  }
}

/**
 * The axis of `element`'s `scroll-snap-type`, if it snaps on one axis.
 */
function snapAxis(element: HTMLElement): 'x' | 'y' | undefined {
  const type = getComputedStyle(element).scrollSnapType
  if (/^(?:x|inline)\b/.test(type)) {
    return 'x'
  }
  if (/^(?:y|block)\b/.test(type)) {
    return 'y'
  }
  return undefined
}

/**
 * Swallows the click that ends a drag, if one comes. It fires in the same task
 * as `pointerup`, so the trap is gone by the next task either way.
 */
function suppressNextClick(): void {
  const controller = new AbortController()
  window.addEventListener(
    'click',
    (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    { capture: true, once: true, signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 0)
}
