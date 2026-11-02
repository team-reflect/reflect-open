import type {
  Operation,
  OperationHandle,
  OperationOptions,
  ProgressPort,
} from '../ports/progress-port.ts'
import { WritableStore, type Store } from '../store.ts'

/**
 * A {@link ProgressPort} that lists its operations without timers: an entry
 * leaves on `done()` or `dismiss()`, and a warning or failure stays.
 */
export interface TestProgressPort extends ProgressPort, Store<readonly Operation[]> {
  dismiss(id: number): void
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
  readonly #operations = new WritableStore<readonly Operation[]>([])
  readonly #started = new Map<number, StartedOperation>()

  readonly get = this.#operations.get

  readonly subscribe = this.#operations.subscribe

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
    this.#started.set(id, { ...operation, ended: false })
    this.#operations.set([...this.#operations.get(), operation])
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

  dismiss(id: number): void {
    const started = this.#started.get(id)
    if (started !== undefined) {
      this.#started.set(id, { ...started, ended: true })
    }
    this.#operations.set(this.#operations.get().filter((operation) => operation.id !== id))
  }

  findByLabel(label: string): Operation | undefined {
    return this.#operations.get().findLast((operation) => operation.label === label)
  }

  snapshot(): ProgressSnapshot[] {
    return this.#operations.get().map(({ id: _id, action, ...rest }) => ({
      ...rest,
      action: action?.label ?? null,
    }))
  }

  started(): readonly StartedOperation[] {
    return [...this.#started.values()]
  }

  #patch(id: number, change: Partial<Operation>): void {
    const started = this.#started.get(id)
    if (started !== undefined) {
      this.#started.set(id, { ...started, ...change })
    }
    this.#operations.set(
      this.#operations.get().map((operation) => {
        return operation.id === id ? { ...operation, ...change } : operation
      }),
    )
  }
}

export function createTestProgressPort(): TestProgressPort {
  return new TestProgressPortImpl()
}
