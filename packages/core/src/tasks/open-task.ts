import { compareTaskPaths, type TaskRow } from '../markdown/index.ts'

/**
 * One task plus the note context the Tasks view (Plan 18) groups and renders
 * by. `astPath`, `markdown`, and `checked` address the task for writes.
 */
export interface OpenTask extends TaskRow {
  notePath: string
  noteTitle: string
  /**
   * ISO date for daily-note tasks; null for tasks in regular notes.
   */
  dailyDate: string | null
  /**
   * Pin flag mapped to a real boolean at the read boundary.
   */
  isPinned: boolean
  pinnedOrder: number | null
  updatedAt: number
}

/**
 * Note path first, then the task's place in that note.
 */
export function compareTasksByNote(left: OpenTask, right: OpenTask): number {
  if (left.notePath !== right.notePath) {
    return left.notePath < right.notePath ? -1 : 1
  }
  return compareTaskPaths(left.astPath, right.astPath)
}
