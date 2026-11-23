import {
  encodeTaskPath,
  hasSameTaskContent,
  isSameTaskPath,
  type TaskMove,
  type TaskSnapshot,
} from '../markdown/index.ts'

type TaskShape = Pick<TaskSnapshot, 'astPath' | 'markdown' | 'checked'>

/**
 * A task of the previous snapshot of a note, with the id it holds.
 */
export interface IdentifiedTask extends TaskShape {
  taskId: string
}

/**
 * The task id of each task of `next`, in order. With `moves`, the moves of the
 * edit that turned the text of `previous` into the text of `next`, a task
 * keeps the id of the task it was before the edit. Without them, a task keeps
 * the id of the previous task with its path and content, else of the previous
 * task with its content when that content names one task on each side, else
 * of the previous task at its path that no other task took: a task that
 * changed in place. Every other task takes an id from `createTaskId`.
 */
export function reconcileNoteTasks(
  previous: readonly IdentifiedTask[],
  next: readonly TaskShape[],
  moves: readonly TaskMove[] | null,
  createTaskId: () => string,
): string[] {
  if (moves !== null) {
    const previousIds = new Map(previous.map((task) => [encodeTaskPath(task.astPath), task.taskId]))
    const movedIds = new Map<string, string>()
    for (const { from, to } of moves) {
      const taskId = previousIds.get(encodeTaskPath(from.astPath))
      if (to !== null && taskId !== undefined) {
        movedIds.set(encodeTaskPath(to.astPath), taskId)
      }
    }
    return next.map((task) => movedIds.get(encodeTaskPath(task.astPath)) ?? createTaskId())
  }

  const unclaimed = new Set(previous)
  const inPlace = next.map((task) => {
    const match = previous.find((candidate) => {
      return isSameTaskPath(candidate.astPath, task.astPath) && hasSameTaskContent(candidate, task)
    })
    if (match !== undefined) {
      unclaimed.delete(match)
    }
    return match?.taskId
  })
  const byContent = next.map((task, i) => {
    if (inPlace[i] !== undefined) {
      return inPlace[i]
    }
    const candidates = [...unclaimed].filter((candidate) => hasSameTaskContent(candidate, task))
    const rivals = next.filter(
      (other, j) => inPlace[j] === undefined && hasSameTaskContent(other, task),
    )
    if (candidates.length !== 1 || rivals.length !== 1) {
      return
    }
    unclaimed.delete(candidates[0]!)
    return candidates[0]!.taskId
  })
  return next.map((task, i) => {
    const atPath = [...unclaimed].find((candidate) => {
      return isSameTaskPath(candidate.astPath, task.astPath)
    })
    return byContent[i] ?? atPath?.taskId ?? createTaskId()
  })
}
