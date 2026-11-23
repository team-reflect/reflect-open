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

function hasSameMarkdown(left: TaskShape, right: TaskShape): boolean {
  return left.markdown === right.markdown
}

/**
 * The task id of each task of `next`, in order. With `moves`, the moves of the
 * edit that turned the text of `previous` into the text of `next`, a task
 * keeps the id of the task it was before the edit. Without them, a task keeps
 * the id of the previous task with its path and content, else of the previous
 * task with its content when that content names one task on each side, else
 * of the previous task with its Markdown when that Markdown names one task
 * on each side, else of the previous task at its path that no other task
 * took: a task that changed in place. Every other task takes an id from `createTaskId`.
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
  const ids = [...inPlace]
  for (const isSame of [hasSameTaskContent, hasSameMarkdown]) {
    const open = next.filter((_, i) => ids[i] === undefined)
    for (const [i, task] of next.entries()) {
      if (ids[i] !== undefined) {
        continue
      }
      const candidates = [...unclaimed].filter((candidate) => isSame(candidate, task))
      const rivals = open.filter((other) => isSame(other, task))
      if (candidates.length === 1 && rivals.length === 1) {
        unclaimed.delete(candidates[0]!)
        ids[i] = candidates[0]!.taskId
      }
    }
  }
  return next.map((task, i) => {
    const atPath = [...unclaimed].find((candidate) => {
      return isSameTaskPath(candidate.astPath, task.astPath)
    })
    return ids[i] ?? atPath?.taskId ?? createTaskId()
  })
}
