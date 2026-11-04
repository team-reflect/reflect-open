import type { ToastService, ToastSpec } from '../app/toast-service.ts'

export interface TestToastService extends ToastService {
  /**
   * The open toasts, oldest first.
   */
  open(): readonly ToastSpec[]
}

class TestToastServiceImpl implements TestToastService {
  readonly #open = new Map<string, ToastSpec>()
  #nextId = 1

  show(spec: ToastSpec): void {
    const id = spec.id ?? `toast-${this.#nextId++}`
    this.#open.set(id, { ...spec, id })
  }

  close(id: string): void {
    const spec = this.#open.get(id)
    if (spec === undefined) {
      return
    }
    this.#open.delete(id)
    spec.onClose?.()
  }

  open(): readonly ToastSpec[] {
    return [...this.#open.values()]
  }
}

/**
 * A {@link ToastService} that keeps the open toasts. Like the real surface,
 * showing an open id replaces that toast, and every close runs `onClose`.
 */
export function createTestToastService(): TestToastService {
  return new TestToastServiceImpl()
}
