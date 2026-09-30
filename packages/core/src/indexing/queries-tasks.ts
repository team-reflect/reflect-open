import { decodeTaskPath, inlineMarkdownToDisplayText } from '../markdown/index.ts'
import { indexedTaskKey, type Task } from '../tasks/task-store.ts'
import { db } from './db.ts'
import { decodeTaskBreadcrumbs } from './indexed-note.ts'

async function getTasks(checked: boolean): Promise<Task[]> {
  const rows = await db
    .selectFrom('tasks')
    .innerJoin('notes', 'notes.path', 'tasks.notePath')
    .where('notes.kind', '!=', 'template')
    .where('tasks.checked', '=', checked ? 1 : 0)
    .select([
      'tasks.astPath',
      'tasks.text',
      'tasks.notePath',
      'tasks.breadcrumbs',
      'tasks.dueDate',
      'notes.title as noteTitle',
      'notes.dailyDate',
      'notes.isPinned',
      'notes.pinnedOrder',
      'notes.updatedAt',
    ])
    .execute()
  return rows.map((row) => {
    const astPath = decodeTaskPath(row.astPath)
    return {
      ...row,
      key: indexedTaskKey(row.notePath, astPath),
      astPath,
      checked,
      isPinned: row.isPinned !== 0,
      breadcrumbs: decodeTaskBreadcrumbs(row.breadcrumbs),
      displayText: inlineMarkdownToDisplayText(row.text),
    }
  })
}

/** Open tasks across non-template notes. */
export function getOpenTasks(): Promise<Task[]> {
  return getTasks(false)
}

/** Completed tasks across non-template notes. */
export function getCompletedTasks(): Promise<Task[]> {
  return getTasks(true)
}
