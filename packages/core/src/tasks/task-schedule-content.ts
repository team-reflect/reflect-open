import { clearTaskDueDate, setTaskDueDate } from '../markdown/index.ts'

/**
 * The Markdown of a task with its due-date link set to `isoDate`, or removed
 * for `null`. The due date is the first calendar-valid `[[YYYY-MM-DD]]` link.
 */
export function withDraftDueDate(content: string, isoDate: string | null): string {
  return isoDate === null ? clearTaskDueDate(content) : setTaskDueDate(content, isoDate)
}
