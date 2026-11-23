import type { OpenTask } from './open-task.ts'

/**
 * The note a new task is added to (Return-to-add, V1): its path plus the context
 * the optimistic row needs to render and bucket before the reindex.
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
