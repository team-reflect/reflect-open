import { useSyncExternalStore } from 'react'

/**
 * App-global background operations (foundations hardening, post-Plan-07).
 * Work that outlives its UI — a rename's graph-wide link rewrite finishing
 * after the pane closed — needs a home that isn't pane state; this store is
 * it, and {@link OperationsStatus} mirrors it into the global toaster. Operations are *product
 * status*, not spinners: short-lived entries with a label, optional progress,
 * and a lingering failure state so errors from backgrounded work aren't lost.
 */

export interface Operation {
  id: number
  label: string
  description: string | null
  progress: { done: number; total: number } | null
  status: 'running' | 'warning' | 'failed'
  persistent: boolean
  action: OperationAction | null
  /** The lingering line under the label when the operation needs attention. */
  message: string | null
}

export interface OperationAction {
  label: string
  run: () => void | Promise<void>
}

export interface OperationOptions {
  description?: string | undefined
  persistent?: boolean | undefined
  action?: OperationAction | undefined
}

export interface OperationHandle {
  progress: (done: number, total: number) => void
  /** The operation completed; its entry disappears. */
  done: () => void
  /** The operation completed with caveats; its warning lingers briefly. */
  warn: (message: string) => void
  /** The operation failed; the entry lingers briefly so the error is seen. */
  fail: (message: string) => void
  /** Remove the operation immediately. */
  dismiss: () => void
}

const LINGER_MS = 8000
/**
 * Once shown, an entry stays visible at least this long — a fast operation
 * (a one-source rename) otherwise flashes for a frame and reads as a glitch.
 */
const MIN_VISIBLE_MS = 1200

let nextId = 1
let operations: Operation[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function patch(id: number, change: Partial<Operation>): void {
  let changed = false
  operations = operations.map((operation) => {
    if (operation.id !== id) {
      return operation
    }
    changed = true
    return { ...operation, ...change }
  })
  if (changed) {
    emit()
  }
}

function remove(id: number): void {
  const before = operations.length
  operations = operations.filter((operation) => operation.id !== id)
  if (operations.length !== before) {
    emit()
  }
}

/** Begin a visible background operation. */
export function startOperation(label: string, options: OperationOptions = {}): OperationHandle {
  const id = nextId++
  const shownAt = Date.now()
  const persistent = options.persistent ?? false
  operations = [
    ...operations,
    {
      id,
      label,
      description: options.description ?? null,
      progress: null,
      status: 'running',
      persistent,
      action: options.action ?? null,
      message: null,
    },
  ]
  emit()
  const removeAfterMinimum = (extra: number): void => {
    if (persistent && extra > 0) {
      return
    }
    const visibleFor = Date.now() - shownAt
    const wait = Math.max(0, MIN_VISIBLE_MS - visibleFor) + extra
    if (wait === 0) {
      remove(id)
    } else {
      setTimeout(() => remove(id), wait)
    }
  }
  return {
    progress: (done, total) => patch(id, { progress: { done, total } }),
    done: () => removeAfterMinimum(0),
    warn: (message) => {
      patch(id, { status: 'warning', message })
      removeAfterMinimum(LINGER_MS)
    },
    fail: (message) => {
      patch(id, { status: 'failed', message })
      removeAfterMinimum(LINGER_MS)
    },
    dismiss: () => remove(id),
  }
}

/** Remove an operation by id, usually after the user dismisses its toast. */
export function dismissOperation(id: number): void {
  remove(id)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current operations, newest last. Re-renders on every store change. */
export function useOperations(): Operation[] {
  return useSyncExternalStore(subscribe, () => operations)
}

/** Test seam: drop all operations without notifying timers. */
export function resetOperations(): void {
  nextId = 1
  operations = []
  emit()
}
