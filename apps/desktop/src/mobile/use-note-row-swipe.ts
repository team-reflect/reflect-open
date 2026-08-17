import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion'

/** Finger travel (px) before the gesture commits to horizontal swipe or vertical scroll. */
const DIRECTION_THRESHOLD = 10
/** Minimum spacing between velocity samples; the window smooths per-event jitter. */
const VELOCITY_WINDOW_MS = 30
/** A release this long after the last sample means the finger stalled, so momentum is discarded. */
const VELOCITY_STALE_MS = 120
/** How far ahead the release velocity is projected when choosing open vs closed. */
const PROJECTED_MOMENTUM_MS = 100
/** Duration of the settle transition that carries the row to its resting position. */
const SETTLE_MS = 240
/** iOS-feel settle curve: fast start, long decelerating tail. */
const SETTLE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

/** Fields shared by both gesture phases. */
interface GestureBase {
  /** Pointer that owns this gesture; events from any other pointer are ignored. */
  pointerId: number
  /** Screen X where the touch started. */
  startX: number
  /** Screen Y where the touch started. */
  startY: number
  /** Row translation at touch start (possibly mid-settle). */
  startOffset: number
}

/** Touch is down but the direction (swipe vs scroll) is still undecided. */
interface ArmedGesture extends GestureBase {
  phase: 'armed'
}

/** Horizontal intent won; the row tracks the finger 1:1. */
interface DraggingGesture extends GestureBase {
  phase: 'dragging'
  /** Current row translation, already rubber-band constrained. */
  offset: number
  /** Latest sampled velocity in px/ms; negative when moving left. */
  velocity: number
  /** Row translation at the last velocity sample. */
  sampleOffset: number
  /** `performance.now()` timestamp of the last velocity sample. */
  sampleTime: number
}

type RowGesture = ArmedGesture | DraggingGesture

interface NoteRowSwipeOptions {
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

interface NoteRowSwipeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void
}

export interface NoteRowSwipe {
  handlers: NoteRowSwipeHandlers
  /**
   * Attach to the moving note surface. The hook writes its presentation
   * (`touch-action`, `transform`, `transition`, `will-change`) imperatively,
   * so pointer moves never re-render React. While a drag owns the row the
   * element carries a `data-dragging` attribute, letting CSS scope pressed
   * styles (like the `:active` dim) to plain taps.
   */
  ref: (element: HTMLButtonElement | null) => void
  /**
   * Consume the synthetic click that WebKit emits after a completed drag.
   * Call it first inside the row's click handler: it returns true exactly once
   * for the click manufactured by a just-finished drag (ignore that click),
   * and false for a real tap that should activate the row.
   */
  consumeDragClick: () => boolean
}

/**
 * The iOS-style swipe-action gesture for a note row. Touch follows the finger
 * 1:1 after a small direction threshold, hands recent velocity into the
 * open/closed decision, and stays interruptible while settling.
 * `touch-action: pan-y` leaves list scrolling native until horizontal intent
 * wins; the hook applies that property through {@link NoteRowSwipe.ref}.
 */
export function useNoteRowSwipe({
  actionWidth,
  revealed,
  onReveal,
  onClose,
  onBeginInteraction,
}: NoteRowSwipeOptions): NoteRowSwipe {
  const reducedMotion = usePrefersReducedMotion()
  const gestureRef = useRef<RowGesture | null>(null)
  const suppressClickRef = useRef(false)
  // Resting position: a revealed row sits shifted left of the actions, a closed row at zero.
  const restingOffset = revealed ? -actionWidth : 0

  // A fresh callback every render, so React re-runs it each commit and the
  // resting presentation follows `revealed` without any hook state.
  const ref = (element: HTMLButtonElement | null): void => {
    if (element === null || gestureRef.current !== null) {
      return
    }
    element.style.touchAction = 'pan-y'
    presentSettled(element, restingOffset, reducedMotion)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType !== 'touch' || !event.isPrimary) {
      return
    }
    const currentGesture = gestureRef.current
    if (currentGesture?.phase === 'dragging') {
      return
    }
    // An armed touch has no explicit pointer capture yet. If its release was
    // retargeted outside the row, let the next touch recover instead of
    // permanently rejecting every later swipe.
    gestureRef.current = null
    // Let the list close any other revealed row right away.
    onBeginInteraction()
    suppressClickRef.current = false
    // Read the live translation so a new touch grabs a mid-settle row where it visually is.
    const surface = event.currentTarget
    const startOffset = currentTranslateX(surface, restingOffset)
    gestureRef.current = {
      phase: 'armed',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset,
    }
    // Freeze an in-flight settle at its presentation value. A new touch can
    // redirect the row without waiting for the old transition to finish.
    presentDragging(surface, startOffset)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return
    }
    const deltaX = event.clientX - gesture.startX
    const deltaY = Math.abs(event.clientY - gesture.startY)
    const horizontalDistance = Math.abs(deltaX)

    if (gesture.phase === 'armed') {
      if (deltaY >= DIRECTION_THRESHOLD && deltaY >= horizontalDistance) {
        gestureRef.current = null
        presentSettled(event.currentTarget, restingOffset, reducedMotion)
        return
      }
      if (horizontalDistance < DIRECTION_THRESHOLD || horizontalDistance <= deltaY) {
        return
      }
      // A closed row has nothing to reveal to its left when dragged right.
      if (deltaX > 0 && gesture.startOffset >= 0) {
        gestureRef.current = null
        presentSettled(event.currentTarget, restingOffset, reducedMotion)
        return
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic test events have no live pointer to capture.
      }
      // The eventual synthetic click belongs to this drag, not to the note.
      suppressClickRef.current = true
      // Tell CSS a drag owns the row; the surface scopes its pressed dim to
      // taps with a `not-data-dragging` variant.
      event.currentTarget.dataset.dragging = ''
      const nextOffset = constrainOffset(gesture.startOffset + deltaX, actionWidth)
      const now = performance.now()
      gestureRef.current = {
        ...gesture,
        phase: 'dragging',
        offset: nextOffset,
        velocity: 0,
        sampleOffset: nextOffset,
        sampleTime: now,
      }
      presentDragging(event.currentTarget, nextOffset)
      return
    }

    const nextOffset = constrainOffset(gesture.startOffset + deltaX, actionWidth)
    const now = performance.now()
    const elapsed = now - gesture.sampleTime
    const nextGesture: DraggingGesture =
      elapsed >= VELOCITY_WINDOW_MS
        ? {
            ...gesture,
            offset: nextOffset,
            velocity: (nextOffset - gesture.sampleOffset) / elapsed,
            sampleOffset: nextOffset,
            sampleTime: now,
          }
        : { ...gesture, offset: nextOffset }
    gestureRef.current = nextGesture
    event.currentTarget.style.transform = `translate3d(${nextOffset}px, 0, 0)`
  }

  const release = (event: ReactPointerEvent<HTMLButtonElement>, interrupted: boolean): void => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return
    }
    gestureRef.current = null
    if (gesture.phase === 'armed') {
      // An armed release is a tap; the click goes through untouched.
      presentSettled(event.currentTarget, restingOffset, reducedMotion)
      return
    }
    let targetOffset = restingOffset
    if (!interrupted) {
      const velocity =
        performance.now() - gesture.sampleTime <= VELOCITY_STALE_MS ? gesture.velocity : 0
      const projectedOffset = gesture.offset + velocity * PROJECTED_MOMENTUM_MS
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
  delete element.dataset.dragging
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
