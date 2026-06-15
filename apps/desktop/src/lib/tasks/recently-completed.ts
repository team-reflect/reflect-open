import { useCallback, useSyncExternalStore } from 'react'
import { type OpenTask } from '@reflect/core'
import { taskKey } from '@/lib/tasks/task-identity'

/**
 * The "recently completed" set (Plan 18) — V1's middle state where a checked task
 * keeps showing (struck) in the list until you archive it. It's deliberately a
 * **view-only, ephemeral** set, not durable state: a checked task is already
 * `[x]` on disk, and "archived" only means "stop showing it in the active list",
 * which the markdown can't (and shouldn't) encode. So it resets on app restart;
 * it survives navigating away from Tasks and back (a module singleton, above any
 * one screen mount).
 *
 * Tracking the session's completions — rather than every `[x]` task — is what
 * keeps a fresh launch clean: only what you checked *this run* lingers struck;
 * the whole historical pile stays behind the "show archived" filter.
 *
 * Scoped to a graph root: switching graphs (whose task paths differ) yields an
 * empty set rather than the previous graph's rows.
 */

const EMPTY: readonly OpenTask[] = []
let graphRoot: string | null = null
let tasks: readonly OpenTask[] = EMPTY
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Switch the active graph, discarding any other graph's set. */
function adopt(root: string | null): void {
  if (root !== graphRoot) {
    graphRoot = root
    tasks = EMPTY
  }
}

/**
 * Keep `completed` showing struck (checked) in the active list until archived.
 * Stored as a fresh checked copy, deduped by {@link taskKey}.
 */
export function markRecentlyCompleted(root: string | null, completed: readonly OpenTask[]): void {
  if (completed.length === 0) {
    return
  }
  adopt(root)
  const byKey = new Map(tasks.map((task) => [taskKey(task), task]))
  for (const task of completed) {
    byKey.set(taskKey(task), { ...task, checked: true })
  }
  tasks = [...byKey.values()]
  emit()
}

/** Drop these keys — a completion rolled back, or the task was deleted. */
export function forgetRecentlyCompleted(root: string | null, keys: readonly string[]): void {
  if (root !== graphRoot || keys.length === 0) {
    return
  }
  const drop = new Set(keys)
  const next = tasks.filter((task) => !drop.has(taskKey(task)))
  if (next.length !== tasks.length) {
    tasks = next
    emit()
  }
}

/** Archive: stop showing the session's completed tasks (they stay `[x]` on disk). */
export function archiveRecentlyCompleted(root: string | null): void {
  adopt(root)
  if (tasks.length > 0) {
    tasks = EMPTY
    emit()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The session's recently-completed tasks for `root` (empty for any other graph). */
export function useRecentlyCompleted(root: string | null): readonly OpenTask[] {
  const getSnapshot = useCallback(() => (root === graphRoot ? tasks : EMPTY), [root])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Test-only: clear the singleton between cases. */
export function resetRecentlyCompleted(): void {
  graphRoot = null
  tasks = EMPTY
  emit()
}
