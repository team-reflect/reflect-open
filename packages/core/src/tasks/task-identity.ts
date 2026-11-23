import type { OpenTask } from './open-task.ts'

type TaskIdentity = Pick<OpenTask, 'taskId'>

/**
 * A task's key for React rows, the selection, and the struck set: its id.
 */
export function getTaskKey(task: TaskIdentity): string {
  return task.taskId
}

/**
 * Whether two rows show the same task.
 */
export function isSameTask(a: TaskIdentity, b: TaskIdentity): boolean {
  return a.taskId === b.taskId
}
