import {
  compareTaskPaths,
  decodeTaskPath,
  getTaskDueDate,
  renderInlineText,
  type TaskSnapshot,
} from '../markdown/index.ts'
import { db } from './db.ts'
import { decodeTaskBreadcrumbs } from './indexed-note.ts'

/** A task row's own fields: its snapshot plus what the view derives from the Markdown. */
export interface TaskRow extends TaskSnapshot {
  /** `markdown` rendered to plain text, for search and labels. */
  text: string
  /** The headings above the task, then its ancestor list items' labels, outermost first, rendered to plain text. */
  breadcrumbs: readonly string[]
  /** The task's explicit `[[YYYY-MM-DD]]` due date, or null. */
  dueDate: string | null
}

/**
 * Derive a row's display fields from a task snapshot: the one rendering the
 * index read, an optimistic insert, and a cache relocation all share.
 */
export function renderTaskSnapshot(snapshot: TaskSnapshot): TaskRow {
  return {
    ...snapshot,
    text: renderInlineText(snapshot.markdown),
    breadcrumbs: snapshot.breadcrumbs.map((label) => renderInlineText(label)),
    dueDate: getTaskDueDate(snapshot.markdown),
  }
}

/**
 * One task plus the note context the Tasks view (Plan 18) groups and renders
 * by. `astPath`, `markdown`, and `checked` address the task for writes.
 */
export interface OpenTask extends TaskRow {
  notePath: string
  noteTitle: string
  /** ISO date for daily-note tasks; null for tasks in regular notes. */
  dailyDate: string | null
  /** Pin flag mapped to a real boolean at the read boundary. */
  isPinned: boolean
  pinnedOrder: number | null
  updatedAt: number
}

function taskRowsQuery() {
  return db
    .selectFrom('tasks')
    .innerJoin('notes', 'notes.path', 'tasks.notePath')
    .where('notes.kind', '!=', 'template')
    .select([
      'tasks.notePath',
      'tasks.astPath',
      'tasks.markdown',
      'tasks.breadcrumbs',
      'tasks.checked',
      'notes.title as noteTitle',
      'notes.dailyDate',
      'notes.isPinned',
      'notes.pinnedOrder',
      'notes.updatedAt',
    ])
}

interface TaskRecord {
  notePath: string
  astPath: string
  markdown: string
  breadcrumbs: string
  checked: number
  noteTitle: string
  dailyDate: string | null
  isPinned: number
  pinnedOrder: number | null
  updatedAt: number
}

/**
 * Map stored rows to their domain shape. A row whose address or breadcrumbs
 * do not decode is skipped and reported instead of failing the whole read: the
 * projection is rebuilt from Markdown, so such a row is a bug, not data.
 */
function toTaskRows(rows: readonly TaskRecord[]): OpenTask[] {
  const tasks: OpenTask[] = []
  for (const row of rows) {
    const { astPath, markdown, breadcrumbs, checked, isPinned, ...rest } = row
    try {
      tasks.push({
        ...rest,
        ...renderTaskSnapshot({
          astPath: decodeTaskPath(astPath),
          markdown,
          breadcrumbs: decodeTaskBreadcrumbs(breadcrumbs),
          checked: checked !== 0,
        }),
        isPinned: isPinned !== 0,
      })
    } catch (cause) {
      console.error(`tasks: skipping an unreadable row in ${row.notePath} (${astPath})`, cause)
    }
  }
  return tasks
}

/** Note path first, then the task's place in that note. */
export function compareTasksByNote(left: OpenTask, right: OpenTask): number {
  if (left.notePath !== right.notePath) {
    return left.notePath < right.notePath ? -1 : 1
  }
  return compareTaskPaths(left.astPath, right.astPath)
}

/**
 * Every open task across the graph, with note context, for the Tasks view.
 * Private notes' tasks are included because this is a local-only surface.
 */
export async function getOpenTasks(): Promise<OpenTask[]> {
  const rows = await taskRowsQuery().where('tasks.checked', '=', 0).execute()
  return toTaskRows(rows).sort(compareTasksByNote)
}

/**
 * Completed tasks across the graph, most-recently-edited note first — the
 * Tasks view's "show archived" surface.
 */
export async function getCompletedTasks(): Promise<OpenTask[]> {
  const rows = await taskRowsQuery().where('tasks.checked', '=', 1).execute()
  return toTaskRows(rows).sort(
    (left, right) => right.updatedAt - left.updatedAt || compareTasksByNote(left, right),
  )
}
