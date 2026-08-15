import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion'

const DIRECTION_THRESHOLD = 10
const VELOCITY_WINDOW_MS = 30
const VELOCITY_STALE_MS = 120
const PROJECTED_MOMENTUM_MS = 100
const SETTLE_MS = 240
const SETTLE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

interface GestureBase {
  pointerId: number
  startX: number
  startY: number
  startOffset: number
}

interface ArmedGesture extends GestureBase {
  phase: 'armed'
}

interface DraggingGesture extends GestureBase {
  phase: 'dragging'
  offset: number
  velocity: number
  sampleOffset: number
  sampleTime: number
}

type RowGesture = ArmedGesture | DraggingGesture

interface NoteRowSwipeOptions {
  /** Total width of the actions underneath the row. */
  actionWidth: number
  revealed: boolean
  onReveal: () => void
  onClose: () => void
  /** Lets the list close a different row as soon as this one is touched. */
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
  /** Compositor-only presentation for the moving note surface. */
  style: CSSProperties
  /** Consume the synthetic click that WebKit emits after a completed drag. */
  consumeDragClick: () => boolean
}

/**
 * The iOS-style swipe-action gesture for a note row. Touch follows the finger
 * 1:1 after a small direction threshold, hands recent velocity into the
 * open/closed decision, and stays interruptible while settling.
 * `touch-action: pan-y` leaves list scrolling native until horizontal intent
 * wins; the row surface supplies that property through {@link NoteRowSwipe.style}.
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
  const [dragOffset, setDragOffset] = useState<number | null>(null)
  const restingOffset = revealed ? -actionWidth : 0
  const offset = dragOffset ?? restingOffset

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
    onBeginInteraction()
    suppressClickRef.current = false
    const startOffset = currentTranslateX(event.currentTarget, restingOffset)
    gestureRef.current = {
      phase: 'armed',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset,
    }
    // Freeze an in-flight settle at its presentation value. A new touch can
    // redirect the row without waiting for the old transition to finish.
    setDragOffset(startOffset)
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
        setDragOffset(null)
        return
      }
      if (horizontalDistance < DIRECTION_THRESHOLD || horizontalDistance <= deltaY) {
        return
      }
      // A closed row has nothing to reveal to its left when dragged right.
      if (deltaX > 0 && gesture.startOffset >= 0) {
        gestureRef.current = null
        setDragOffset(null)
        return
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic test events have no live pointer to capture.
      }
      suppressClickRef.current = true
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
      setDragOffset(nextOffset)
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
    setDragOffset(nextOffset)
  }

  const release = (event: ReactPointerEvent<HTMLButtonElement>, interrupted: boolean): void => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return
    }
    gestureRef.current = null
    if (gesture.phase === 'armed') {
      setDragOffset(null)
      return
    }
    if (!interrupted) {
      const velocity =
        performance.now() - gesture.sampleTime <= VELOCITY_STALE_MS ? gesture.velocity : 0
      const projectedOffset = gesture.offset + velocity * PROJECTED_MOMENTUM_MS
      if (projectedOffset < -actionWidth / 2) {
        onReveal()
      } else {
        onClose()
      }
    }
    setDragOffset(null)
  }

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event) => release(event, false),
      onPointerCancel: (event) => release(event, true),
    },
    style: {
      touchAction: 'pan-y',
      transform: `translate3d(${offset}px, 0, 0)`,
      transition:
        dragOffset === null && !reducedMotion
          ? `transform ${SETTLE_MS}ms ${SETTLE_EASING}`
          : 'none',
      willChange: dragOffset === null ? undefined : 'transform',
    },
    consumeDragClick: () => {
      if (!suppressClickRef.current) {
        return false
      }
      suppressClickRef.current = false
      return true
    },
  }
}

/** The row's live compositor translation, used to interrupt a settle cleanly. */
function currentTranslateX(element: HTMLElement, fallback: number): number {
  const transform = getComputedStyle(element).transform
  if (transform === 'none') {
    return fallback
  }
  try {
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
    return -actionWidth - rubberBand(-actionWidth - offset, actionWidth)
  }
  return offset
}

function rubberBand(overshoot: number, dimension: number): number {
  const constant = 0.35
  return (overshoot * dimension * constant) / (dimension + constant * overshoot)
}
