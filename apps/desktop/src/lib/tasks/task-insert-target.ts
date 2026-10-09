import { renderTaskSnapshot, type OpenTask, type TaskSnapshot } from '@reflect/core'

/**
 * The note a new task is added to (Return-to-add, V1): its path plus the context
 * the optimistic row needs to render and bucket before the reindex.
 */
export type InsertTaskTarget = Pick<
  OpenTask,
  'notePath' | 'noteTitle' | 'dailyDate' | 'isPinned' | 'pinnedOrder'
>

/** Build the optimistic open row for a just-written task from its persisted address. */
export function createInsertedTaskRow(target: InsertTaskTarget, created: TaskSnapshot): OpenTask {
  const { notePath, noteTitle, dailyDate, isPinned, pinnedOrder } = target
  return {
    ...renderTaskSnapshot(created),
    notePath,
    noteTitle,
    dailyDate,
    isPinned,
    pinnedOrder,
    updatedAt: Date.now(),
  }
}
