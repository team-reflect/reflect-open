import type { MaybePromise } from '@reflect/utils'
/**
 * A background operation as product status: a label, optional progress, and
 * a lingering warning or failure so errors from backgrounded work are seen.
 */
export interface Operation {
  id: number
  label: string
  description: string | null
  progress: { done: number; total: number } | null
  status: 'running' | 'warning' | 'failed'
  persistent: boolean
  action: OperationAction | null
  /**
   * The lingering line under the label when the operation needs attention.
   */
  message: string | null
}

export interface OperationAction {
  label: string
  run: () => MaybePromise<void>
}

export interface OperationOptions {
  description?: string | undefined
  persistent?: boolean | undefined
  action?: OperationAction | undefined
}

export interface OperationHandle {
  progress(done: number, total: number): void
  /**
   * The operation completed; its entry disappears.
   */
  done(): void
  /**
   * The operation completed with caveats; its warning lingers briefly.
   */
  warn(message: string): void
  /**
   * The operation failed; the entry lingers briefly so the error is seen.
   */
  fail(message: string): void
  /**
   * Remove the operation immediately.
   */
  dismiss(): void
}

/**
 * Where business code reports visible background work.
 */
export interface ProgressPort {
  /**
   * Begins a visible background operation.
   */
  start(label: string, options?: OperationOptions): OperationHandle
  /**
   * Reports a failure at once, without a handle to update later.
   */
  fail(label: string, message: string, options?: OperationOptions): void
}
