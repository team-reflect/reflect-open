import { encodeTaskPath, renderTaskSnapshot, type TaskSnapshot } from '../markdown/index.ts'
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
 * address, the written note's `revision`, and the write's `updatedAt`.
 */
export function createInsertedTaskRow(
  target: InsertTaskTarget,
  created: TaskSnapshot,
  revision: string,
  updatedAt: number,
): OpenTask {
  const { notePath, noteTitle, dailyDate, isPinned, pinnedOrder } = target
  return {
    ...renderTaskSnapshot(created),
    taskId: `${notePath}:${encodeTaskPath(created.astPath)}`,
    notePath,
    revision,
    noteTitle,
    dailyDate,
    isPinned,
    pinnedOrder,
    updatedAt,
  }
}
