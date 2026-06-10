import { useSyncExternalStore } from 'react'

/**
 * App-global background operations (foundations hardening, post-Plan-07).
 * Work that outlives its UI — a rename's graph-wide link rewrite finishing
 * after the pane closed — needs a home that isn't pane state; this store is
 * it, and {@link OperationsStatus} renders it. Operations are *product
 * status*, not spinners: short-lived entries with a label, optional progress,
 * and a lingering failure state so errors from backgrounded work aren't lost.
 */

export interface Operation {
  id: number
  label: string
  progress: { done: number; total: number } | null
  status: 'running' | 'failed'
  error: string | null
}

export interface OperationHandle {
  progress: (done: number, total: number) => void
  /** The operation completed; its entry disappears. */
  done: () => void
  /** The operation failed; the entry lingers briefly so the error is seen. */
  fail: (message: string) => void
}

const FAILED_LINGER_MS = 8000

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
export function startOperation(label: string): OperationHandle {
  const id = nextId++
  operations = [...operations, { id, label, progress: null, status: 'running', error: null }]
  emit()
  return {
    progress: (done, total) => patch(id, { progress: { done, total } }),
    done: () => remove(id),
    fail: (message) => {
      patch(id, { status: 'failed', error: message })
      setTimeout(() => remove(id), FAILED_LINGER_MS)
    },
  }
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
  operations = []
  emit()
}
