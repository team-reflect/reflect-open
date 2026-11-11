/**
 * Minimum spacing between velocity samples; the window smooths per-event jitter.
 */
const VELOCITY_WINDOW_MS = 30
/**
 * A velocity sample older than this means the finger stalled.
 */
export const VELOCITY_STALE_MS = 120

/**
 * The fields of a pointer event that a drag reads.
 */
export interface DragPointerEvent {
  pointerId: number
  pointerType: string
  isPrimary: boolean
  clientX: number
  clientY: number
  currentTarget: Element
}

/**
 * What an armed touch should do, given its travel from the start point.
 */
export type DragIntent = 'wait' | 'start' | 'abort'

/**
 * One primary touch, from touch start until it becomes a drag or ends.
 */
export class PointerDrag {
  #pointerId: number | undefined = undefined
  #dragging = false
  #x = 0
  #y = 0

  /**
   * True from `arm` until the touch ends or aborts.
   */
  isLive(): boolean {
    return this.#pointerId !== undefined
  }

  /**
   * True once an armed touch has started dragging.
   */
  isDragging(): boolean {
    return this.#dragging
  }

  getStartX(): number {
    return this.#x
  }

  getStartY(): number {
    return this.#y
  }

  /**
   * Arm on a primary touch, replacing any live touch. Returns false for other pointers.
   */
  arm(event: DragPointerEvent): boolean {
    if (event.pointerType !== 'touch' || !event.isPrimary) {
      return false
    }
    this.#pointerId = event.pointerId
    this.#dragging = false
    this.#x = event.clientX
    this.#y = event.clientY
    return true
  }

  /**
   * Advance the touch that owns this drag; events from other pointers return
   * undefined. While armed, `intent` decides from the travel whether to keep
   * waiting, start dragging (capturing the pointer), or abort.
   */
  move(
    event: DragPointerEvent,
    intent: (travelX: number, travelY: number) => DragIntent,
  ): 'started' | 'moved' | 'aborted' | undefined {
    if (this.#pointerId !== event.pointerId) {
      return
    }
    if (this.#dragging) {
      return 'moved'
    }
    const decision = intent(event.clientX - this.#x, event.clientY - this.#y)
    if (decision === 'wait') {
      return
    }
    if (decision === 'abort') {
      this.#pointerId = undefined
      return 'aborted'
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic events have no live pointer to capture.
    }
    this.#dragging = true
    return 'started'
  }

  /**
   * End the touch that owns this drag, reporting whether it ever dragged.
   */
  end(event: DragPointerEvent): 'tap' | 'drag' | undefined {
    if (this.#pointerId !== event.pointerId) {
      return
    }
    const result = this.#dragging ? 'drag' : 'tap'
    this.#pointerId = undefined
    this.#dragging = false
    return result
  }
}

/**
 * Velocity (units/ms) of one scalar, sampled over windows instead of per event.
 */
export class VelocitySampler {
  #current = 0
  #sampleValue = 0
  #sampleTime = 0

  getVelocity(): number {
    return this.#current
  }

  /**
   * True when the last sample is old enough that the finger has stalled.
   */
  isStale(): boolean {
    return performance.now() - this.#sampleTime > VELOCITY_STALE_MS
  }

  reset(value: number): void {
    this.#current = 0
    this.#sampleValue = value
    this.#sampleTime = performance.now()
  }

  /**
   * Record `value`, refreshing the velocity once a full window has passed.
   * Returns the age (ms) of the sample this call was measured against.
   */
  sample(value: number): number {
    const now = performance.now()
    const elapsed = now - this.#sampleTime
    if (elapsed >= VELOCITY_WINDOW_MS) {
      this.#current = (value - this.#sampleValue) / elapsed
      this.#sampleValue = value
      this.#sampleTime = now
    }
    return elapsed
  }
}
