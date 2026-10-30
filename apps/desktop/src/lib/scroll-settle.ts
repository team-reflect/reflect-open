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
  /**
   * Lets a mouse drag scroll the element along `axis`, the way a finger does.
   * A drag starts on `handle` (the element by default), not on a control or
   * editable text. Snapping is off while the mouse moves; on release the
   * element scrolls smoothly to the nearer end of its range.
   */
  mouseDrag?: { axis: 'x' | 'y'; handle?: HTMLElement | undefined } | undefined
}

/**
 * Pointer travel (px) before a mouse press becomes a drag, so a click stays a click.
 */
const DRAG_THRESHOLD_PX = 4

/**
 * Targets where a mouse press keeps its own meaning and starts no drag.
 */
const NO_DRAG_SELECTOR = 'button, a, input, textarea, select, [contenteditable]'

export interface ScrollSettleWatch {
  /**
   * True while a finger that landed on the element is down, or a mouse drag
   * and its release scroll are running.
   */
  isTouching: () => boolean
  /**
   * True when the current or last scroll began from a touch, a mouse drag, or
   * a wheel. False
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
  // A mouse drag or its release scroll is running.
  let mouseDragging = false

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
  const mouseDrag = options?.mouseDrag
  if (mouseDrag) {
    const endMouseDrag = (): void => {
      mouseDragging = false
      if (!pending) {
        // The drag moved nothing, for example at the end of the range.
        fingerScroll = false
      }
      flush()
    }
    ;(mouseDrag.handle ?? element).addEventListener(
      'pointerdown',
      (down: PointerEvent) => {
        if (
          down.pointerType !== 'mouse' ||
          down.button !== 0 ||
          (down.target instanceof Element && down.target.closest(NO_DRAG_SELECTOR))
        ) {
          return
        }
        // Stops text selection and keeps the press from focusing anything.
        down.preventDefault()
        const x = mouseDrag.axis === 'x'
        const start = x ? element.scrollLeft : element.scrollTop
        const origin = x ? down.clientX : down.clientY
        const snapType = element.style.scrollSnapType
        let dragging = false
        const controller = new AbortController()
        const drag = AbortSignal.any([signal, controller.signal])
        drag.addEventListener(
          'abort',
          () => {
            if (signal.aborted && dragging) {
              element.style.scrollSnapType = snapType
              mouseDragging = false
            }
          },
          { once: true },
        )
        // On the window, so the drag keeps going when the mouse leaves the element.
        window.addEventListener(
          'pointermove',
          (move: PointerEvent) => {
            const delta = (x ? move.clientX : move.clientY) - origin
            if (!dragging) {
              if (Math.abs(delta) < DRAG_THRESHOLD_PX) {
                return
              }
              dragging = true
              mouseDragging = true
              endSnapTail()
              fingerScroll = true
              element.style.scrollSnapType = 'none'
            }
            element.scrollTo({ [x ? 'left' : 'top']: start - delta, behavior: 'instant' })
          },
          { signal: drag },
        )
        const release = (): void => {
          controller.abort()
          if (!dragging) {
            return
          }
          element.style.scrollSnapType = snapType
          // The click that ends a drag is not a click. It fires in the same
          // task as `pointerup`, if at all.
          const click = new AbortController()
          window.addEventListener(
            'click',
            (event) => {
              event.preventDefault()
              event.stopImmediatePropagation()
            },
            {
              capture: true,
              once: true,
              signal: AbortSignal.any([signal, click.signal]),
            },
          )
          setTimeout(() => click.abort(), 0)
          const position = x ? element.scrollLeft : element.scrollTop
          const range = x
            ? element.scrollWidth - element.clientWidth
            : element.scrollHeight - element.clientHeight
          const end = position < range / 2 ? 0 : range
          if (Math.abs(end - position) < 1) {
            endMouseDrag()
            return
          }
          // The drag lasts until the release scroll reaches the end. A late
          // `scrollend` from the drag itself, or an interrupted scroll that
          // goes quiet, must not leave it running.
          const settle = new AbortController()
          const finish = (): void => {
            clearTimeout(quiet)
            settle.abort()
            endMouseDrag()
          }
          let quiet = setTimeout(finish, SETTLE_IDLE_MS)
          element.addEventListener(
            'scroll',
            () => {
              clearTimeout(quiet)
              quiet = setTimeout(finish, SETTLE_IDLE_MS)
            },
            { passive: true, signal: AbortSignal.any([signal, settle.signal]) },
          )
          element.addEventListener(
            'scrollend',
            () => {
              const now = x ? element.scrollLeft : element.scrollTop
              if (Math.abs(end - now) < 1) {
                finish()
              }
            },
            { signal: AbortSignal.any([signal, settle.signal]) },
          )
          signal.addEventListener('abort', () => clearTimeout(quiet), { once: true })
          element.scrollTo({ [x ? 'left' : 'top']: end, behavior: 'smooth' })
        }
        window.addEventListener('pointerup', release, { signal: drag })
        window.addEventListener('pointercancel', release, { signal: drag })
      },
      { signal },
    )
  }
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
