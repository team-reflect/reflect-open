import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefCallback,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import { clamp } from '@ocavue/utils'
import { PointerDrag, VelocitySampler, VELOCITY_STALE_MS } from '@/lib/pointer-drag.ts'

const DRAG_ACTIVATE_PX = 8
const DISMISS_FRACTION = 0.18
const DISMISS_VELOCITY_PX_PER_MS = 0.45
const MIN_FLICK_DISTANCE_PX = 40
const SNAP_BACK_MS = 300
const DISMISS_MS = 260
const DISMISS_MIN_MS = 140
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

interface IdleState {
  phase: 'idle'
}

interface SettlingState {
  phase: 'settling'
  action: 'close' | 'cancel'
  deltaX: number
  deltaY: number
  width: number
  height: number
  durationMs: number
}

/**
 * The whole gesture. Only `idle` and `settling` reach React state; the hook
 * writes the `armed` and `dragging` presentation to the DOM itself.
 */
type DragState =
  | IdleState
  | { phase: 'armed' }
  | { phase: 'dragging'; originX: number; originY: number; width: number; height: number }
  | SettlingState

type RenderedState = IdleState | SettlingState

const IDLE: IdleState = { phase: 'idle' }

/**
 * The elements a drag moves and fades.
 */
interface DragTargets {
  image: HTMLElement | null
  backdrop: HTMLElement | null
  chrome: ReadonlySet<HTMLElement>
}

/**
 * Styles, refs, and handlers driving the mobile drag-to-dismiss gesture.
 */
export interface ImageDismissDrag {
  /**
   * Settle transition of the dragged image, or undefined outside a settle.
   */
  imageStyle: CSSProperties | undefined
  /**
   * Settle fade of the lightbox backdrop, or undefined outside a settle.
   */
  backdropStyle: CSSProperties | undefined
  /**
   * Settle fade of the corner chrome (close/open buttons), or undefined outside a settle.
   */
  chromeStyle: CSSProperties | undefined
  /**
   * The dragged image. Pointer moves write its `transform` directly, without a React render.
   */
  imageRef: RefObject<HTMLImageElement | null>
  /**
   * The lightbox backdrop. Pointer moves write its `opacity` directly.
   */
  backdropRef: RefObject<HTMLDivElement | null>
  /**
   * Attach to every corner chrome wrapper. Pointer moves write its `opacity` directly.
   */
  chromeRef: RefCallback<HTMLDivElement>
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
  }
  /**
   * Completes a settle animation; wire to the image's `onTransitionEnd`.
   */
  finishSettle: () => void
}

function dragDistance(deltaX: number, deltaY: number): number {
  return Math.hypot(deltaX, deltaY)
}

function dragProgress(deltaX: number, deltaY: number, height: number): number {
  return clamp(dragDistance(deltaX, deltaY) / Math.max(height * PROGRESS_TRAVEL_FRACTION, 1), 0, 1)
}

/**
 * Continue the drag vector so the image exits along the finger's line.
 */
function projectDismissOffset(
  deltaX: number,
  deltaY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const absX = Math.abs(deltaX)
  const absY = Math.abs(deltaY)
  if (absX === 0 && absY === 0) {
    return { x: 0, y: height }
  }
  const factor = absX >= absY ? width / Math.max(absX, 1) : height / Math.max(absY, 1)
  return {
    x: deltaX * factor,
    y: deltaY * factor,
  }
}

function dismissDurationMs(distance: number, height: number, velocity: number): number {
  const remaining = Math.max(0, height - distance)
  const floorVelocity = remaining / DISMISS_MS
  return clamp(remaining / Math.max(velocity, floorVelocity), DISMISS_MIN_MS, DISMISS_MS)
}

function imageStyleForState(state: RenderedState): CSSProperties | undefined {
  if (state.phase !== 'settling') {
    return undefined
  }
  if (state.action === 'close') {
    const offset = projectDismissOffset(state.deltaX, state.deltaY, state.width, state.height)
    return {
      transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(0.9)`,
      transition: `transform ${state.durationMs}ms ${DISMISS_EASING}`,
      willChange: 'transform',
    }
  }
  return {
    transform: 'translate3d(0, 0, 0) scale(1)',
    transition: `transform ${state.durationMs}ms ${SNAP_BACK_EASING}`,
    willChange: 'transform',
  }
}

function backdropStyleForState(state: RenderedState): CSSProperties | undefined {
  if (state.phase !== 'settling') {
    return undefined
  }
  const closing = state.action === 'close'
  return {
    opacity: closing ? 0 : 1,
    transition: `opacity ${state.durationMs}ms ${closing ? DISMISS_EASING : SNAP_BACK_EASING}`,
  }
}

function chromeStyleForState(state: RenderedState): CSSProperties | undefined {
  if (state.phase !== 'settling') {
    return undefined
  }
  const closing = state.action === 'close'
  return {
    opacity: closing ? 0 : 1,
    pointerEvents: 'none',
    transition: `opacity ${state.durationMs}ms ${closing ? DISMISS_EASING : SNAP_BACK_EASING}`,
  }
}

/**
 * Freeze transitions and hint the layer for a drag. Every settling style sets
 * each property written here and in {@link presentDragOffset}, so the settle
 * commit replaces all of them.
 */
function presentDragStart({ image, backdrop, chrome }: DragTargets): void {
  if (image) {
    image.style.transition = 'none'
    image.style.willChange = 'transform'
  }
  if (backdrop) {
    backdrop.style.transition = 'none'
  }
  for (const element of chrome) {
    element.style.transition = 'none'
    element.style.pointerEvents = 'none'
  }
}

/**
 * Move the image with the finger and fade the backdrop and chrome with distance.
 */
function presentDragOffset(
  { image, backdrop, chrome }: DragTargets,
  deltaX: number,
  deltaY: number,
  height: number,
): void {
  const progress = dragProgress(deltaX, deltaY, height)
  if (image) {
    image.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${1 - progress * DRAG_SHRINK})`
  }
  if (backdrop) {
    backdrop.style.opacity = String(1 - progress * BACKDROP_FADE)
  }
  const chromeOpacity = String(clamp(1 - progress * CHROME_FADE_RATE, 0, 1))
  for (const element of chrome) {
    element.style.opacity = chromeOpacity
  }
}

/**
 * Remove every inline style a drag wrote.
 */
function clearDragPresentation({ image, backdrop, chrome }: DragTargets): void {
  if (image) {
    image.style.transform = ''
    image.style.transition = ''
    image.style.willChange = ''
  }
  if (backdrop) {
    backdrop.style.opacity = ''
    backdrop.style.transition = ''
  }
  for (const element of chrome) {
    element.style.opacity = ''
    element.style.pointerEvents = ''
    element.style.transition = ''
  }
}

/**
 * Touch drag-to-dismiss for the mobile image lightbox. A touch drag detaches
 * the image so it follows the finger in any direction while the backdrop and
 * chrome fade with distance. The drag writes these styles to the DOM directly,
 * so pointer moves never re-render React. Releasing past a distance threshold,
 * or flicking, slides the image out along the drag vector at a velocity-matched
 * speed and then calls `onClose`; shorter drags spring back. A plain tap still
 * closes via `onClick`.
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
  const [state, setState] = useState<RenderedState>(IDLE)
  const [drag] = useState(() => new PointerDrag())
  const [velocity] = useState(() => new VelocitySampler())
  const suppressClickUntilRef = useRef(0)
  const imageRef = useRef<HTMLImageElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const chromeElementsRef = useRef(new Set<HTMLElement>())

  const commit = useCallback((next: RenderedState): void => {
    stateRef.current = next
    setState(next)
  }, [])

  const getDragTargets = useCallback(
    (): DragTargets => ({
      image: imageRef.current,
      backdrop: backdropRef.current,
      chrome: chromeElementsRef.current,
    }),
    [],
  )

  const chromeRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      return
    }
    const elements = chromeElementsRef.current
    elements.add(element)
    return () => {
      elements.delete(element)
    }
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
      // The drag's inline styles must be gone before `onClose` starts the
      // view transition, or the transition snapshots the dragged image.
      // eslint-disable-next-line @eslint-react/dom-no-flush-sync
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
    const current = stateRef.current
    if ((!active || !enabled) && current.phase !== 'idle') {
      if (current.phase === 'dragging') {
        clearDragPresentation(getDragTargets())
      }
      suppressClickUntilRef.current = 0
      commit(IDLE)
    }
  }, [active, enabled, commit, getDragTargets])

  useEffect(() => {
    if (state.phase !== 'settling') {
      return
    }
    const timer = window.setTimeout(finishSettle, state.durationMs + SETTLE_SLACK_MS)
    return () => window.clearTimeout(timer)
  }, [state, finishSettle])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (!enabled || stateRef.current.phase !== 'idle' || !drag.arm(event)) {
        return
      }
      stateRef.current = { phase: 'armed' }
    },
    [enabled, drag],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      const current = stateRef.current
      if (current.phase !== 'armed' && current.phase !== 'dragging') {
        return
      }
      const step = drag.move(event, (travelX, travelY) => {
        return dragDistance(travelX, travelY) < DRAG_ACTIVATE_PX ? 'wait' : 'start'
      })

      if (step === 'started') {
        const rect = event.currentTarget.getBoundingClientRect()
        const width = rect.width || window.innerWidth
        const height = rect.height || window.innerHeight
        velocity.reset(0)
        // Rebase on the activation point so the image picks up from rest
        // instead of jumping by the activation distance.
        stateRef.current = {
          phase: 'dragging',
          originX: event.clientX,
          originY: event.clientY,
          width,
          height,
        }
        const targets = getDragTargets()
        presentDragStart(targets)
        presentDragOffset(targets, 0, 0, height)
        return
      }

      if (step === 'moved' && current.phase === 'dragging') {
        const deltaX = event.clientX - current.originX
        const deltaY = event.clientY - current.originY
        velocity.sample(dragDistance(deltaX, deltaY))
        presentDragOffset(getDragTargets(), deltaX, deltaY, current.height)
      }
    },
    [drag, velocity, getDragTargets],
  )

  const release = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, interrupted: boolean): void => {
      const current = stateRef.current
      if (
        (current.phase !== 'armed' && current.phase !== 'dragging') ||
        drag.end(event) === undefined
      ) {
        return
      }
      if (current.phase === 'armed') {
        stateRef.current = IDLE
        return
      }

      const releaseDeltaX = event.clientX - current.originX
      const releaseDeltaY = event.clientY - current.originY
      const releaseDistance = dragDistance(releaseDeltaX, releaseDeltaY)
      const elapsed = velocity.sample(releaseDistance)
      const releaseVelocity = velocity.getVelocity()
      const flicked =
        releaseVelocity > DISMISS_VELOCITY_PX_PER_MS &&
        releaseDistance > MIN_FLICK_DISTANCE_PX &&
        elapsed <= VELOCITY_STALE_MS
      const shouldClose =
        !interrupted && (releaseDistance > current.height * DISMISS_FRACTION || flicked)
      suppressUpcomingClick()

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        clearDragPresentation(getDragTargets())
        stateRef.current = IDLE
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
        width: current.width,
        height: current.height,
        durationMs: shouldClose
          ? dismissDurationMs(releaseDistance, current.height, releaseVelocity)
          : SNAP_BACK_MS,
      })
    },
    [commit, onClose, suppressUpcomingClick, drag, velocity, getDragTargets],
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
    imageStyle: imageStyleForState(state),
    backdropStyle: backdropStyleForState(state),
    chromeStyle: chromeStyleForState(state),
    imageRef,
    backdropRef,
    chromeRef,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick },
    finishSettle,
  }
}
