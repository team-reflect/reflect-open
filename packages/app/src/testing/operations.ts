import type { Operation, OperationHandle, OperationOptions, Unlisten } from '@reflect/core'
import { createTestClockService, type TestClockService } from '@reflect/core/testing'
import { createOperationsService, type OperationsService } from '../app/operations-service.ts'

/**
 * The real {@link OperationsService} over a test clock, plus lookup helpers.
 */
export interface TestOperationsService extends OperationsService {
  /**
   * The clock that drives the minimum visible and linger timers.
   */
  readonly clock: TestClockService
  /**
   * The newest current operation with `label`, if any.
   */
  findByLabel(label: string): Operation | undefined
  /**
   * The current operations as plain values without ids or actions.
   */
  snapshot(): OperationSnapshot[]
}

export type OperationSnapshot = Omit<Operation, 'id' | 'action'> & {
  action: string | null
}

/**
 * Forwards every member to the real service and adds lookup helpers.
 */
class TestOperationsServiceImpl implements TestOperationsService {
  readonly #inner: OperationsService

  readonly clock: TestClockService

  constructor(clock: TestClockService) {
    this.clock = clock
    this.#inner = createOperationsService({ clock })
  }

  start(label: string, options?: OperationOptions): OperationHandle {
    return this.#inner.start(label, options)
  }

  fail(label: string, message: string, options?: OperationOptions): void {
    this.#inner.fail(label, message, options)
  }

  dismiss(id: number): void {
    this.#inner.dismiss(id)
  }

  subscribe(listener: () => void): Unlisten {
    return this.#inner.subscribe(listener)
  }

  getAll(): readonly Operation[] {
    return this.#inner.getAll()
  }

  findByLabel(label: string): Operation | undefined {
    return this.#inner.getAll().findLast((operation) => operation.label === label)
  }

  snapshot(): OperationSnapshot[] {
    return this.#inner.getAll().map(({ id: _id, action, ...rest }) => ({
      ...rest,
      action: action?.label ?? null,
    }))
  }
}

export function createTestOperationsService(clock?: TestClockService): TestOperationsService {
  return new TestOperationsServiceImpl(clock ?? createTestClockService())
}
