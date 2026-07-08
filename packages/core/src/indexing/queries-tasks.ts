import { z } from 'zod'
import type { TaskMarker } from '../markdown'
import { db } from './db'

/**
 * One open task plus the note context the Tasks view (Plan 18) groups and
 * renders by.
 */
export interface OpenTask extends TaskMarker {
  notePath: string
  /** Whether the checkbox is ticked. Open lists are all `false`; archived rows are `true`. */
  checked: boolean
  /** Display text, markdown stripped. */
  text: string
  /** Parent outline/list item text, top-down, displayed above the task row. */
  breadcrumbs: string[]
  noteTitle: string
  /** The task's explicit `[[YYYY-MM-DD]]` due date, or null. */
  dueDate: string | null
  /** ISO date for daily-note tasks; null for tasks in regular notes. */
  dailyDate: string | null
  /** Pin flag mapped to a real boolean at the read boundary. */
  isPinned: boolean
  pinnedOrder: number | null
  updatedAt: number
}

const taskBreadcrumbsSchema = z.array(z.string())

function taskRowsQuery() {
  return db
    .selectFrom('tasks')
    .innerJoin('notes', 'notes.path', 'tasks.notePath')
    .where('notes.kind', '!=', 'template')
    .select([
      'tasks.notePath',
      'tasks.markerOffset',
      'tasks.raw',
      'tasks.text',
      'tasks.breadcrumbs',
      'tasks.checked',
      'tasks.dueDate',
      'notes.title as noteTitle',
      'notes.dailyDate',
      'notes.isPinned',
      'notes.pinnedOrder',
      'notes.updatedAt',
    ])
}

function toTaskRow(row: {
  checked: number
  isPinned: number
  breadcrumbs: string
}): { checked: boolean; isPinned: boolean; breadcrumbs: string[] } {
  const breadcrumbs = taskBreadcrumbsSchema.parse(JSON.parse(row.breadcrumbs))
  return { ...row, checked: row.checked !== 0, isPinned: row.isPinned !== 0, breadcrumbs }
}

/**
 * Every open task across the graph, with note context, for the Tasks view.
 * Private notes' tasks are included because this is a local-only surface.
 */
export async function getOpenTasks(): Promise<OpenTask[]> {
  const rows = await taskRowsQuery()
    .where('tasks.checked', '=', 0)
    .orderBy('tasks.notePath')
    .orderBy('tasks.markerOffset')
    .execute()
  return rows.map((row) => ({ ...row, ...toTaskRow(row) }))
}

/**
 * Completed tasks across the graph, most-recently-edited note first — the
 * Tasks view's "show archived" surface.
 */
export async function getCompletedTasks(): Promise<OpenTask[]> {
  const rows = await taskRowsQuery()
    .where('tasks.checked', '=', 1)
    .orderBy('notes.updatedAt', 'desc')
    .orderBy('tasks.markerOffset')
    .execute()
  return rows.map((row) => ({ ...row, ...toTaskRow(row) }))
}
