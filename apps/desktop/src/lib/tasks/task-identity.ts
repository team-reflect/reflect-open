import type { OpenTask } from '@reflect/core'

/** The fields that identify a task: its note and the marker's offset in that note. */
type TaskIdentity = Pick<OpenTask, 'notePath' | 'markerOffset'>

/**
 * A task's stable key — its note path and the marker's offset within that file.
 * The Tasks view's React keys and its optimistic-update predicate ({@link
 * sameTask}) derive from the same definition, so a row's key can't drift from
 * the row the completion mutation removes.
 */
export function taskKey(task: TaskIdentity): string {
  return `${task.notePath}:${task.markerOffset}`
}

/** Whether two task references point at the same checkbox. */
export function sameTask(a: TaskIdentity, b: TaskIdentity): boolean {
  return a.notePath === b.notePath && a.markerOffset === b.markerOffset
}
