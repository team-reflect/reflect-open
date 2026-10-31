import { clearTaskDueDate, setTaskDueDate } from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'

/**
 * The task's Markdown after setting or clearing its scheduled date link.
 */
export function getScheduledMarkdown(task: OpenTask, isoDate: string | null): string {
  return isoDate === null ? clearTaskDueDate(task.markdown) : setTaskDueDate(task.markdown, isoDate)
}

/**
 * The mobile quick-edit sheet's draft with its due-date link set to `isoDate`,
 * or removed when null. The sheet holds the task's content as an editable
 * markdown draft, and scheduling edits the draft rather than writing through —
 * so text and date changes land as one write when the sheet commits. The date
 * rule is the projection's (`getTaskDueDate`): the first calendar-valid
 * `[[YYYY-MM-DD]]` link.
 */
export function withDraftDueDate(content: string, isoDate: string | null): string {
  return isoDate === null ? clearTaskDueDate(content) : setTaskDueDate(content, isoDate)
}
