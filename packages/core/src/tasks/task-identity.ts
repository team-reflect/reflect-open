import { encodeTaskPath, isSameTaskPath } from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'

/**
 * The fields that identify a task: its note and its address in that note's AST.
 */
type TaskIdentity = Pick<OpenTask, 'notePath' | 'astPath'>

/**
 * A task's key: its note path and its AST path within that note. The Tasks
 * view's React keys and its optimistic-update predicate ({@link isSameTask})
 * derive from the same definition, so a row's key can't drift from the row the
 * completion mutation removes.
 */
export function getTaskKey(task: TaskIdentity): string {
  return `${task.notePath}:${encodeTaskPath(task.astPath)}`
}

/**
 * Whether two task references point at the same list item.
 */
export function isSameTask(a: TaskIdentity, b: TaskIdentity): boolean {
  return a.notePath === b.notePath && isSameTaskPath(a.astPath, b.astPath)
}
