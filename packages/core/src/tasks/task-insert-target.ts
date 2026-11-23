import type { OpenTask } from './open-task.ts'

/**
 * The note a new task joins: its path and the note fields a task row carries.
 */
export type InsertTaskTarget = Pick<
  OpenTask,
  'notePath' | 'noteTitle' | 'dailyDate' | 'isPinned' | 'pinnedOrder'
>

/**
 * The note fields of `source`, without the other fields it carries.
 */
export function toInsertTarget(source: InsertTaskTarget): InsertTaskTarget {
  const { notePath, noteTitle, dailyDate, isPinned, pinnedOrder } = source
  return { notePath, noteTitle, dailyDate, isPinned, pinnedOrder }
}
