import type { TaskRow } from '../markdown/index.ts'

/**
 * One task plus the note context the Tasks view (Plan 18) groups and renders
 * by. `astPath`, `markdown`, and `checked` address the task for writes.
 */
export interface OpenTask extends TaskRow {
  /**
   * The id the task holds while the app runs. It is not stored in the note.
   */
  taskId: string
  notePath: string
  /**
   * The hash of the note text the row describes.
   */
  revision: string
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
  /**
   * Epoch milliseconds, for ordering rows only: when the index row of the note
   * last changed, or when the last task write of the note landed.
   */
  updatedAt: number
}
