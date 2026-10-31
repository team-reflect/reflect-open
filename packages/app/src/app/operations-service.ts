import type {
  ClockService,
  Operation,
  OperationHandle,
  OperationOptions,
  ProgressPort,
  Unlisten,
} from '@reflect/core'

/**
 * The app-wide list of visible background operations.
 */
export interface OperationsService extends ProgressPort {
  /**
   * Removes an operation by id.
   */
  dismiss(id: number): void
  /**
   * Listeners run synchronously inside the mutation that caused them.
   */
  subscribe(listener: () => void): Unlisten
  /**
   * The current operations, newest last. The array changes identity on every change.
   */
  getAll(): readonly Operation[]
}

/**
 * How long a warning or failure lingers after the minimum visible time.
 */
export const LINGER_MS = 8000
/**
 * Once shown, an entry stays visible at least this long, so a fast operation
 * does not flash for a single frame.
 */
export const MIN_VISIBLE_MS = 1200

export interface OperationsServiceDeps {
  readonly clock: ClockService
}

class OperationHandleImpl implements OperationHandle {
  readonly #service: OperationsServiceImpl
  readonly #clock: ClockService
  readonly #id: number
  readonly #shownAt: number
  readonly #persistent: boolean

  constructor(
    service: OperationsServiceImpl,
    clock: ClockService,
    id: number,
    persistent: boolean,
  ) {
    this.#service = service
    this.#clock = clock
    this.#id = id
    this.#shownAt = clock.now()
    this.#persistent = persistent
  }

  progress(done: number, total: number): void {
    this.#service.patch(this.#id, { progress: { done, total } })
  }

  done(): void {
    this.#removeAfterMinimum(0)
  }

  warn(message: string): void {
    this.#service.patch(this.#id, { status: 'warning', message })
    this.#removeAfterMinimum(LINGER_MS)
  }

  fail(message: string): void {
    this.#service.patch(this.#id, { status: 'failed', message })
    this.#removeAfterMinimum(LINGER_MS)
  }

  dismiss(): void {
    this.#service.dismiss(this.#id)
  }

  #removeAfterMinimum(extra: number): void {
    if (this.#persistent && extra > 0) {
      return
    }
    const visibleFor = this.#clock.now() - this.#shownAt
    const wait = Math.max(0, MIN_VISIBLE_MS - visibleFor) + extra
    if (wait === 0) {
      this.#service.dismiss(this.#id)
    } else {
      this.#clock.setTimeout(() => this.#service.dismiss(this.#id), wait)
    }
  }
}

class OperationsServiceImpl implements OperationsService {
  readonly #deps: OperationsServiceDeps
  #nextId = 1
  #operations: readonly Operation[] = []
  readonly #listeners = new Set<() => void>()

  constructor(deps: OperationsServiceDeps) {
    this.#deps = deps
  }

  fail(label: string, message: string, options?: OperationOptions): void {
    this.start(label, options).fail(message)
  }

  start(label: string, options?: OperationOptions): OperationHandle {
    const { clock } = this.#deps
    const id = this.#nextId++
    const persistent = options?.persistent ?? false
    this.#operations = [
      ...this.#operations,
      {
        id,
        label,
        description: options?.description ?? null,
        progress: null,
        status: 'running',
        persistent,
        action: options?.action ?? null,
        message: null,
      },
    ]
    this.#emit()
    return new OperationHandleImpl(this, clock, id, persistent)
  }

  dismiss(id: number): void {
    const before = this.#operations.length
    this.#operations = this.#operations.filter((operation) => operation.id !== id)
    if (this.#operations.length !== before) {
      this.#emit()
    }
  }

  subscribe(listener: () => void): Unlisten {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getAll(): readonly Operation[] {
    return this.#operations
  }

  patch(id: number, change: Partial<Operation>): void {
    let changed = false
    this.#operations = this.#operations.map((operation) => {
      if (operation.id !== id) {
        return operation
      }
      changed = true
      return { ...operation, ...change }
    })
    if (changed) {
      this.#emit()
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createOperationsService(deps: OperationsServiceDeps): OperationsService {
  return new OperationsServiceImpl(deps)
}
