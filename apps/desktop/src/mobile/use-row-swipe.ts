import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPointerDrag, createVelocitySampler } from '@/lib/pointer-drag'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion'

/** Finger travel (px) before the gesture commits to horizontal swipe or vertical scroll. */
const DIRECTION_THRESHOLD = 10
/** How far ahead the release velocity is projected when choosing open vs closed. */
const PROJECTED_MOMENTUM_MS = 100
/** Duration of the settle transition that carries the row to its resting position. */
const SETTLE_MS = 240
/** iOS-feel settle curve: fast start, long decelerating tail. */
const SETTLE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

interface RowSwipeOptions {
  /** Total width of the actions underneath the row. */
  actionWidth: number
  revealed: boolean
  onReveal: () => void
  onClose: () => void
  /**
   * Lets the list close a different row as soon as this one is touched.
   * Fires on every primary touch start, before the direction is decided, so a
   * mere tap triggers it too. Wire it to the list's single-revealed-row state:
   * close every other revealed row in this callback, and this row stays the
   * only open candidate.
   */
  onBeginInteraction: () => void
}

interface RowSwipeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
}

export interface RowSwipe {
  handlers: RowSwipeHandlers
  /**
   * Attach to the moving row surface. The hook writes its presentation
   * (`touch-action`, `transform`, `transition`, `will-change`) imperatively,
   * so pointer moves never re-render React.
   */
  ref: (element: HTMLElement | null) => void
  /**
   * Consume the synthetic click that WebKit emits after a completed drag.
   * Call it first inside the row's click handler: it returns true exactly once
   * for the click manufactured by a just-finished drag (ignore that click),
   * and false for a real tap that should activate the row.
   */
  consumeDragClick: () => boolean
}

/**
 * The iOS-style swipe-action gesture for a list row. Touch follows the finger
 * 1:1 after a small direction threshold, hands recent velocity into the
 * open/closed decision, and stays interruptible while settling.
 * `touch-action: pan-y` leaves list scrolling native until horizontal intent
 * wins; the hook applies that property through {@link RowSwipe.ref}.
 */
export function useRowSwipe({
  actionWidth,
  revealed,
  onReveal,
  onClose,
  onBeginInteraction,
}: RowSwipeOptions): RowSwipe {
  const reducedMotion = usePrefersReducedMotion()
  const [drag] = useState(createPointerDrag)
  const [velocity] = useState(createVelocitySampler)
  // Row translation at touch start (possibly mid-settle), then the live one
  // while dragging, already rubber-band constrained.
  const offsetRef = useRef({ start: 0, current: 0 })
  const suppressClickRef = useRef(false)
  // Resting position: a revealed row sits shifted left of the actions, a closed row at zero.
  const restingOffset = revealed ? -actionWidth : 0

  // A fresh callback every render, so React re-runs it each commit and the
  // resting presentation follows `revealed` without any hook state.
  const ref = (element: HTMLElement | null): void => {
    if (element === null || drag.live) {
      return
    }
    element.style.touchAction = 'pan-y'
    presentSettled(element, restingOffset, reducedMotion)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    // An armed touch has no explicit pointer capture yet. If its release was
    // retargeted outside the row, let the next touch recover instead of
    // permanently rejecting every later swipe.
    if (drag.dragging || !drag.arm(event)) {
      return
    }
    // Let the list close any other revealed row right away.
    onBeginInteraction()
    suppressClickRef.current = false
    // Read the live translation so a new touch grabs a mid-settle row where it visually is.
    const surface = event.currentTarget
    const startOffset = currentTranslateX(surface, restingOffset)
    offsetRef.current = { start: startOffset, current: startOffset }
    // Freeze an in-flight settle at its presentation value. A new touch can
    // redirect the row without waiting for the old transition to finish.
    presentDragging(surface, startOffset)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const step = drag.move(event, (travelX, travelY) => {
      const deltaY = Math.abs(travelY)
      const horizontalDistance = Math.abs(travelX)
      if (deltaY >= DIRECTION_THRESHOLD && deltaY >= horizontalDistance) {
        return 'abort'
      }
      if (horizontalDistance < DIRECTION_THRESHOLD || horizontalDistance <= deltaY) {
        return 'wait'
      }
      // A closed row has nothing to reveal to its left when dragged right.
      return travelX > 0 && offsetRef.current.start >= 0 ? 'abort' : 'start'
    })
    if (step === undefined) {
      return
    }
    if (step === 'aborted') {
      presentSettled(event.currentTarget, restingOffset, reducedMotion)
      return
    }
    const nextOffset = constrainOffset(
      offsetRef.current.start + event.clientX - drag.startX,
      actionWidth,
    )
    offsetRef.current.current = nextOffset
    if (step === 'started') {
      // The eventual synthetic click belongs to this drag, not to the note.
      suppressClickRef.current = true
      velocity.reset(nextOffset)
      presentDragging(event.currentTarget, nextOffset)
      return
    }
    velocity.sample(nextOffset)
    event.currentTarget.style.transform = `translate3d(${nextOffset}px, 0, 0)`
  }

  const release = (event: ReactPointerEvent<HTMLElement>, interrupted: boolean): void => {
    const ended = drag.end(event)
    if (ended === undefined) {
      return
    }
    if (ended === 'tap') {
      // An armed release is a tap; the click goes through untouched.
      presentSettled(event.currentTarget, restingOffset, reducedMotion)
      return
    }
    let targetOffset = restingOffset
    if (!interrupted) {
      const releaseVelocity = velocity.stale ? 0 : velocity.velocity
      const projectedOffset = offsetRef.current.current + releaseVelocity * PROJECTED_MOMENTUM_MS
      if (projectedOffset < -actionWidth / 2) {
        targetOffset = -actionWidth
        onReveal()
      } else {
        targetOffset = 0
        onClose()
      }
    }
    presentSettled(event.currentTarget, targetOffset, reducedMotion)
  }

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event) => release(event, false),
      onPointerCancel: (event) => release(event, true),
    },
    ref,
    consumeDragClick: () => {
      if (!suppressClickRef.current) {
        return false
      }
      suppressClickRef.current = false
      return true
    },
  }
}

/** Presentation while settling or at rest: transition on (unless reduced motion), layer hint off. */
function presentSettled(element: HTMLElement, offset: number, reducedMotion: boolean): void {
  element.style.willChange = ''
  element.style.transition = reducedMotion ? 'none' : `transform ${SETTLE_MS}ms ${SETTLE_EASING}`
  element.style.transform = `translate3d(${offset}px, 0, 0)`
}

/** Presentation while a touch owns the row: no transition so it tracks 1:1, layer hint on. */
function presentDragging(element: HTMLElement, offset: number): void {
  element.style.willChange = 'transform'
  element.style.transition = 'none'
  element.style.transform = `translate3d(${offset}px, 0, 0)`
}

/** The row's live compositor translation, used to interrupt a settle cleanly. */
function currentTranslateX(element: HTMLElement, fallback: number): number {
  const transform = getComputedStyle(element).transform
  if (transform === 'none') {
    return fallback
  }
  try {
    // DOMMatrixReadOnly parses the computed matrix string; m41 is its horizontal translation.
    return new DOMMatrixReadOnly(transform).m41
  } catch {
    return fallback
  }
}

/** Soft resistance past either resting boundary, without enabling full-swipe delete. */
function constrainOffset(offset: number, actionWidth: number): number {
  if (offset > 0) {
    return rubberBand(offset, actionWidth)
  }
  if (offset < -actionWidth) {
    // Keep the in-bounds range 1:1 and damp only the part past the open position.
    return -actionWidth - rubberBand(-actionWidth - offset, actionWidth)
  }
  return offset
}

// The classic iOS rubber-band curve: growth starts near overshoot * constant and
// asymptotically approaches `dimension`, so the row never travels a full extra width.
function rubberBand(overshoot: number, dimension: number): number {
  const constant = 0.35
  return (overshoot * dimension * constant) / (dimension + constant * overshoot)
}
