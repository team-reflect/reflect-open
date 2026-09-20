/** Minimum spacing between velocity samples; the window smooths per-event jitter. */
const VELOCITY_WINDOW_MS = 30
/** A velocity sample older than this means the finger stalled. */
export const VELOCITY_STALE_MS = 120

/** The fields of a pointer event that a drag reads. */
export interface DragPointerEvent {
  pointerId: number
  pointerType: string
  isPrimary: boolean
  clientX: number
  clientY: number
  currentTarget: Element
}

/** What an armed touch should do, given its travel from the start point. */
export type DragIntent = 'wait' | 'start' | 'abort'

/** One primary touch, from touch start until it becomes a drag or ends. */
export interface PointerDrag {
  /** True from `arm` until the touch ends or aborts. */
  readonly live: boolean
  /** True once an armed touch has started dragging. */
  readonly dragging: boolean
  readonly startX: number
  readonly startY: number
  /** Arm on a primary touch, replacing any live touch. Returns false for other pointers. */
  arm: (event: DragPointerEvent) => boolean
  /**
   * Advance the touch that owns this drag; events from other pointers return
   * undefined. While armed, `intent` decides from the travel whether to keep
   * waiting, start dragging (capturing the pointer), or abort.
   */
  move: (
    event: DragPointerEvent,
    intent: (travelX: number, travelY: number) => DragIntent,
  ) => 'started' | 'moved' | 'aborted' | undefined
  /** End the touch that owns this drag, reporting whether it ever dragged. */
  end: (event: DragPointerEvent) => 'tap' | 'drag' | undefined
  cancel: () => void
}

export function createPointerDrag(): PointerDrag {
  let pointerId: number | undefined
  let dragging = false
  let startX = 0
  let startY = 0

  return {
    get live() {
      return pointerId !== undefined
    },
    get dragging() {
      return dragging
    },
    get startX() {
      return startX
    },
    get startY() {
      return startY
    },
    arm(event) {
      if (event.pointerType !== 'touch' || !event.isPrimary) {
        return false
      }
      pointerId = event.pointerId
      dragging = false
      startX = event.clientX
      startY = event.clientY
      return true
    },
    move(event, intent) {
      if (pointerId !== event.pointerId) {
        return
      }
      if (dragging) {
        return 'moved'
      }
      const decision = intent(event.clientX - startX, event.clientY - startY)
      if (decision === 'wait') {
        return
      }
      if (decision === 'abort') {
        pointerId = undefined
        return 'aborted'
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic events have no live pointer to capture.
      }
      dragging = true
      return 'started'
    },
    end(event) {
      if (pointerId !== event.pointerId) {
        return
      }
      const result = dragging ? 'drag' : 'tap'
      pointerId = undefined
      dragging = false
      return result
    },
    cancel() {
      pointerId = undefined
      dragging = false
    },
  }
}

/** Velocity (units/ms) of one scalar, sampled over windows instead of per event. */
export interface VelocitySampler {
  readonly velocity: number
  /** True when the last sample is old enough that the finger has stalled. */
  readonly stale: boolean
  reset: (value: number) => void
  /**
   * Record `value`, refreshing the velocity once a full window has passed.
   * Returns the age (ms) of the sample this call was measured against.
   */
  sample: (value: number) => number
}

export function createVelocitySampler(): VelocitySampler {
  let velocity = 0
  let sampleValue = 0
  let sampleTime = 0

  return {
    get velocity() {
      return velocity
    },
    get stale() {
      return performance.now() - sampleTime > VELOCITY_STALE_MS
    },
    reset(value) {
      velocity = 0
      sampleValue = value
      sampleTime = performance.now()
    },
    sample(value) {
      const now = performance.now()
      const elapsed = now - sampleTime
      if (elapsed >= VELOCITY_WINDOW_MS) {
        velocity = (value - sampleValue) / elapsed
        sampleValue = value
        sampleTime = now
      }
      return elapsed
    },
  }
}
