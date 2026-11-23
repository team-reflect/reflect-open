import {
  encodeTaskPath,
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

function hasSameContent(left: TaskShape, right: TaskShape): boolean {
  return left.checked === right.checked && left.markdown === right.markdown
}

/**
 * The task id of each task of `next`, in order. With `moves`, the moves of the
 * edit that turned the text of `previous` into the text of `next`, a task
 * keeps the id of the task it was before the edit. Without them, a task keeps
 * the id of the previous task with its path and content, else of the previous
 * task with its content when that content names one task on each side. Every
 * other task takes an id from `createTaskId`.
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
      return isSameTaskPath(candidate.astPath, task.astPath) && hasSameContent(candidate, task)
    })
    if (match !== undefined) {
      unclaimed.delete(match)
    }
    return match?.taskId
  })
  return next.map((task, i) => {
    const taskId = inPlace[i]
    if (taskId !== undefined) {
      return taskId
    }
    const candidates = [...unclaimed].filter((candidate) => hasSameContent(candidate, task))
    const rivals = next.filter(
      (other, j) => inPlace[j] === undefined && hasSameContent(other, task),
    )
    return candidates.length === 1 && rivals.length === 1 ? candidates[0]!.taskId : createTaskId()
  })
}
