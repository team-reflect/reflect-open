import type { MarkdownAstPath } from '@meowdown/markdown'

/** A round task as it stands in a note body. */
export interface TaskSnapshot {
  astPath: MarkdownAstPath
  markdown: string
  checked: boolean
  /** The headings above the task, then its ancestor list items' first paragraphs, outermost first. */
  breadcrumbs: readonly string[]
}

/** The address of a task for a write: its place and content in the note text whose hash is `revision`. */
export interface TaskLocator extends Pick<TaskSnapshot, 'astPath' | 'markdown' | 'checked'> {
  revision: string
}

/** A round task as the projection stores it: its snapshot plus its explicit due date. */
export interface ParsedTask extends TaskSnapshot {
  /**
   * `YYYY-MM-DD`, or null when the task has no due date.
   */
  dueDate: string | null
}
