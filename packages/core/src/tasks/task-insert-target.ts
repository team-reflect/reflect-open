import { renderTaskSnapshot, type TaskSnapshot } from '../markdown/index.ts'
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
 * Build the optimistic open row for a just-written task from its persisted
 * address and the write's `updatedAt`.
 */
export function createInsertedTaskRow(
  target: InsertTaskTarget,
  created: TaskSnapshot,
  updatedAt: number,
): OpenTask {
  const { notePath, noteTitle, dailyDate, isPinned, pinnedOrder } = target
  return {
    ...renderTaskSnapshot(created),
    notePath,
    noteTitle,
    dailyDate,
    isPinned,
    pinnedOrder,
    updatedAt,
  }
}
