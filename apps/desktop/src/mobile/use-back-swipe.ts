import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'

/** How far from the leading edge a touch may start and still arm the gesture. */
const EDGE_WIDTH_PX = 32
/** Horizontal travel that commits an armed touch to the gesture. */
const ACTIVATE_DX_PX = 8
/** Vertical travel that disarms an edge touch — it's a scroll, not a swipe. */
const DISARM_DY_PX = 16
/** Fraction of the screen width past which a release pops. */
const POP_FRACTION = 0.4
/** A rightward flick (px/ms) pops even short of the distance threshold... */
const POP_VELOCITY_PX_PER_MS = 0.35
/** ...as long as the finger actually travelled somewhere. */
const MIN_FLICK_DX_PX = 24
/**
 * Velocity is sampled over windows of at least this long — instantaneous
 * per-event velocity is far too jittery to gate a pop on.
 */
const VELOCITY_WINDOW_MS = 30
/** A velocity sample older than this at release means the finger stopped. */
const VELOCITY_STALE_MS = 4 * VELOCITY_WINDOW_MS

/** How long a released screen takes to settle on- or off-screen. */
export const BACK_SWIPE_SETTLE_MS = 300

export type BackSwipeState =
  | { phase: 'idle' }
  /** An edge touch that hasn't shown horizontal intent yet — nothing moves. */
  | { phase: 'armed'; pointerId: number; startX: number; startY: number }
  /** The finger owns the screen: `deltaX` is how far it has dragged it. */
  | {
      phase: 'dragging'
      pointerId: number
      startX: number
      width: number
      deltaX: number
      velocity: number
      sampleDeltaX: number
      sampleTime: number
    }
  /** Released — the screen is animating off (`pop`) or back home (`cancel`). */
  | { phase: 'settling'; action: 'pop' | 'cancel'; width: number }

const IDLE: BackSwipeState = { phase: 'idle' }

export interface BackSwipeOptions {
  /** Arm the gesture only on stacked screens with no transition running. */
  enabled: boolean
  /** Skip the settle animation and commit the pop on release. */
  reducedMotion: boolean
  /** Commit the pop once the screen has settled offscreen. */
  onPop: () => void
  /** The stack container — gets a non-passive scroll blocker while dragging. */
  containerRef: RefObject<HTMLElement | null>
}

export interface BackSwipe {
  state: BackSwipeState
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  }
  /** Complete a settle — call from `transitionend` (a timer backstops it). */
  finishSettle: () => void
}

/**
 * The iOS edge back-swipe (Plan 19 shell polish): a touch starting at the
 * leading edge of a stacked screen drags it with the finger and pops it on
 * release — past 40% of the width or on a rightward flick — else it snaps
 * back. Touch-only, and inert until the finger proves horizontal intent, so
 * edge taps (the back button) and vertical scrolling never notice it. The
 * hook owns the pointer state machine; the stack renders `state` into
 * transforms and calls `onPop` through its own transition suppression.
 *
 * The authoritative state lives in a ref and is mirrored into React state
 * for rendering: decisions (and the `onPop` side effect) happen in plain
 * handler code, never inside setState updaters — updaters must stay pure
 * (StrictMode double-invokes them), and the card's and the scrim's settle
 * `transitionend` can land in the same frame, so completion needs a
 * synchronous once-guard.
 */
export function useBackSwipe({
  enabled,
  reducedMotion,
  onPop,
  containerRef,
}: BackSwipeOptions): BackSwipe {
  const stateRef = useRef<BackSwipeState>(IDLE)
  const [state, setState] = useState<BackSwipeState>(IDLE)

  const commit = useCallback((next: BackSwipeState): void => {
    stateRef.current = next
    setState(next)
  }, [])

  // Navigation elsewhere (or a transition starting) invalidates the gesture.
  // Adjusted during render — the derive-state pattern — so a disabled stack
  // never paints a dragged frame. The ref write must be visible to this same
  // render (the router's currentId does the same; see router.tsx).
  if (!enabled && state.phase !== 'idle') {
    // eslint-disable-next-line react-hooks/refs
    stateRef.current = IDLE
    setState(IDLE)
  }

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.pointerType !== 'touch' || !event.isPrimary) {
        return
      }
      if (stateRef.current.phase !== 'idle') {
        return
      }
      const edgeX = event.clientX - event.currentTarget.getBoundingClientRect().left
      if (edgeX > EDGE_WIDTH_PX) {
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
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = stateRef.current
      const { clientX, clientY, pointerId } = event
      if (current.phase === 'armed' && current.pointerId === pointerId) {
        const deltaX = clientX - current.startX
        const deltaY = Math.abs(clientY - current.startY)
        if ((deltaY > DISARM_DY_PX && deltaY >= deltaX) || deltaX < -ACTIVATE_DX_PX) {
          commit(IDLE)
          return
        }
        if (deltaX >= ACTIVATE_DX_PX && deltaX > deltaY) {
          try {
            event.currentTarget.setPointerCapture?.(pointerId)
          } catch {
            // Synthetic events (tests) have no live pointer to capture.
          }
          const width = event.currentTarget.getBoundingClientRect().width || window.innerWidth
          const clamped = Math.max(0, deltaX)
          commit({
            phase: 'dragging',
            pointerId,
            startX: current.startX,
            width,
            deltaX: clamped,
            velocity: 0,
            sampleDeltaX: clamped,
            sampleTime: performance.now(),
          })
        }
        return
      }
      if (current.phase === 'dragging' && current.pointerId === pointerId) {
        const deltaX = Math.max(0, clientX - current.startX)
        const now = performance.now()
        const elapsed = now - current.sampleTime
        if (elapsed < VELOCITY_WINDOW_MS) {
          commit({ ...current, deltaX })
          return
        }
        commit({
          ...current,
          deltaX,
          velocity: (deltaX - current.sampleDeltaX) / elapsed,
          sampleDeltaX: deltaX,
          sampleTime: now,
        })
      }
    },
    [commit],
  )

  const release = useCallback(
    (event: ReactPointerEvent<HTMLElement>, interrupted: boolean) => {
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
      // A flick only counts if the finger was still moving near release —
      // a stale sample means it stopped (holding emits no move events).
      const flicked =
        current.velocity > POP_VELOCITY_PX_PER_MS &&
        current.deltaX > MIN_FLICK_DX_PX &&
        performance.now() - current.sampleTime <= VELOCITY_STALE_MS
      const pops = !interrupted && (current.deltaX > current.width * POP_FRACTION || flicked)
      if (reducedMotion) {
        commit(IDLE)
        if (pops) {
          onPop()
        }
        return
      }
      commit({ phase: 'settling', action: pops ? 'pop' : 'cancel', width: current.width })
    },
    [reducedMotion, onPop, commit],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => release(event, false),
    [release],
  )
  // A cancel means the browser claimed the touch (native scroll won the
  // race) — never pop from one, just put the screen back.
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => release(event, true),
    [release],
  )

  const finishSettle = useCallback(() => {
    const current = stateRef.current
    if (current.phase !== 'settling') {
      return
    }
    // Commit before the side effect: the guard must be synchronous so the
    // second same-frame `transitionend` (card + scrim) sees idle.
    commit(IDLE)
    if (current.action === 'pop') {
      onPop()
    }
  }, [onPop, commit])

  // `transitionend` is the fast path; this backstops a missed event.
  useEffect(() => {
    if (state.phase !== 'settling') {
      return
    }
    const timer = setTimeout(finishSettle, BACK_SWIPE_SETTLE_MS + 80)
    return () => clearTimeout(timer)
  }, [state, finishSettle])

  // React registers touch listeners passively, so blocking the page's own
  // vertical scroll while a drag owns the screen needs a native listener.
  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }
    const blockScroll = (event: TouchEvent): void => {
      if (stateRef.current.phase === 'dragging') {
        event.preventDefault()
      }
    }
    node.addEventListener('touchmove', blockScroll, { passive: false })
    return () => node.removeEventListener('touchmove', blockScroll)
  }, [containerRef])

  return {
    state,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    finishSettle,
  }
}
