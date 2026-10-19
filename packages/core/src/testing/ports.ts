import type {
  Operation,
  OperationHandle,
  OperationOptions,
  ProgressPort,
} from '../ports/progress-port.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * A {@link ProgressPort} that lists its operations without timers: an entry
 * leaves on `done()` or `dismiss()`, and a warning or failure stays.
 */
export interface TestProgressPort extends ProgressPort {
  /**
   * The current operations, newest last.
   */
  getAll(): readonly Operation[]
  dismiss(id: number): void
  subscribe(listener: () => void): Unlisten
  /**
   * The newest current operation with `label`, if any.
   */
  findByLabel(label: string): Operation | undefined
  /**
   * The current operations as plain values without ids or actions.
   */
  snapshot(): ProgressSnapshot[]
  /**
   * Every operation started so far, oldest first, also the ones that left.
   */
  started(): readonly StartedOperation[]
}

export type StartedOperation = Operation & {
  /**
   * Whether the operation left through `done()` or `dismiss()`.
   */
  readonly ended: boolean
}

export type ProgressSnapshot = Omit<Operation, 'id' | 'action'> & {
  action: string | null
}

class TestProgressPortImpl implements TestProgressPort {
  #nextId = 1
  #operations: readonly Operation[] = []
  readonly #started = new Map<number, StartedOperation>()
  readonly #listeners = new Set<() => void>()

  start(label: string, options?: OperationOptions): OperationHandle {
    const id = this.#nextId++
    const operation: Operation = {
      id,
      label,
      description: options?.description ?? null,
      progress: null,
      status: 'running',
      persistent: options?.persistent ?? false,
      action: options?.action ?? null,
      message: null,
    }
    this.#operations = [...this.#operations, operation]
    this.#started.set(id, { ...operation, ended: false })
    this.#emit()
    return {
      progress: (done, total) => this.#patch(id, { progress: { done, total } }),
      done: () => this.dismiss(id),
      warn: (message) => this.#patch(id, { status: 'warning', message }),
      fail: (message) => this.#patch(id, { status: 'failed', message }),
      dismiss: () => this.dismiss(id),
    }
  }

  fail(label: string, message: string, options?: OperationOptions): void {
    this.start(label, options).fail(message)
  }

  getAll(): readonly Operation[] {
    return this.#operations
  }

  dismiss(id: number): void {
    this.#operations = this.#operations.filter((operation) => operation.id !== id)
    const started = this.#started.get(id)
    if (started !== undefined) {
      this.#started.set(id, { ...started, ended: true })
    }
    this.#emit()
  }

  subscribe(listener: () => void): Unlisten {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  findByLabel(label: string): Operation | undefined {
    return this.#operations.findLast((operation) => operation.label === label)
  }

  snapshot(): ProgressSnapshot[] {
    return this.#operations.map(({ id: _id, action, ...rest }) => ({
      ...rest,
      action: action?.label ?? null,
    }))
  }

  started(): readonly StartedOperation[] {
    return [...this.#started.values()]
  }

  #patch(id: number, change: Partial<Operation>): void {
    this.#operations = this.#operations.map((operation) => {
      return operation.id === id ? { ...operation, ...change } : operation
    })
    const started = this.#started.get(id)
    if (started !== undefined) {
      this.#started.set(id, { ...started, ...change })
    }
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createTestProgressPort(): TestProgressPort {
  return new TestProgressPortImpl()
}
