import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { flushSync } from 'react-dom'

const DRAG_ACTIVATE_PX = 8
const DISMISS_FRACTION = 0.18
const DISMISS_VELOCITY_PX_PER_MS = 0.45
const MIN_FLICK_DISTANCE_PX = 40
const VELOCITY_WINDOW_MS = 30
const VELOCITY_STALE_MS = 120
const SNAP_BACK_MS = 300
const DISMISS_FADE_MS = 180
const SETTLE_SLACK_MS = 80
const CLICK_SUPPRESSION_MS = 500
// Full visual effect (backdrop gone, image at min scale) at half the viewport.
const PROGRESS_TRAVEL_FRACTION = 0.5
const BACKDROP_FADE = 0.85
const CHROME_FADE_RATE = 2
const DRAG_SHRINK = 0.08
// Slight overshoot so the snap-back reads as a spring, not a linear return.
const SNAP_BACK_EASING = 'cubic-bezier(0.3, 1.35, 0.45, 1)'
const DISMISS_EASING = 'cubic-bezier(0.3, 0.7, 0.4, 1)'

type DragState =
  | { phase: 'idle' }
  | { phase: 'armed'; pointerId: number; startX: number; startY: number }
  | {
      phase: 'dragging'
      pointerId: number
      originX: number
      originY: number
      height: number
      deltaX: number
      deltaY: number
      velocity: number
      sampleDistance: number
      sampleTime: number
    }
  | {
      phase: 'settling'
      action: 'close' | 'cancel'
      deltaX: number
      deltaY: number
      height: number
      durationMs: number
    }

const IDLE: DragState = { phase: 'idle' }

/** Styles and handlers driving the mobile drag-to-dismiss gesture. */
export interface ImageDismissDrag {
  /** Fade applied to the whole mobile lightbox while a drag-close settles. */
  lightboxStyle: CSSProperties | undefined
  /** Transform applied to the dragged image, or undefined at rest. */
  imageStyle: CSSProperties | undefined
  /** Fade applied to the lightbox backdrop as the drag progresses. */
  backdropStyle: CSSProperties | undefined
  /** Fade applied to the corner chrome (close/open buttons) during a drag. */
  chromeStyle: CSSProperties | undefined
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
  }
  /** Completes a settle animation; wire to transition-end events for settling elements. */
  finishSettle: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function dragDistance(deltaX: number, deltaY: number): number {
  return Math.hypot(deltaX, deltaY)
}

function dragProgress(deltaX: number, deltaY: number, height: number): number {
  return clamp(
    dragDistance(deltaX, deltaY) / Math.max(height * PROGRESS_TRAVEL_FRACTION, 1),
    0,
    1,
  )
}

function imageTransformForDrag(deltaX: number, deltaY: number, height: number): string {
  const progress = dragProgress(deltaX, deltaY, height)
  return `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${1 - progress * DRAG_SHRINK})`
}

function backdropOpacityForDrag(deltaX: number, deltaY: number, height: number): number {
  return 1 - dragProgress(deltaX, deltaY, height) * BACKDROP_FADE
}

function chromeOpacityForDrag(deltaX: number, deltaY: number, height: number): number {
  return clamp(1 - dragProgress(deltaX, deltaY, height) * CHROME_FADE_RATE, 0, 1)
}

function lightboxStyleForState(state: DragState): CSSProperties | undefined {
  if (state.phase === 'settling' && state.action === 'close') {
    return {
      opacity: 0,
      pointerEvents: 'none',
      transition: `opacity ${state.durationMs}ms ${DISMISS_EASING}`,
      willChange: 'opacity',
    }
  }
  return undefined
}

function imageStyleForState(state: DragState): CSSProperties | undefined {
  if (state.phase === 'dragging') {
    return {
      transform: imageTransformForDrag(state.deltaX, state.deltaY, state.height),
      transition: 'none',
      willChange: 'transform',
    }
  }
  if (state.phase === 'settling') {
    const closing = state.action === 'close'
    if (closing) {
      return {
        transform: imageTransformForDrag(state.deltaX, state.deltaY, state.height),
        transition: 'none',
        willChange: 'transform',
      }
    }
    return {
      transform: 'translate3d(0, 0, 0) scale(1)',
      transition: `transform ${state.durationMs}ms ${SNAP_BACK_EASING}`,
      willChange: 'transform',
    }
  }
  return undefined
}

function backdropStyleForState(state: DragState): CSSProperties | undefined {
  if (state.phase === 'dragging') {
    return {
      opacity: backdropOpacityForDrag(state.deltaX, state.deltaY, state.height),
      transition: 'none',
    }
  }
  if (state.phase === 'settling') {
    const closing = state.action === 'close'
    if (closing) {
      return {
        opacity: backdropOpacityForDrag(state.deltaX, state.deltaY, state.height),
        transition: 'none',
      }
    }
    return {
      opacity: 1,
      transition: `opacity ${state.durationMs}ms ${SNAP_BACK_EASING}`,
    }
  }
  return undefined
}

function chromeStyleForState(state: DragState): CSSProperties | undefined {
  if (state.phase === 'dragging') {
    return {
      opacity: chromeOpacityForDrag(state.deltaX, state.deltaY, state.height),
      pointerEvents: 'none',
      transition: 'none',
    }
  }
  if (state.phase === 'settling') {
    const closing = state.action === 'close'
    if (closing) {
      return {
        opacity: chromeOpacityForDrag(state.deltaX, state.deltaY, state.height),
        pointerEvents: 'none',
        transition: 'none',
      }
    }
    return {
      opacity: 1,
      pointerEvents: 'none',
      transition: `opacity ${state.durationMs}ms ${SNAP_BACK_EASING}`,
    }
  }
  return undefined
}

/**
 * Touch drag-to-dismiss for the mobile image lightbox. A touch drag detaches
 * the image so it follows the finger in any direction while the backdrop and
 * chrome fade with distance. Releasing past a distance threshold, or flicking,
 * fades the lightbox out and then calls `onClose`; shorter drags spring back.
 * A plain tap still closes via `onClick`.
 */
export function useImageDismissDrag({
  active,
  enabled,
  onClose,
}: {
  active: boolean
  enabled: boolean
  onClose: () => void
}): ImageDismissDrag {
  const stateRef = useRef<DragState>(IDLE)
  const [state, setState] = useState<DragState>(IDLE)
  const suppressClickUntilRef = useRef(0)

  const commit = useCallback((next: DragState): void => {
    stateRef.current = next
    setState(next)
  }, [])

  const suppressUpcomingClick = useCallback((): void => {
    suppressClickUntilRef.current = performance.now() + CLICK_SUPPRESSION_MS
  }, [])

  const finishSettle = useCallback((): void => {
    const current = stateRef.current
    if (current.phase !== 'settling') {
      return
    }
    if (current.action === 'close') {
      flushSync(() => commit(IDLE))
      onClose()
      return
    }
    commit(IDLE)
    if (current.action === 'cancel') {
      suppressClickUntilRef.current = 0
    }
  }, [commit, onClose])

  useEffect(() => {
    if ((!active || !enabled) && stateRef.current.phase !== 'idle') {
      suppressClickUntilRef.current = 0
      commit(IDLE)
    }
  }, [active, enabled, commit])

  useEffect(() => {
    if (state.phase !== 'settling') {
      return
    }
    const timer = window.setTimeout(finishSettle, state.durationMs + SETTLE_SLACK_MS)
    return () => window.clearTimeout(timer)
  }, [state, finishSettle])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!enabled || event.pointerType !== 'touch' || !event.isPrimary) {
        return
      }
      if (stateRef.current.phase !== 'idle') {
        return
      }
      commit({
        phase: 'armed',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      })
    },
    [enabled, commit],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      const current = stateRef.current
      if (
        (current.phase !== 'armed' && current.phase !== 'dragging') ||
        current.pointerId !== event.pointerId
      ) {
        return
      }

      if (current.phase === 'armed') {
        const travelX = event.clientX - current.startX
        const travelY = event.clientY - current.startY
        if (dragDistance(travelX, travelY) < DRAG_ACTIVATE_PX) {
          return
        }

        try {
          event.currentTarget.setPointerCapture?.(event.pointerId)
        } catch {
          // Synthetic tests do not have a live pointer to capture.
        }

        const height = event.currentTarget.getBoundingClientRect().height || window.innerHeight
        // Rebase on the activation point so the image picks up from rest
        // instead of jumping by the activation distance.
        commit({
          phase: 'dragging',
          pointerId: event.pointerId,
          originX: event.clientX,
          originY: event.clientY,
          height,
          deltaX: 0,
          deltaY: 0,
          velocity: 0,
          sampleDistance: 0,
          sampleTime: performance.now(),
        })
        return
      }

      const deltaX = event.clientX - current.originX
      const deltaY = event.clientY - current.originY
      const distance = dragDistance(deltaX, deltaY)
      const now = performance.now()
      const elapsed = now - current.sampleTime
      if (elapsed < VELOCITY_WINDOW_MS) {
        commit({ ...current, deltaX, deltaY })
        return
      }
      commit({
        ...current,
        deltaX,
        deltaY,
        velocity: (distance - current.sampleDistance) / elapsed,
        sampleDistance: distance,
        sampleTime: now,
      })
    },
    [commit],
  )

  const release = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, interrupted: boolean): void => {
      const current = stateRef.current
      if (
        (current.phase !== 'armed' && current.phase !== 'dragging') ||
        current.pointerId !== event.pointerId
      ) {
        return
      }
      if (current.phase === 'armed') {
        commit(IDLE)
        return
      }

      const releaseDeltaX = event.clientX - current.originX
      const releaseDeltaY = event.clientY - current.originY
      const releaseDistance = dragDistance(releaseDeltaX, releaseDeltaY)
      const now = performance.now()
      const elapsed = now - current.sampleTime
      const releaseVelocity =
        elapsed >= VELOCITY_WINDOW_MS
          ? (releaseDistance - current.sampleDistance) / elapsed
          : current.velocity
      const flicked =
        releaseVelocity > DISMISS_VELOCITY_PX_PER_MS &&
        releaseDistance > MIN_FLICK_DISTANCE_PX &&
        elapsed <= VELOCITY_STALE_MS
      const shouldClose =
        !interrupted && (releaseDistance > current.height * DISMISS_FRACTION || flicked)
      suppressUpcomingClick()

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        commit(IDLE)
        if (shouldClose) {
          onClose()
        }
        return
      }

      commit({
        phase: 'settling',
        action: shouldClose ? 'close' : 'cancel',
        deltaX: releaseDeltaX,
        deltaY: releaseDeltaY,
        height: current.height,
        durationMs: shouldClose ? DISMISS_FADE_MS : SNAP_BACK_MS,
      })
    },
    [commit, onClose, suppressUpcomingClick],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => release(event, false),
    [release],
  )

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => release(event, true),
    [release],
  )

  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>): void => {
      const settling = stateRef.current.phase === 'settling'
      const suppressClick =
        settling ||
        (suppressClickUntilRef.current > 0 && performance.now() <= suppressClickUntilRef.current)
      if (suppressClick) {
        if (!settling) {
          suppressClickUntilRef.current = 0
        }
        event.preventDefault()
        event.stopPropagation()
        return
      }
      onClose()
    },
    [onClose],
  )

  return {
    lightboxStyle: lightboxStyleForState(state),
    imageStyle: imageStyleForState(state),
    backdropStyle: backdropStyleForState(state),
    chromeStyle: chromeStyleForState(state),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick },
    finishSettle,
  }
}
